/**
 * Legacy provider role gating plus runtime-configurable action role policy.
 *
 * Action access is declared on each action's `roleGate` and enforced by core
 * execution paths. This module keeps provider redaction for legacy providers
 * that do not yet run through the context catalog, and lets operators lower or
 * raise specific action gates through ACTION_ROLE_POLICY without hardcoding
 * instance-specific policy into source.
 *
 * @module plugin-role-gating
 */
import type {
  Action,
  RoleGate as CoreRoleGate,
  IAgentRuntime,
  Memory,
  Plugin,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";

type RoleGateLevel = "user" | "admin" | "owner";
type RoleName = "OWNER" | "ADMIN" | "USER" | "GUEST";

const ACTION_ROLE_POLICY_SETTING = "ACTION_ROLE_POLICY";

const ROLE_GATED_PLUGINS: Readonly<Record<string, RoleGateLevel>> = {};

const ACTION_ROLE_OVERRIDES: Readonly<Record<string, RoleGateLevel>> = {};

// ---------------------------------------------------------------------------
// Provider-level gating — providers that expose sensitive context.
// Keys are exact provider `name` strings.
// ---------------------------------------------------------------------------

const PROVIDER_ROLE_OVERRIDES: Readonly<Record<string, RoleGateLevel>> = {
  // Shell
  shellHistoryProvider: "admin",
  terminalUsage: "admin",

  // Orchestrator
  ACTIVE_WORKSPACE_CONTEXT: "admin",
  CODING_AGENT_EXAMPLES: "admin",

  // Secrets
  SECRETS_STATUS: "admin",
  SECRETS_INFO: "admin",
  MISSING_SECRETS: "admin",

  // Cron
  cronContext: "admin",

  // Cloud
  elizacloud_status: "admin",
  elizacloud_credits: "admin",
  elizacloud_health: "admin",
  elizacloud_models: "admin",

  // Todos
  todos: "user",

  // Browser / wallet operational state
  app_browser_workspace: "owner",
  computerState: "owner",
  "get-balance": "owner",
  "solana-wallet": "owner",
  wallet: "owner",
  walletBalance: "owner",
  walletPortfolio: "owner",
  tokenPrices: "owner",
  chainInfo: "owner",

  // Apps / plugins expose local installation/runtime state.
  available_apps: "owner",
  pluginConfigurationStatus: "owner",
  pluginState: "owner",
  registryPlugins: "owner",
};

// ---------------------------------------------------------------------------
// Gating implementation
// ---------------------------------------------------------------------------

function roleCheckPasses(
  check: { isOwner?: boolean; isAdmin?: boolean; role?: string },
  gate: RoleGateLevel,
): boolean {
  switch (gate) {
    case "owner":
      return check.isOwner === true;
    case "admin":
      return check.isAdmin === true;
    case "user":
      // USER, ADMIN, and OWNER all pass the "user" gate.
      // Only GUEST (rank 0) is blocked.
      return check.role !== "GUEST" && check.role !== "NONE";
    default:
      return false;
  }
}

function normalizePolicyKey(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
}

function normalizeRoleName(value: unknown): RoleName | null {
  const upper = typeof value === "string" ? value.trim().toUpperCase() : "";
  switch (upper) {
    case "OWNER":
    case "ADMIN":
    case "USER":
    case "GUEST":
      return upper;
    default:
      return null;
  }
}

function roleNameToGate(role: RoleName): RoleGateLevel | null {
  switch (role) {
    case "OWNER":
      return "owner";
    case "ADMIN":
      return "admin";
    case "USER":
      return "user";
    case "GUEST":
      return null;
  }
}

function readRuntimeSetting(
  runtime: IAgentRuntime,
  key: string,
): string | undefined {
  try {
    const value = runtime.getSetting?.(key) ?? process.env[key];
    return typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : undefined;
  } catch {
    return process.env[key];
  }
}

function parseActionRolePolicy(
  runtime: IAgentRuntime,
): Record<string, RoleName> {
  const raw = readRuntimeSetting(runtime, ACTION_ROLE_POLICY_SETTING);
  if (!raw) {
    return {};
  }

  let parsed: unknown = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  const policy: Record<string, RoleName> = {};
  for (const [name, roleValue] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    const role = normalizeRoleName(roleValue);
    const key = normalizePolicyKey(name);
    if (role && key) {
      policy[key] = role;
    }
  }
  return policy;
}

function gateLevelToCoreRoleGate(
  gate: RoleGateLevel | null,
): CoreRoleGate | undefined {
  switch (gate) {
    case "owner":
      return { minRole: "OWNER" };
    case "admin":
      return { minRole: "ADMIN" };
    case "user":
      return { minRole: "USER" };
    default:
      return undefined;
  }
}

function applyDeclarativeActionGate(
  action: Action,
  gate: RoleGateLevel | null,
): void {
  const roleGate = gateLevelToCoreRoleGate(gate);
  if (roleGate) {
    action.roleGate = roleGate;
  } else {
    delete action.roleGate;
  }

  if (action.contextGate) {
    const contextGate = { ...action.contextGate };
    if (roleGate) {
      contextGate.roleGate = roleGate;
    } else {
      delete contextGate.roleGate;
    }
    action.contextGate = contextGate;
  }
}

function resolvePluginGate(pluginName: string): RoleGateLevel | undefined {
  return (
    ROLE_GATED_PLUGINS[pluginName] ??
    ROLE_GATED_PLUGINS[pluginName.replace(/^@elizaos\/plugin-/, "")] ??
    ROLE_GATED_PLUGINS[pluginName.replace(/^@elizaos\/app-/, "")]
  );
}

function resolveConfiguredActionGate(
  policy: Record<string, RoleName>,
  action: Action,
): RoleGateLevel | null | undefined {
  const candidates = [
    action.name,
    ...(Array.isArray(action.similes) ? action.similes : []),
  ];

  for (const candidate of candidates) {
    const role = policy[normalizePolicyKey(candidate)];
    if (role) {
      return roleNameToGate(role);
    }
  }

  return undefined;
}

function applyActionPolicy(
  plugin: Plugin,
  runtime: IAgentRuntime | undefined,
): number {
  const policy = runtime ? parseActionRolePolicy(runtime) : {};
  let total = 0;

  for (const action of plugin.actions ?? []) {
    const pluginGate = resolvePluginGate(plugin.name ?? "");
    const actionGate = ACTION_ROLE_OVERRIDES[action.name];
    const configuredGate = resolveConfiguredActionGate(policy, action);
    const effectiveGate = configuredGate ?? actionGate ?? pluginGate;

    if (configuredGate === undefined && !actionGate && !pluginGate) {
      continue;
    }

    const targets = new Set<Action>([action]);
    const registeredAction = runtime?.actions?.find(
      (candidate) => candidate.name === action.name,
    );
    if (registeredAction) {
      targets.add(registeredAction);
    }

    for (const target of targets) {
      applyDeclarativeActionGate(target, effectiveGate ?? null);
    }
    total++;
  }

  return total;
}

/**
 * Wrap a provider's get function so it returns empty content for callers
 * below the gate. Providers don't block; they just withhold context.
 */
function gateProvider(provider: Provider, gate: RoleGateLevel): void {
  if ((provider as { __roleGate?: RoleGateLevel }).__roleGate === gate) {
    return;
  }

  const originalGet = provider.get;

  provider.get = async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
  ): Promise<ProviderResult> => {
    const { checkSenderRole } = await import("./roles.js");

    const check = await checkSenderRole(runtime, message);
    if (!check || !roleCheckPasses(check, gate)) {
      return { text: "" };
    }

    return originalGet.call(provider, runtime, message, state);
  };
  (provider as { __roleGate?: RoleGateLevel }).__roleGate = gate;
}

/**
 * Apply configured role gates to registered plugins. Call after
 * runtime.initialize().
 *
 * Providers in PROVIDER_ROLE_OVERRIDES get gated. Actions keep their
 * source-declared gates unless ACTION_ROLE_POLICY overrides them.
 */
export function applyPluginRoleGating(
  plugins: Plugin[],
  runtime?: IAgentRuntime,
): void {
  let totalActions = 0;
  let totalProviders = 0;

  for (const plugin of plugins) {
    totalActions += applyActionPolicy(plugin, runtime);

    if (plugin.providers?.length) {
      for (const provider of plugin.providers) {
        const providerName = (provider as { name?: string }).name ?? "";
        const providerGate = PROVIDER_ROLE_OVERRIDES[providerName];
        if (providerGate) {
          gateProvider(provider, providerGate);
          totalProviders++;
        }
      }
    }
  }

  if (totalActions > 0 || totalProviders > 0) {
    logger.info(
      `[role-gating] Total: ${totalActions} action(s), ${totalProviders} provider(s) gated`,
    );
  }
}

/** Exported for testing. */
export { ACTION_ROLE_OVERRIDES, PROVIDER_ROLE_OVERRIDES, ROLE_GATED_PLUGINS };
