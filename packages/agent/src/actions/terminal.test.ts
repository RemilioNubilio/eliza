import type { IAgentRuntime, Memory } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasActionRoleAccess } from "../security/access.js";
import { terminalAction } from "./terminal";

vi.mock("../security/access.js", () => ({
  hasActionRoleAccess: vi.fn(),
}));

describe("SHELL_COMMAND action", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.mocked(hasActionRoleAccess).mockReset();
  });

  it("marks the turn as owned when terminal access is denied", async () => {
    vi.mocked(hasActionRoleAccess).mockResolvedValue(false);
    const result = await terminalAction.handler?.(
      { agentId: "agent-id" } as IAgentRuntime,
      {
        agentId: "agent-id",
        entityId: "not-owner",
        roomId: "room-id",
        content: {},
      } as Memory,
    );

    expect(result).toMatchObject({
      success: false,
      text: "Permission denied: only the owner may run terminal commands.",
      data: {
        actionName: "SHELL_COMMAND",
        suppressPostActionContinuation: true,
        terminal: { permissionDenied: true },
      },
    });
  });

  it("passes the configured terminal run token to the local terminal API", async () => {
    vi.mocked(hasActionRoleAccess).mockResolvedValue(true);
    vi.stubEnv("ELIZA_TERMINAL_RUN_TOKEN", "test-terminal-token");
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        exitCode: 0,
        stdout: "ok\n",
        stderr: "",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await terminalAction.handler?.(
      {
        agentId: "agent-id",
        getSetting: vi.fn(),
      } as unknown as IAgentRuntime,
      {
        agentId: "agent-id",
        entityId: "guest",
        roomId: "room-id",
        content: {},
      } as Memory,
      undefined,
      {
        parameters: { command: "df -h" },
      },
    );

    expect(result).toMatchObject({ success: true });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/terminal/run"),
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Eliza-Terminal-Token": "test-terminal-token",
        }),
      }),
    );
  });

  it("falls back to the live Milady API port when API_PORT is not set", async () => {
    vi.mocked(hasActionRoleAccess).mockResolvedValue(true);
    vi.stubEnv("API_PORT", "");
    vi.stubEnv("SERVER_PORT", "");
    vi.stubEnv("ELIZA_API_PORT", "");
    vi.stubEnv("MILADY_API_PORT", "47831");
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        exitCode: 0,
        stdout: "ok\n",
        stderr: "",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await terminalAction.handler?.(
      {
        agentId: "agent-id",
        getSetting: vi.fn(),
      } as unknown as IAgentRuntime,
      {
        agentId: "agent-id",
        entityId: "guest",
        roomId: "room-id",
        content: {},
      } as Memory,
      undefined,
      {
        parameters: { command: "df -h" },
      },
    );

    expect(result).toMatchObject({ success: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:47831/api/terminal/run",
      expect.any(Object),
    );
  });

  it("passes the process env token exactly when it is a vault ref", async () => {
    vi.mocked(hasActionRoleAccess).mockResolvedValue(true);
    vi.stubEnv("ELIZA_TERMINAL_RUN_TOKEN", "vault://ELIZA_TERMINAL_RUN_TOKEN");
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        exitCode: 0,
        stdout: "ok\n",
        stderr: "",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await terminalAction.handler?.(
      {
        agentId: "agent-id",
        getSetting: vi.fn(() => "runtime-terminal-token"),
      } as unknown as IAgentRuntime,
      {
        agentId: "agent-id",
        entityId: "guest",
        roomId: "room-id",
        content: {},
      } as Memory,
      undefined,
      {
        parameters: { command: "df -h" },
      },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/terminal/run"),
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Eliza-Terminal-Token": "vault://ELIZA_TERMINAL_RUN_TOKEN",
        }),
      }),
    );
  });

  it("reports local terminal API failures instead of returning an empty error", async () => {
    vi.mocked(hasActionRoleAccess).mockResolvedValue(true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 401,
        text: async () => "Missing terminal token",
      })),
    );

    const result = await terminalAction.handler?.(
      {
        agentId: "agent-id",
        getSetting: vi.fn(),
      } as unknown as IAgentRuntime,
      {
        agentId: "agent-id",
        entityId: "guest",
        roomId: "room-id",
        content: {},
      } as Memory,
      undefined,
      {
        parameters: { command: "df -h" },
      },
    );

    expect(result).toMatchObject({
      success: false,
      text: expect.stringContaining("Terminal request failed: HTTP 401"),
      data: {
        actionName: "SHELL_COMMAND",
        suppressPostActionContinuation: true,
      },
    });
  });
});
