import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { getRequiredRoleForAction, hasActionRoleAccess } from "./access.js";

function runtimeWithPolicy(policy: string | undefined): IAgentRuntime {
  return {
    agentId: "agent-id",
    getSetting: vi.fn((key: string) =>
      key === "ACTION_ROLE_POLICY" ? policy : undefined,
    ),
  } as unknown as IAgentRuntime;
}

describe("action role policy", () => {
  it("falls back to the action default when no policy is configured", () => {
    expect(
      getRequiredRoleForAction(
        runtimeWithPolicy(undefined),
        "SHELL_COMMAND",
        "OWNER",
      ),
    ).toBe("OWNER");
  });

  it("reads explicit action role overrides from runtime settings", () => {
    const runtime = runtimeWithPolicy(
      JSON.stringify({
        SHELL_COMMAND: "GUEST",
        "web-search": "USER",
      }),
    );

    expect(getRequiredRoleForAction(runtime, "SHELL_COMMAND", "OWNER")).toBe(
      "GUEST",
    );
    expect(getRequiredRoleForAction(runtime, "WEB_SEARCH", "OWNER")).toBe(
      "USER",
    );
  });

  it("ignores malformed policy JSON", () => {
    expect(
      getRequiredRoleForAction(
        runtimeWithPolicy("{not-json"),
        "SHELL_COMMAND",
        "OWNER",
      ),
    ).toBe("OWNER");
  });

  it("lets an action configured as guest pass without role context", async () => {
    const runtime = runtimeWithPolicy(
      JSON.stringify({ SHELL_COMMAND: "GUEST" }),
    );

    await expect(
      hasActionRoleAccess(
        runtime,
        {
          agentId: "agent-id",
          entityId: "guest-id",
          roomId: "room-id",
          content: {},
        } as Memory,
        "SHELL_COMMAND",
        "OWNER",
      ),
    ).resolves.toBe(true);
  });
});
