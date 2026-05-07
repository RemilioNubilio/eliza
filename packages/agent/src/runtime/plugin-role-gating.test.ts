import type { Action, IAgentRuntime, Memory, Plugin } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkSenderRole: vi.fn(),
}));

vi.mock("./roles.js", () => ({
  checkSenderRole: mocks.checkSenderRole,
}));

import { applyPluginRoleGating } from "./plugin-role-gating.js";

function runtimeWithPolicy(
  policy: string | undefined,
  actions: Action[] = [],
): IAgentRuntime {
  return {
    agentId: "agent-id",
    actions,
    getSetting: vi.fn((key: string) =>
      key === "ACTION_ROLE_POLICY" ? policy : undefined,
    ),
  } as unknown as IAgentRuntime;
}

function message(): Memory {
  return {
    agentId: "agent-id",
    entityId: "guest-id",
    roomId: "room-id",
    content: {},
  } as Memory;
}

function pluginWithAction(action: Action): Plugin {
  return {
    name: "agent-orchestrator",
    actions: [action],
  } as Plugin;
}

describe("plugin role gating action policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows an explicit guest action policy to lower a static owner gate", async () => {
    const originalValidate = vi.fn(async () => true);
    const action = {
      name: "START_CODING_TASK",
      similes: ["CREATE_TASK"],
      validate: originalValidate,
    } as unknown as Action;

    applyPluginRoleGating([pluginWithAction(action)]);

    await expect(
      action.validate?.(
        runtimeWithPolicy(JSON.stringify({ START_CODING_TASK: "GUEST" })),
        message(),
      ),
    ).resolves.toBe(true);
    expect(originalValidate).toHaveBeenCalled();
    expect(mocks.checkSenderRole).not.toHaveBeenCalled();
  });

  it("applies configured policy to declarative action gates used by v5 tools", () => {
    const action = {
      name: "SPAWN_AGENT",
      contextGate: { anyOf: ["general"], roleGate: { minRole: "OWNER" } },
      roleGate: { minRole: "OWNER" },
      validate: vi.fn(async () => true),
    } as unknown as Action;
    const registeredAction = {
      ...action,
      contextGate: { anyOf: ["general"], roleGate: { minRole: "OWNER" } },
      roleGate: { minRole: "OWNER" },
    } as unknown as Action;

    applyPluginRoleGating(
      [pluginWithAction(action)],
      runtimeWithPolicy(JSON.stringify({ SPAWN_AGENT: "GUEST" }), [
        registeredAction,
      ]),
    );

    expect(action.roleGate).toBeUndefined();
    expect(action.contextGate).toEqual({ anyOf: ["general"] });
    expect(registeredAction.roleGate).toBeUndefined();
    expect(registeredAction.contextGate).toEqual({ anyOf: ["general"] });
  });

  it("matches configured policies against action similes", async () => {
    const originalValidate = vi.fn(async () => true);
    const action = {
      name: "START_CODING_TASK",
      similes: ["CREATE_TASK"],
      validate: originalValidate,
    } as unknown as Action;

    applyPluginRoleGating([pluginWithAction(action)]);

    await expect(
      action.validate?.(
        runtimeWithPolicy(JSON.stringify({ CREATE_TASK: "GUEST" })),
        message(),
      ),
    ).resolves.toBe(true);
    expect(originalValidate).toHaveBeenCalled();
    expect(mocks.checkSenderRole).not.toHaveBeenCalled();
  });

  it("keeps the built-in gate when no action policy is configured", async () => {
    const action = {
      name: "START_CODING_TASK",
      validate: vi.fn(async () => true),
    } as unknown as Action;
    mocks.checkSenderRole.mockResolvedValue({
      role: "GUEST",
      isAdmin: false,
      isOwner: false,
    });

    applyPluginRoleGating([pluginWithAction(action)]);

    await expect(
      action.validate?.(runtimeWithPolicy(undefined), message()),
    ).resolves.toBe(false);
    expect(mocks.checkSenderRole).toHaveBeenCalled();
  });
});
