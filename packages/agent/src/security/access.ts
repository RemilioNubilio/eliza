import type { IAgentRuntime, Memory } from "@elizaos/core";
import {
  checkSenderPrivateAccess,
  hasRoleAccess as coreHasRoleAccess,
} from "@elizaos/core";

/** Role names matching the elizaOS role hierarchy. */
export type RequiredRole = "OWNER" | "ADMIN" | "USER" | "GUEST";

const ACTION_ROLE_POLICY_SETTING = "ACTION_ROLE_POLICY";

function normalizeRole(value: unknown): RequiredRole | null {
  const role = typeof value === "string" ? value.trim().toUpperCase() : "";
  switch (role) {
    case "OWNER":
    case "ADMIN":
    case "USER":
    case "GUEST":
      return role;
    default:
      return null;
  }
}

function normalizeActionName(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
}

function readRuntimeSetting(
  runtime: IAgentRuntime | undefined,
  key: string,
): string | undefined {
  try {
    const value = runtime?.getSetting?.(key) ?? process.env[key];
    return typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : undefined;
  } catch {
    return process.env[key];
  }
}

function parseActionRolePolicy(
  runtime: IAgentRuntime | undefined,
): Record<string, RequiredRole> {
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

  const policy: Record<string, RequiredRole> = {};
  for (const [name, roleValue] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    const role = normalizeRole(roleValue);
    const normalizedName = normalizeActionName(name);
    if (role && normalizedName) {
      policy[normalizedName] = role;
    }
  }

  return policy;
}

export function getRequiredRoleForAction(
  runtime: IAgentRuntime | undefined,
  actionName: string,
  fallback: RequiredRole,
): RequiredRole {
  const configuredRole =
    parseActionRolePolicy(runtime)[normalizeActionName(actionName)];
  return configuredRole ?? fallback;
}

type AccessContext = {
  runtime: IAgentRuntime & { agentId: string };
  message: Memory & { entityId: string };
};

function getAccessContext(
  runtime: IAgentRuntime | undefined,
  message: Memory | undefined,
): AccessContext | null {
  if (
    !runtime ||
    typeof runtime.agentId !== "string" ||
    !message ||
    typeof message.entityId !== "string" ||
    message.entityId.length === 0
  ) {
    return null;
  }

  return {
    runtime,
    message,
  };
}

export function isAgentSelf(
  runtime: IAgentRuntime | undefined,
  message: Memory | undefined,
): boolean {
  const context = getAccessContext(runtime, message);
  if (!context) {
    return false;
  }
  return context.message.entityId === context.runtime.agentId;
}

export async function hasOwnerAccess(
  runtime: IAgentRuntime | undefined,
  message: Memory | undefined,
): Promise<boolean> {
  return coreHasRoleAccess(runtime, message, "OWNER");
}

export async function hasAdminAccess(
  runtime: IAgentRuntime | undefined,
  message: Memory | undefined,
): Promise<boolean> {
  return coreHasRoleAccess(runtime, message, "ADMIN");
}

export async function hasPrivateAccess(
  runtime: IAgentRuntime | undefined,
  message: Memory | undefined,
): Promise<boolean> {
  if (await coreHasRoleAccess(runtime, message, "OWNER")) {
    return true;
  }

  const context = getAccessContext(runtime, message);
  if (!context) {
    return true;
  }

  try {
    const access = await checkSenderPrivateAccess(
      context.runtime,
      context.message,
    );
    return access?.hasPrivateAccess === true;
  } catch {
    return false;
  }
}

/**
 * Check whether the sender has at least the given role in the elizaOS
 * role hierarchy (OWNER > ADMIN > USER > GUEST).
 */
export async function hasRoleAccess(
  runtime: IAgentRuntime | undefined,
  message: Memory | undefined,
  requiredRole: RequiredRole,
): Promise<boolean> {
  return coreHasRoleAccess(runtime, message, requiredRole);
}

export async function hasActionRoleAccess(
  runtime: IAgentRuntime | undefined,
  message: Memory | undefined,
  actionName: string,
  fallback: RequiredRole,
): Promise<boolean> {
  return hasRoleAccess(
    runtime,
    message,
    getRequiredRoleForAction(runtime, actionName, fallback),
  );
}
