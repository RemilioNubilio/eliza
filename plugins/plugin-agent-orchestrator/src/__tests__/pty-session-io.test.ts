import { describe, expect, it, vi } from "vitest";
import { stopSession } from "../services/pty-session-io.js";

describe("stopSession", () => {
  it("cleans local state when the PTY process already exited", async () => {
    const unsubscribe = vi.fn();
    const log = vi.fn();
    const sessionId = "pty-missing";
    const ctx = {
      manager: {
        get: vi.fn(() => undefined),
      },
      usingBunWorker: true,
      sessionOutputBuffers: new Map([[sessionId, ["output"]]]),
      taskResponseMarkers: new Map([[sessionId, 1]]),
      outputUnsubscribers: new Map([[sessionId, unsubscribe]]),
    };
    const metadata = new Map<string, Record<string, unknown>>([
      [sessionId, { agentType: "codex" }],
    ]);
    const workdirs = new Map<string, string>();

    await expect(
      stopSession(ctx as never, sessionId, metadata, workdirs, log),
    ).resolves.toBeUndefined();

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(ctx.sessionOutputBuffers.has(sessionId)).toBe(false);
    expect(ctx.taskResponseMarkers.has(sessionId)).toBe(false);
    expect(ctx.outputUnsubscribers.has(sessionId)).toBe(false);
    expect(metadata.has(sessionId)).toBe(false);
    expect(log).toHaveBeenCalledWith(
      `Stop requested for missing session ${sessionId}; cleaning local state`,
    );
  });
});
