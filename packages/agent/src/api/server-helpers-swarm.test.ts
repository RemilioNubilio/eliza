import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  handleSwarmSynthesis,
  routeAutonomyTextToUser,
} from "./server-helpers-swarm.js";

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
            completionSummary: "https://example.com/apps/breath-ring/",
            workdir: "/workspace/site",
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

    expect(routed).toEqual(["https://example.com/apps/breath-ring/"]);
  });

  it("uses validator-accepted task evidence when available", async () => {
    const routed: string[] = [];

    await handleSwarmSynthesis(
      { runtime },
      {
        tasks: [
          {
            sessionId: "pty-1",
            label: "status",
            agentType: "codex",
            originalTask: "inspect the project status",
            status: "completed",
            completionSummary:
              "Additional artifact: https://example.com/report",
            validationSummary:
              "Branch: feature/status-check\nWorktree: clean\nOpen PR: https://github.com/example/project/pull/123\nNo files changed.",
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

    expect(routed).toEqual([
      [
        "Branch: feature/status-check",
        "Worktree: clean",
        "Open PR: https://github.com/example/project/pull/123",
        "No files changed.",
        "https://example.com/report",
      ].join("\n"),
    ]);
  });

  it("preserves concrete URLs from task evidence when validator summaries abbreviate them", async () => {
    const routed: string[] = [];

    await handleSwarmSynthesis(
      { runtime },
      {
        tasks: [
          {
            sessionId: "pty-1",
            label: "docs",
            agentType: "codex",
            originalTask: "make a small docs update and report the link",
            status: "completed",
            completionSummary:
              "Opened review: https://example.com/org/project/pull/123\nValidation passed.",
            validationSummary:
              "A small docs update is open as review #123 and validation passed.",
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

    expect(routed).toEqual([
      [
        "A small docs update is open as review #123 and validation passed.",
        "https://example.com/org/project/pull/123",
      ].join("\n"),
    ]);
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

  it("attaches referenced task-workdir artifacts to connector synthesis", async () => {
    const workdir = await mkdtemp(path.join(tmpdir(), "swarm-artifact-"));
    const imagePath = path.join(workdir, "result.png");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
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
            label: "image",
            agentType: "codex",
            originalTask: "generate an image",
            status: "completed",
            completionSummary: `Created image at \`${imagePath}\`.`,
            workdir,
            roomId: "room-1",
          },
        ],
        total: 1,
        completed: 1,
        stopped: 0,
        errored: 0,
      },
      async () => undefined,
    );

    expect(sent[0].content).toMatchObject({
      attachments: [
        expect.objectContaining({
          url: imagePath,
          title: "result.png",
          contentType: "image",
        }),
      ],
    });
  });
});

describe("routeAutonomyTextToUser", () => {
  it("does not persist swarm synthesis before the connector stores the platform reply", async () => {
    const createMemory = vi.fn();
    const broadcastWs = vi.fn();
    const state = {
      runtime: {
        agentId: "00000000-0000-0000-0000-000000000001",
        createMemory,
      },
      activeConversationId: "conv-1",
      conversations: new Map([
        [
          "conv-1",
          {
            id: "conv-1",
            roomId: "00000000-0000-0000-0000-000000000002",
            updatedAt: "2026-05-07T00:00:00.000Z",
          },
        ],
      ]),
      broadcastWs,
    } as never;

    await routeAutonomyTextToUser(state, "done", "swarm_synthesis");

    expect(createMemory).not.toHaveBeenCalled();
    expect(broadcastWs).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "proactive-message",
        message: expect.objectContaining({
          text: "done",
          source: "swarm_synthesis",
        }),
      }),
    );
  });
});
