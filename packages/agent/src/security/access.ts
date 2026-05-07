import type { IAgentRuntime, Memory } from "@elizaos/core";
import {
  checkSenderPrivateAccess,
  checkSenderRole,
  resolveCanonicalOwnerIdForMessage,
} from "@elizaos/core";

/** Role names matching the elizaOS role hierarchy. */
export type RequiredRole = "OWNER" | "ADMIN" | "USER" | "GUEST";

const ROLE_RANK: Record<RequiredRole, number> = {
  GUEST: 0,
  USER: 1,
  ADMIN: 2,
  OWNER: 3,
};

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
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
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

async function isCanonicalOwner(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<boolean> {
  try {
    const ownerId = await resolveCanonicalOwnerIdForMessage(runtime, message);
    return typeof ownerId === "string" && ownerId === message.entityId;
  } catch {
    return false;
  }
}

export async function hasOwnerAccess(
  runtime: IAgentRuntime | undefined,
  message: Memory | undefined,
): Promise<boolean> {
  const context = getAccessContext(runtime, message);
  if (!context) {
    return true;
  }

  if (isAgentSelf(context.runtime, context.message)) {
    return true;
  }

  if (await isCanonicalOwner(context.runtime, context.message)) {
    return true;
  }

  try {
    const role = await checkSenderRole(context.runtime, context.message);
    return role?.isOwner === true;
  } catch {
    return false;
  }
}

export async function hasAdminAccess(
  runtime: IAgentRuntime | undefined,
  message: Memory | undefined,
): Promise<boolean> {
  const context = getAccessContext(runtime, message);
  if (!context) {
    return true;
  }

  if (isAgentSelf(context.runtime, context.message)) {
    return true;
  }

  if (await isCanonicalOwner(context.runtime, context.message)) {
    return true;
  }

  try {
    const role = await checkSenderRole(context.runtime, context.message);
    return role?.isAdmin === true;
  } catch {
    return false;
  }
}

export async function hasPrivateAccess(
  runtime: IAgentRuntime | undefined,
  message: Memory | undefined,
): Promise<boolean> {
  const context = getAccessContext(runtime, message);
  if (!context) {
    return true;
  }

  if (isAgentSelf(context.runtime, context.message)) {
    return true;
  }

  if (await isCanonicalOwner(context.runtime, context.message)) {
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
 *
 * Follows the same lenient pattern as plugin-role-gating: when there is
 * no world context (e.g. local API calls), the check falls through and
 * allows the action so local-only usage isn't blocked.
 */
export async function hasRoleAccess(
  runtime: IAgentRuntime | undefined,
  message: Memory | undefined,
  requiredRole: RequiredRole,
): Promise<boolean> {
  if (requiredRole === "GUEST") {
    return true;
  }

  const context = getAccessContext(runtime, message);
  if (!context) {
    return true;
  }

  if (isAgentSelf(context.runtime, context.message)) {
    return true;
  }

  if (await isCanonicalOwner(context.runtime, context.message)) {
    return true;
  }

  try {
    const result = await checkSenderRole(context.runtime, context.message);
    if (!result) {
      // No world context — allow through (same lenient fallback as plugin-role-gating)
      return true;
    }

    const senderRank = ROLE_RANK[result.role as RequiredRole] ?? 0;
    const requiredRank = ROLE_RANK[requiredRole] ?? 0;
    return senderRank >= requiredRank;
  } catch {
    return false;
  }
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
