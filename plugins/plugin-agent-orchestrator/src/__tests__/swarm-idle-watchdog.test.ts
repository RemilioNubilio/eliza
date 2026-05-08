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

  it("marks a missing PTY completed when a completion summary was already captured", async () => {
    const taskCtx = {
      threadId: "thread-test",
      sessionId: "pty-test",
      label: "agent-test",
      status: "tool_running",
      lastActivityAt: Date.now(),
      idleCheckCount: 0,
      completionSummary: "Built the result and verified it.",
    };
    const ctx = {
      tasks: new Map([[taskCtx.sessionId, taskCtx]]),
      ptyService: {
        getSession: vi.fn(() => undefined),
      },
      inFlightDecisions: new Set(),
      pendingTurnComplete: new Map(),
      pendingBlocked: new Map(),
      sharedDecisions: [],
      swarmCompleteNotified: false,
      log: vi.fn(),
      recordDecision: vi.fn(),
      broadcast: vi.fn(),
      sendChatMessage: vi.fn(),
      syncTaskContext: vi.fn(),
      runtime: {},
      taskRegistry: {
        getThread: vi.fn(async () => null),
      },
      getSwarmCompleteCallback: vi.fn(() => undefined),
    };

    await scanIdleSessions(ctx as never);

    expect(taskCtx.status).toBe("completed");
    expect(ctx.syncTaskContext).toHaveBeenCalledWith(taskCtx);
    expect(ctx.recordDecision).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(ctx.sendChatMessage).toHaveBeenCalledWith(
        "Built the result and verified it.",
        "task-agent",
      );
    });
  });
});
