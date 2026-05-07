import { describe, expect, it } from "vitest";
import { handleSwarmSynthesis } from "./server-helpers-swarm.js";

const runtime = {
  getService() {
    return null;
  },
} as never;

describe("handleSwarmSynthesis", () => {
  it("uses the coordinator summary for Codex tasks instead of unrelated Claude jsonl from the same workdir", async () => {
    const routed: string[] = [];

    await handleSwarmSynthesis(
      { runtime },
      {
        tasks: [
          {
            sessionId: "pty-1",
            label: "app",
            agentType: "codex",
            originalTask: "build a small app",
            status: "completed",
            completionSummary: "https://nubilio.org/apps/breath-ring/",
            workdir: "/home/milady/projects/agent-home",
          },
        ],
        total: 1,
        completed: 1,
        stopped: 0,
        errored: 0,
      },
      async (text) => {
        routed.push(text);
      },
    );

    expect(routed).toEqual(["https://nubilio.org/apps/breath-ring/"]);
  });

  it("routes async connector synthesis as a reply to the originating external message when available", async () => {
    const sent: Array<{ target: unknown; content: Record<string, unknown> }> =
      [];
    const runtimeWithConnector = {
      getService() {
        return null;
      },
      getRoom: async () => ({
        id: "room-1",
        source: "discord",
        channelId: "channel-1",
        serverId: "guild-1",
      }),
      sendMessageToTarget: async (target: unknown, content: unknown) => {
        sent.push({ target, content: content as Record<string, unknown> });
      },
    } as never;

    await handleSwarmSynthesis(
      { runtime: runtimeWithConnector },
      {
        tasks: [
          {
            sessionId: "pty-1",
            label: "app",
            agentType: "codex",
            originalTask: "build a small app",
            status: "completed",
            completionSummary: "done",
            roomId: "room-1",
            replyToExternalMessageId: "1501955635959435505",
          },
        ],
        total: 1,
        completed: 1,
        stopped: 0,
        errored: 0,
      },
      async () => undefined,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].content).toMatchObject({
      text: "done",
      source: "swarm_synthesis",
      inReplyTo: "1501955635959435505",
    });
  });
});
