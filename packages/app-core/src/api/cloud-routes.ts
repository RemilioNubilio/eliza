import type http from "node:http";
import { type AgentRuntime, logger } from "@elizaos/core";
import {
  type CloudRouteState as AutonomousCloudRouteState,
  handleCloudRoute as handleAutonomousCloudRoute,
} from "@elizaos/agent/api/cloud-routes";
import { applyCanonicalOnboardingConfig } from "@elizaos/agent/api/provider-switch-config";
import { normalizeCloudSiteUrl } from "@elizaos/agent/cloud/base-url";
import type { CloudManager } from "@elizaos/agent/cloud/cloud-manager";
import { validateCloudBaseUrl } from "@elizaos/agent/cloud/validate-url";
import type { ElizaConfig } from "@elizaos/agent/config/config";
import { saveElizaConfig } from "@elizaos/agent/config/config";
import {
  isCloudInferenceSelectedInConfig,
  migrateLegacyRuntimeConfig,
} from "@elizaos/shared/contracts/onboarding";
import { createIntegrationTelemetrySpan } from "@elizaos/agent/diagnostics/integration-observability";
import { isTimeoutError } from "../utils/errors";
import {
  disconnectUnifiedCloudConnection,
  type RuntimeCloudLike,
} from "./cloud-connection";
import { clearCloudSecrets, scrubCloudSecretsFromEnv } from "./cloud-secrets";
import { sendJson, sendJsonError } from "./response";
import { applyStewardWalletAddressesToRuntimeCache } from "@elizaos/agent/api/wallet";
import { saveStewardCredentials } from "../services/steward-credentials";

// ── Cloud wallet provisioning on login ─────────────────────────────────────

/** A dummy client address used when provisioning cloud-managed wallets. */
const CLOUD_WALLET_CLIENT_ADDRESS_EVM =
  "0x0000000000000000000000000000000000000001";
const CLOUD_WALLET_CLIENT_ADDRESS_SOLANA =
  "11111111111111111111111111111111";

interface CloudWalletProvisionResult {
  evmAddress: string | null;
  solanaAddress: string | null;
}

/**
 * Persist cloud wallet addresses into config.env so they survive restarts.
 * On next startup, `initStewardWalletCache` will pick them up from
 * `process.env` (hydrated from config.env).
 */
function persistWalletAddressesToConfig(
  config: ElizaConfig,
  wallets: CloudWalletProvisionResult,
): void {
  if (!wallets.evmAddress && !wallets.solanaAddress) return;
  const env = ((config as Record<string, unknown>).env ??
    {}) as Record<string, unknown>;
  if (wallets.evmAddress) {
    env.STEWARD_EVM_ADDRESS = wallets.evmAddress;
  }
  if (wallets.solanaAddress) {
    env.STEWARD_SOLANA_ADDRESS = wallets.solanaAddress;
  }
  (config as Record<string, unknown>).env = env;
  try {
    saveElizaConfig(config);
    logger.info("[cloud-wallet] Wallet addresses persisted to config");
  } catch (err) {
    logger.warn(
      `[cloud-wallet] Failed to persist wallet addresses to config: ${String(err)}`,
    );
  }
}

// ── Steward credential fetching on cloud login ─────────────────────────────

interface CloudStewardCredentials {
  apiUrl: string;
  tenantId: string;
  apiKey: string;
  agentId: string | null;
}

/**
 * Fetch Steward tenant credentials from the cloud and the steward_agent_id
 * from provisioned wallets. Combines two cloud API calls:
 *   GET /api/v1/steward/tenants/credentials  → apiUrl, tenantId, apiKey
 *   GET /api/v1/user/wallets                 → stewardAgentId (from first wallet)
 *
 * Best-effort: returns null if credentials are unavailable (not yet provisioned,
 * endpoint not deployed, etc.).
 */
async function fetchCloudStewardCredentials(
  cloudBaseUrl: string,
  cloudApiKey: string,
): Promise<CloudStewardCredentials | null> {
  const headers = { "X-Api-Key": cloudApiKey };

  // Fetch tenant credentials and wallet list in parallel
  const [credRes, walletsRes] = await Promise.allSettled([
    fetch(`${cloudBaseUrl}/api/v1/steward/tenants/credentials`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    }),
    fetch(`${cloudBaseUrl}/api/v1/user/wallets`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    }),
  ]);

  // Parse tenant credentials
  let apiUrl: string | null = null;
  let tenantId: string | null = null;
  let apiKey: string | null = null;

  if (credRes.status === "fulfilled" && credRes.value.ok) {
    try {
      const body = (await credRes.value.json()) as {
        stewardApiUrl?: string;
        tenantId?: string;
        apiKey?: string;
      };
      apiUrl = body.stewardApiUrl || null;
      tenantId = body.tenantId || null;
      apiKey = body.apiKey || null;
    } catch {
      // parse error
    }
  } else {
    logger.debug(
      `[cloud-steward] Credentials endpoint not available: ${
        credRes.status === "fulfilled"
          ? `HTTP ${credRes.value.status}`
          : String((credRes as PromiseRejectedResult).reason)
      }`,
    );
  }

  if (!apiUrl || !tenantId) {
    return null;
  }

  // Extract steward_agent_id from the first provisioned wallet
  let agentId: string | null = null;
  if (walletsRes.status === "fulfilled" && walletsRes.value.ok) {
    try {
      const body = (await walletsRes.value.json()) as {
        success?: boolean;
        data?: Array<{ stewardAgentId?: string | null }>;
      };
      if (body.data?.length) {
        const firstWithAgent = body.data.find((w) => w.stewardAgentId);
        agentId = firstWithAgent?.stewardAgentId ?? null;
      }
    } catch {
      // parse error
    }
  }

  return { apiUrl, tenantId, apiKey: apiKey || "", agentId };
}

/**
 * Persist Steward credentials to config.env and steward-credentials.json.
 * Also sets them in process.env so steward-bridge can connect immediately.
 */
function persistStewardCredentials(
  config: ElizaConfig,
  creds: CloudStewardCredentials,
  wallets: CloudWalletProvisionResult | null,
): void {
  // Set process.env so steward-bridge connects without restart
  process.env.STEWARD_API_URL = creds.apiUrl;
  process.env.STEWARD_TENANT_ID = creds.tenantId;
  if (creds.apiKey) process.env.STEWARD_API_KEY = creds.apiKey;
  if (creds.agentId) process.env.STEWARD_AGENT_ID = creds.agentId;

  // Persist to config.env for restart survival
  const env = ((config as Record<string, unknown>).env ??
    {}) as Record<string, unknown>;
  env.STEWARD_API_URL = creds.apiUrl;
  env.STEWARD_TENANT_ID = creds.tenantId;
  if (creds.apiKey) env.STEWARD_API_KEY = creds.apiKey;
  if (creds.agentId) env.STEWARD_AGENT_ID = creds.agentId;
  (config as Record<string, unknown>).env = env;
  try {
    saveElizaConfig(config);
    logger.info("[cloud-steward] Steward credentials persisted to config");
  } catch (err) {
    logger.warn(
      `[cloud-steward] Failed to persist steward credentials: ${String(err)}`,
    );
  }

  // Also save to steward-credentials.json for the credential resolver
  try {
    saveStewardCredentials({
      apiUrl: creds.apiUrl,
      tenantId: creds.tenantId,
      agentId: creds.agentId || "",
      apiKey: creds.apiKey,
      agentToken: "", // Cloud path uses apiKey+tenantId auth, not agent token
      walletAddresses: {
        evm: wallets?.evmAddress || undefined,
        solana: wallets?.solanaAddress || undefined,
      },
    });
    logger.info("[cloud-steward] Steward credentials saved to credentials file");
  } catch (err) {
    logger.warn(
      `[cloud-steward] Failed to save credentials file: ${String(err)}`,
    );
  }
}

/**
 * Provision cloud-managed wallets (EVM + Solana) after Eliza Cloud login.
 *
 * Calls the cloud's `/api/v1/user/wallets/provision` endpoint for each chain.
 * The cloud creates Steward-backed wallets and returns addresses. We then
 * push those addresses into the runtime cache so `getWalletAddresses()`
 * returns them immediately and chains activate in the UI.
 *
 * Best-effort: never throws. Returns whatever addresses were provisioned.
 */
async function provisionCloudWallets(
  cloudBaseUrl: string,
  cloudApiKey: string,
): Promise<CloudWalletProvisionResult> {
  const result: CloudWalletProvisionResult = {
    evmAddress: null,
    solanaAddress: null,
  };

  const headers = {
    "Content-Type": "application/json",
    "X-Api-Key": cloudApiKey,
  };

  // Provision EVM and Solana wallets in parallel
  const [evmRes, solRes] = await Promise.allSettled([
    fetch(`${cloudBaseUrl}/api/v1/user/wallets/provision`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        chainType: "evm",
        clientAddress: CLOUD_WALLET_CLIENT_ADDRESS_EVM,
      }),
      signal: AbortSignal.timeout(10_000),
    }),
    fetch(`${cloudBaseUrl}/api/v1/user/wallets/provision`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        chainType: "solana",
        clientAddress: CLOUD_WALLET_CLIENT_ADDRESS_SOLANA,
      }),
      signal: AbortSignal.timeout(10_000),
    }),
  ]);

  // Extract EVM address
  if (evmRes.status === "fulfilled" && evmRes.value.ok) {
    try {
      const body = (await evmRes.value.json()) as {
        success?: boolean;
        data?: { address?: string };
      };
      if (body.data?.address) {
        result.evmAddress = body.data.address;
      }
    } catch {
      // parse error — skip
    }
  } else if (evmRes.status === "fulfilled") {
    // May be 409/500 "already exists" — try to extract address from response
    try {
      const errBody = (await evmRes.value.json()) as {
        error?: string;
        success?: boolean;
        data?: { address?: string };
      };
      if (errBody.data?.address) {
        result.evmAddress = errBody.data.address;
      } else {
        logger.debug(
          `[cloud-wallet] EVM provision HTTP ${evmRes.value.status}: ${errBody.error ?? "unknown"}`,
        );
      }
    } catch {
      // ignore
    }
  } else {
    logger.warn(
      `[cloud-wallet] EVM provision failed: ${String((evmRes as PromiseRejectedResult).reason)}`,
    );
  }

  // Extract Solana address
  if (solRes.status === "fulfilled" && solRes.value.ok) {
    try {
      const body = (await solRes.value.json()) as {
        success?: boolean;
        data?: { address?: string };
      };
      if (body.data?.address) {
        result.solanaAddress = body.data.address;
      }
    } catch {
      // parse error — skip
    }
  } else if (solRes.status === "fulfilled") {
    try {
      const errBody = (await solRes.value.json()) as {
        error?: string;
        success?: boolean;
        data?: { address?: string };
      };
      if (errBody.data?.address) {
        result.solanaAddress = errBody.data.address;
      } else {
        logger.debug(
          `[cloud-wallet] Solana provision HTTP ${solRes.value.status}: ${errBody.error ?? "unknown"}`,
        );
      }
    } catch {
      // ignore
    }
  } else {
    logger.warn(
      `[cloud-wallet] Solana provision failed: ${String((solRes as PromiseRejectedResult).reason)}`,
    );
  }

  // If provisioning didn't return addresses (e.g. wallets already exist and
  // the cloud hasn't deployed the idempotent fix yet), fall back to listing.
  if (!result.evmAddress || !result.solanaAddress) {
    try {
      const listRes = await fetch(`${cloudBaseUrl}/api/v1/user/wallets`, {
        method: "GET",
        headers: { "X-Api-Key": cloudApiKey },
        signal: AbortSignal.timeout(10_000),
      });
      if (listRes.ok) {
        const listBody = (await listRes.json()) as {
          success?: boolean;
          data?: Array<{ address?: string; chainType?: string }>;
        };
        if (listBody.data && Array.isArray(listBody.data)) {
          for (const w of listBody.data) {
            if (w.chainType === "evm" && w.address && !result.evmAddress) {
              result.evmAddress = w.address;
            }
            if (w.chainType === "solana" && w.address && !result.solanaAddress) {
              result.solanaAddress = w.address;
            }
          }
        }
      }
    } catch {
      // Non-fatal — list endpoint may not be deployed yet
    }
  }

  // Push addresses into the runtime wallet cache so getWalletAddresses()
  // returns them immediately (no restart needed).
  if (result.evmAddress || result.solanaAddress) {
    applyStewardWalletAddressesToRuntimeCache(
      result.evmAddress,
      result.solanaAddress,
    );
    logger.info(
      `[cloud-wallet] Addresses cached — EVM=${result.evmAddress ?? "none"}, SOL=${result.solanaAddress ?? "none"}`,
    );
  }

  return result;
}

export interface CloudRouteState {
  config: ElizaConfig;
  cloudManager: CloudManager | null;
  /** The running agent runtime — needed to persist cloud credentials to the DB. */
  runtime: AgentRuntime | null;
}

type CloudRuntimeSecrets = Record<string, string | number | boolean>;

const CLOUD_LOGIN_POLL_TIMEOUT_MS = 10_000;

/**
 * Monotonic counter incremented on every `POST /api/cloud/disconnect`.
 *
 * WHY: We must not persist a stale "authenticated" poll after the user
 * disconnects mid-flight. The previous guard (`cloud.enabled === false`)
 * also matched **first-time** cloud (never enabled), so successful logins
 * were discarded. Comparing epoch before/after the poll preserves the race
 * fix without blocking legitimate first connect.
 */
let cloudDisconnectEpoch = 0;

type TelemetrySpan = {
  success: (meta?: Record<string, unknown>) => void;
  failure: (meta?: Record<string, unknown>) => void;
};

function isRedirectResponse(response: Response): boolean {
  return response.status >= 300 && response.status < 400;
}

function createNoopTelemetrySpan(): TelemetrySpan {
  return {
    success: () => {},
    failure: () => {},
  };
}

function getTelemetrySpan(meta: {
  boundary: "cloud";
  operation: string;
  timeoutMs: number;
}): TelemetrySpan {
  return createIntegrationTelemetrySpan(meta) ?? createNoopTelemetrySpan();
}

async function fetchCloudLoginStatus(
  sessionId: string,
  baseUrl: string,
): Promise<Response> {
  return fetch(
    `${baseUrl}/api/auth/cli-session/${encodeURIComponent(sessionId)}`,
    {
      redirect: "manual",
      signal: AbortSignal.timeout(CLOUD_LOGIN_POLL_TIMEOUT_MS),
    },
  );
}

async function persistCloudLoginStatus(args: {
  apiKey: string;
  state: CloudRouteState;
  /**
   * From GET `/api/cloud/login/status`: epoch captured before `fetch` so a
   * disconnect during the poll invalidates this result. Omitted for POST
   * `/api/cloud/login/persist` (direct client push) — no race window.
   */
  epochAtPollStart?: number;
}): Promise<void> {
  if (
    args.epochAtPollStart !== undefined &&
    args.epochAtPollStart !== cloudDisconnectEpoch
  ) {
    logger.warn(
      "[cloud-login] Skipping login persist: a disconnect occurred while the login poll was in-flight",
    );
    return;
  }

  migrateLegacyRuntimeConfig(args.state.config as Record<string, unknown>);
  const cloud = { ...(args.state.config.cloud ?? {}) } as Record<
    string,
    unknown
  >;

  cloud.apiKey = args.apiKey;
  const cloudInferenceSelected = isCloudInferenceSelectedInConfig(
    args.state.config as Record<string, unknown>,
  );

  args.state.config.cloud = cloud as ElizaConfig["cloud"];
  applyCanonicalOnboardingConfig(args.state.config, {
    linkedAccounts: {
      elizacloud: {
        status: "linked",
        source: "api-key",
      },
    },
  });
  migrateLegacyRuntimeConfig(args.state.config as Record<string, unknown>);

  try {
    saveElizaConfig(args.state.config);
    logger.info("[cloud-login] Saved cloud API key to config file");
    logger.warn(
      "[cloud-login] Cloud API key is stored in cleartext in ~/.eliza/eliza.json. " +
        "Ensure this file has restrictive permissions (chmod 600).",
    );
  } catch (saveErr) {
    logger.error(
      `[cloud-login] Failed to save cloud API key to config: ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`,
    );
  }

  clearCloudSecrets();
  process.env.ELIZAOS_CLOUD_API_KEY = args.apiKey;
  if (cloudInferenceSelected) {
    process.env.ELIZAOS_CLOUD_ENABLED = "true";
  } else {
    delete process.env.ELIZAOS_CLOUD_ENABLED;
  }
  scrubCloudSecretsFromEnv();

  if (
    args.state.cloudManager &&
    !args.state.cloudManager.getClient() &&
    typeof args.state.cloudManager.init === "function"
  ) {
    await args.state.cloudManager.init();
  }

  const runtime = args.state.runtime as RuntimeCloudLike | null;
  if (!runtime || typeof runtime.updateAgent !== "function") {
    return;
  }

  try {
    const nextSecrets: CloudRuntimeSecrets = {
      ...(runtime.character.secrets ?? {}),
      ELIZAOS_CLOUD_API_KEY: args.apiKey,
    };
    if (cloudInferenceSelected) {
      nextSecrets.ELIZAOS_CLOUD_ENABLED = "true";
    } else {
      delete nextSecrets.ELIZAOS_CLOUD_ENABLED;
    }
    runtime.character.secrets = nextSecrets;
    await runtime.updateAgent(runtime.agentId, {
      secrets: { ...nextSecrets },
    });
  } catch (err) {
    // Non-fatal: config/sealed secret persistence is enough for login continuity.
    logger.warn(
      `[cloud-routes] Failed to persist cloud secrets to agent DB: ${String(err)}`,
    );
  }
}

function toAutonomousState(state: CloudRouteState): AutonomousCloudRouteState {
  return {
    ...state,
    saveConfig: saveElizaConfig,
    createTelemetrySpan: createIntegrationTelemetrySpan,
  };
}

export async function handleCloudRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  state: CloudRouteState,
): Promise<boolean> {
  if (method === "POST" && pathname === "/api/cloud/disconnect") {
    // Invalidate any in-flight login poll (see persistCloudLoginStatus).
    cloudDisconnectEpoch++;
    try {
      await disconnectUnifiedCloudConnection({
        cloudManager: state.cloudManager,
        config: state.config,
        runtime: state.runtime,
        saveConfig: saveElizaConfig,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[cloud/disconnect] failed", err);
      sendJson(res, 500, { ok: false, error: message });
      return true;
    }
    sendJson(res, 200, { ok: true, status: "disconnected" });
    return true;
  }

  // Direct-auth persistence: the frontend authenticated directly with Eliza
  // Cloud (bypassing the backend's login/status handler) and needs to push
  // the API key to the backend so billing/compat routes can authenticate.
  if (method === "POST" && pathname === "/api/cloud/login/persist") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        apiKey?: unknown;
      };
      if (typeof body.apiKey !== "string" || !body.apiKey.trim()) {
        sendJson(res, 400, { ok: false, error: "apiKey is required" });
        return true;
      }
      await persistCloudLoginStatus({ apiKey: body.apiKey.trim(), state });

      // Provision cloud wallets and fetch Steward credentials on direct-auth path
      let wallets: CloudWalletProvisionResult | null = null;
      const baseUrl = normalizeCloudSiteUrl(state.config.cloud?.baseUrl);
      const apiKey = body.apiKey.trim();
      try {
        wallets = await provisionCloudWallets(baseUrl, apiKey);
        if (wallets) {
          persistWalletAddressesToConfig(state.config, wallets);
        }
      } catch {
        // Non-fatal
      }

      // Fetch Steward credentials so steward-bridge can connect immediately
      try {
        const stewardCreds = await fetchCloudStewardCredentials(baseUrl, apiKey);
        if (stewardCreds) {
          persistStewardCredentials(state.config, stewardCreds, wallets);
        }
      } catch {
        // Non-fatal — steward connection will fail gracefully
      }

      sendJson(res, 200, {
        ok: true,
        evmAddress: wallets?.evmAddress ?? null,
        solanaAddress: wallets?.solanaAddress ?? null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[cloud/login/persist] Failed: ${msg}`);
      sendJson(res, 500, { ok: false, error: msg });
    }
    return true;
  }

  if (method === "GET" && pathname.startsWith("/api/cloud/login/status")) {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      sendJsonError(res, 400, "sessionId query parameter is required");
      return true;
    }

    const baseUrl = normalizeCloudSiteUrl(state.config.cloud?.baseUrl);
    const urlError = await validateCloudBaseUrl(baseUrl);
    if (urlError) {
      sendJsonError(res, 400, urlError);
      return true;
    }

    const epochBeforePoll = cloudDisconnectEpoch;

    const loginPollSpan = getTelemetrySpan({
      boundary: "cloud",
      operation: "login_poll_status",
      timeoutMs: CLOUD_LOGIN_POLL_TIMEOUT_MS,
    });

    let pollRes: Response;
    try {
      pollRes = await fetchCloudLoginStatus(sessionId, baseUrl);
    } catch (fetchErr) {
      if (isTimeoutError(fetchErr)) {
        loginPollSpan.failure({ error: fetchErr, statusCode: 504 });
        sendJson(res, 504, {
          status: "error",
          error: "Eliza Cloud status request timed out",
        });
        return true;
      }

      loginPollSpan.failure({ error: fetchErr, statusCode: 502 });
      sendJson(res, 502, {
        status: "error",
        error: "Failed to reach Eliza Cloud",
      });
      return true;
    }

    if (isRedirectResponse(pollRes)) {
      loginPollSpan.failure({
        statusCode: pollRes.status,
        errorKind: "redirect_response",
      });
      sendJson(res, 502, {
        status: "error",
        error:
          "Eliza Cloud status request was redirected; redirects are not allowed",
      });
      return true;
    }

    if (!pollRes.ok) {
      loginPollSpan.failure({
        statusCode: pollRes.status,
        errorKind: "http_error",
      });
      sendJson(
        res,
        200,
        pollRes.status === 404
          ? { status: "expired", error: "Session not found or expired" }
          : {
              status: "error",
              error: `Eliza Cloud returned HTTP ${pollRes.status}`,
            },
      );
      return true;
    }

    let data: {
      apiKey?: unknown;
      keyPrefix?: unknown;
      status?: unknown;
    };
    try {
      data = (await pollRes.json()) as {
        apiKey?: unknown;
        keyPrefix?: unknown;
        status?: unknown;
      };
    } catch (parseErr) {
      loginPollSpan.failure({ error: parseErr, statusCode: pollRes.status });
      sendJson(res, 502, {
        status: "error",
        error: "Eliza Cloud returned invalid JSON",
      });
      return true;
    }

    loginPollSpan.success({ statusCode: pollRes.status });

    if (data.status === "authenticated" && typeof data.apiKey === "string") {
      await persistCloudLoginStatus({
        apiKey: data.apiKey,
        state,
        epochAtPollStart: epochBeforePoll,
      });

      // Provision cloud-managed wallets (best-effort — login succeeds regardless)
      let wallets: CloudWalletProvisionResult | null = null;
      const baseUrl = normalizeCloudSiteUrl(state.config.cloud?.baseUrl);
      try {
        wallets = await provisionCloudWallets(baseUrl, data.apiKey);
        if (wallets) {
          persistWalletAddressesToConfig(state.config, wallets);
        }
      } catch (err) {
        logger.warn(
          `[cloud-login] Wallet provisioning failed (non-fatal): ${String(err)}`,
        );
      }

      // Fetch Steward credentials so steward-bridge can connect immediately
      try {
        const stewardCreds = await fetchCloudStewardCredentials(baseUrl, data.apiKey);
        if (stewardCreds) {
          persistStewardCredentials(state.config, stewardCreds, wallets);
        }
      } catch (err) {
        logger.warn(
          `[cloud-login] Steward credential fetch failed (non-fatal): ${String(err)}`,
        );
      }

      sendJson(res, 200, {
        status: "authenticated",
        keyPrefix:
          typeof data.keyPrefix === "string" ? data.keyPrefix : undefined,
        evmAddress: wallets?.evmAddress ?? null,
        solanaAddress: wallets?.solanaAddress ?? null,
      });
      return true;
    }

    sendJson(res, 200, {
      status: typeof data.status === "string" ? data.status : "error",
    });
    return true;
  }

  const result = await handleAutonomousCloudRoute(
    req,
    res,
    pathname,
    method,
    toAutonomousState(state),
  );

  // The upstream handler writes secrets to process.env — scrub them
  // immediately so they don't leak to child processes or env dumps.
  scrubCloudSecretsFromEnv();

  return result;
}
