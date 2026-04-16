/**
 * Steward credential persistence for non-sidecar (web/dev) mode.
 *
 * Persists to `~/.<namespace>/steward-credentials.json` (e.g. `~/.milady/` for
 * Milady). Falls back to `~/.eliza/steward-credentials.json` for legacy installs.
 * Environment variables always override file values.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "@elizaos/agent/config/paths";

export interface PersistedStewardCredentials {
  apiUrl: string;
  tenantId: string;
  agentId: string;
  apiKey: string;
  agentToken: string;
  walletAddresses?: {
    evm?: string;
    solana?: string;
  };
  agentName?: string;
  createdAt?: string;
}

const CREDENTIALS_FILENAME = "steward-credentials.json";

function resolvePrimaryCredentialsPath(): string {
  return path.join(resolveStateDir(), CREDENTIALS_FILENAME);
}

function resolveLegacyCredentialsPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return path.join(home, ".eliza", CREDENTIALS_FILENAME);
}

/**
 * Load persisted steward credentials from disk.
 * Returns null if file doesn't exist or is unreadable.
 */
export function loadStewardCredentials(): PersistedStewardCredentials | null {
  const candidates = [
    resolvePrimaryCredentialsPath(),
    resolveLegacyCredentialsPath(),
  ];
  const seen = new Set<string>();
  for (const credPath of candidates) {
    if (seen.has(credPath)) {
      continue;
    }
    seen.add(credPath);
    try {
      if (!fs.existsSync(credPath)) {
        continue;
      }
      const raw = fs.readFileSync(credPath, "utf-8");
      const parsed = JSON.parse(raw) as PersistedStewardCredentials;
      if (!parsed.apiUrl || !parsed.tenantId || !parsed.agentId) {
        continue;
      }
      return parsed;
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * Save steward credentials to disk with restrictive permissions (0o600).
 */
export function saveStewardCredentials(
  credentials: PersistedStewardCredentials,
): void {
  const credPath = resolvePrimaryCredentialsPath();
  const dir = path.dirname(credPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const data = {
    ...credentials,
    createdAt: credentials.createdAt ?? new Date().toISOString(),
  };

  fs.writeFileSync(credPath, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/**
 * Resolve effective steward configuration by merging:
 *   env vars > persisted file > defaults
 *
 * Returns null if steward is not configured at all.
 */
export function resolveEffectiveStewardConfig(
  env: NodeJS.ProcessEnv = process.env,
): PersistedStewardCredentials | null {
  const persisted = loadStewardCredentials();

  const apiUrl = env.STEWARD_API_URL?.trim() || persisted?.apiUrl || null;
  if (!apiUrl) {
    return null;
  }

  const tenantId = env.STEWARD_TENANT_ID?.trim() || persisted?.tenantId || null;
  const agentId =
    env.STEWARD_AGENT_ID?.trim() ||
    env.ELIZA_STEWARD_AGENT_ID?.trim() ||
    env.ELIZA_STEWARD_AGENT_ID?.trim() ||
    persisted?.agentId ||
    null;
  const apiKey = env.STEWARD_API_KEY?.trim() || persisted?.apiKey || "";
  const agentToken =
    env.STEWARD_AGENT_TOKEN?.trim() || persisted?.agentToken || "";

  return {
    apiUrl,
    tenantId: tenantId || "",
    agentId: agentId || "",
    apiKey,
    agentToken,
    walletAddresses: persisted?.walletAddresses,
    agentName: persisted?.agentName,
    createdAt: persisted?.createdAt,
  };
}
