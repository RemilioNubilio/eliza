import { describe, expect, it, vi } from "vitest";
import { scanIdleSessions } from "../services/swarm-idle-watchdog.js";

describe("scanIdleSessions", () => {
  it("does not mark a missing PTY stopped while turn assessment is in flight", async () => {
    const taskCtx = {
      sessionId: "pty-test",
      label: "agent-test",
      status: "active",
      lastActivityAt: Date.now(),
      idleCheckCount: 0,
    };
    const ctx = {
      tasks: new Map([[taskCtx.sessionId, taskCtx]]),
      ptyService: {
        getSession: vi.fn(() => undefined),
      },
      inFlightDecisions: new Set([taskCtx.sessionId]),
      pendingTurnComplete: new Map(),
      pendingBlocked: new Map(),
      log: vi.fn(),
      recordDecision: vi.fn(),
      broadcast: vi.fn(),
      sendChatMessage: vi.fn(),
    };

    await scanIdleSessions(ctx as never);

    expect(taskCtx.status).toBe("active");
    expect(ctx.recordDecision).not.toHaveBeenCalled();
    expect(ctx.broadcast).not.toHaveBeenCalled();
    expect(ctx.sendChatMessage).not.toHaveBeenCalled();
  });
});
