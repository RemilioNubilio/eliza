import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { spawnAgentAction } from "../actions/spawn-agent.js";

describe("SPAWN_AGENT registration", () => {
  it("describes agentType as a reasoning-agent selector, not a prose shell route", () => {
    const agentType = spawnAgentAction.parameters?.find(
      (param) => param.name === "agentType",
    );

    expect(agentType?.description).toContain(
      "Specific reasoning task-agent framework",
    );
    expect(agentType?.description).toContain("Do NOT select 'shell' or 'pi'");
  });

  it("documents keepAliveAfterComplete as explicit opt-in", () => {
    const keepAlive = spawnAgentAction.parameters?.find(
      (param) => param.name === "keepAliveAfterComplete",
    );

    expect(keepAlive?.description).toContain("Leave unset or false");
    expect(keepAlive?.description).toContain("explicitly asks");
  });

  it("registers coordinator task metadata before delivering the initial task", async () => {
    const order: string[] = [];
    const coordinator = {
      createTaskThread: vi.fn(async () => ({ id: "thread-1" })),
      registerTask: vi.fn(async (sessionId: string) => {
        order.push(`register:${sessionId}`);
      }),
    };
    const ptyService = {
      coordinator,
      defaultApprovalPreset: "autonomous",
      resolveAgentType: vi.fn(async () => "codex"),
      checkAvailableAgents: vi.fn(async () => [
        { adapter: "codex", installed: true },
      ]),
      spawnSession: vi.fn(async (options: Record<string, unknown>) => {
        const session = {
          id: "pty-fast",
          name: options.name as string,
          agentType: options.agentType as string,
          workdir: options.workdir as string,
          status: "running",
          createdAt: new Date(),
          lastActivityAt: new Date(),
          metadata: options.metadata as Record<string, unknown> | undefined,
        };
        const beforeInitialTask = options.beforeInitialTask as
          | ((value: typeof session) => Promise<void> | void)
          | undefined;
        await beforeInitialTask?.(session);
        order.push("initial-task-delivered");
        return session;
      }),
      onSessionEvent: vi.fn(() => undefined),
      subscribeToOutput: vi.fn(() => () => undefined),
    };
    const runtime = {
      agentId: "agent-1",
      getService: vi.fn((name: string) =>
        name === "PTY_SERVICE" ? ptyService : undefined,
      ),
      getSetting: vi.fn((name: string) =>
        name === "CODING_AGENT_SANDBOX" ? "off" : undefined,
      ),
      getRoom: vi.fn(async () => ({ source: "discord" })),
    } as unknown as IAgentRuntime;
    const message = {
      id: "message-1",
      entityId: "agent-1",
      roomId: "room-1",
      worldId: "world-1",
      content: {
        source: "discord",
        text: "look up btc",
      },
    } as unknown as Memory;

    const result = await spawnAgentAction.handler?.(
      runtime,
      message,
      undefined,
      {
        parameters: {
          agentType: "codex",
          task: "look up btc",
          workdir: "/tmp",
        },
      },
      vi.fn(),
    );

    expect(result?.success).toBe(true);
    expect(result?.data).toMatchObject({ sessionId: "pty-fast" });
    expect(order).toEqual(["register:pty-fast", "initial-task-delivered"]);
    expect(coordinator.registerTask).toHaveBeenCalledWith(
      "pty-fast",
      expect.objectContaining({
        threadId: "thread-1",
        agentType: "codex",
        originalTask: "look up btc",
        workdir: "/tmp",
      }),
    );
  });

  it("grounds stale planner task text in the current prompt before routing and registering", async () => {
    const coordinator = {
      createTaskThread: vi.fn(async () => ({ id: "thread-1" })),
      registerTask: vi.fn(async () => undefined),
    };
    let spawnOptions: Record<string, unknown> | undefined;
    const ptyService = {
      coordinator,
      defaultApprovalPreset: "autonomous",
      resolveAgentType: vi.fn(async () => "codex"),
      checkAvailableAgents: vi.fn(async () => [
        { adapter: "codex", installed: true },
      ]),
      spawnSession: vi.fn(async (options: Record<string, unknown>) => {
        spawnOptions = options;
        const session = {
          id: "pty-grounded",
          name: options.name as string,
          agentType: options.agentType as string,
          workdir: options.workdir as string,
          status: "running",
          createdAt: new Date(),
          lastActivityAt: new Date(),
          metadata: options.metadata as Record<string, unknown> | undefined,
        };
        const beforeInitialTask = options.beforeInitialTask as
          | ((value: typeof session) => Promise<void> | void)
          | undefined;
        await beforeInitialTask?.(session);
        return session;
      }),
      onSessionEvent: vi.fn(() => undefined),
      subscribeToOutput: vi.fn(() => () => undefined),
    };
    const runtime = {
      agentId: "agent-1",
      getService: vi.fn((name: string) =>
        name === "PTY_SERVICE" ? ptyService : undefined,
      ),
      getSetting: vi.fn((name: string) => {
        if (name === "CODING_AGENT_SANDBOX") return "off";
        if (name === "TASK_AGENT_WORKDIR_ROUTES") {
          return JSON.stringify([
            {
              workdir: "/workspace/site",
              matchAll: ["app"],
              matchAny: ["site", "open"],
              instructions: "Write static apps under data/apps/<slug>/.",
            },
          ]);
        }
        return undefined;
      }),
      getRoom: vi.fn(async () => ({ source: "discord" })),
    } as unknown as IAgentRuntime;
    const message = {
      id: "message-1",
      entityId: "agent-1",
      roomId: "room-1",
      worldId: "world-1",
      content: {
        source: "discord",
        text: "app-finalclean-1778164527888 build me a tiny polished breathing app I can open on your site.",
      },
    } as unknown as Memory;

    const result = await spawnAgentAction.handler?.(
      runtime,
      message,
      undefined,
      {
        parameters: {
          agentType: "codex",
          task: "Look up the current BTC price in USD and include btc-finalclean-1778164527888.",
          workdir: "/workspace/stale-btc-scratch",
        },
      },
      vi.fn(),
    );

    const expectedTask =
      "app-finalclean-1778164527888 build me a tiny polished breathing app I can open on your site.";
    expect(result?.success).toBe(true);
    expect(spawnOptions).toMatchObject({
      workdir: "/workspace/site",
      initialTask: expectedTask,
    });
    expect(String(spawnOptions?.memoryContent)).toContain(
      "Use existing local workspace: /workspace/site",
    );
    expect(coordinator.registerTask).toHaveBeenCalledWith(
      "pty-grounded",
      expect.objectContaining({
        originalTask: expectedTask,
        workdir: "/workspace/site",
      }),
    );
  });

  it("routes from the raw user prompt when planner wording would falsely exclude the route", async () => {
    const coordinator = {
      createTaskThread: vi.fn(async () => ({ id: "thread-1" })),
      registerTask: vi.fn(async () => undefined),
    };
    let spawnOptions: Record<string, unknown> | undefined;
    const ptyService = {
      coordinator,
      defaultApprovalPreset: "autonomous",
      resolveAgentType: vi.fn(async () => "codex"),
      checkAvailableAgents: vi.fn(async () => [
        { adapter: "codex", installed: true },
      ]),
      spawnSession: vi.fn(async (options: Record<string, unknown>) => {
        spawnOptions = options;
        const session = {
          id: "pty-route",
          name: options.name as string,
          agentType: options.agentType as string,
          workdir: options.workdir as string,
          status: "running",
          createdAt: new Date(),
          lastActivityAt: new Date(),
          metadata: options.metadata as Record<string, unknown> | undefined,
        };
        const beforeInitialTask = options.beforeInitialTask as
          | ((value: typeof session) => Promise<void> | void)
          | undefined;
        await beforeInitialTask?.(session);
        return session;
      }),
      onSessionEvent: vi.fn(() => undefined),
      subscribeToOutput: vi.fn(() => () => undefined),
    };
    const runtime = {
      agentId: "agent-1",
      getService: vi.fn((name: string) =>
        name === "PTY_SERVICE" ? ptyService : undefined,
      ),
      getSetting: vi.fn((name: string) => {
        if (name === "CODING_AGENT_SANDBOX") return "off";
        if (name === "TASK_AGENT_WORKDIR_ROUTES") {
          return JSON.stringify([
            {
              workdir: "/workspace/site",
              matchAll: ["app"],
              matchAny: ["site", "open"],
              excludeAny: ["production", "cloud"],
              instructions: "Write static apps under data/apps/<slug>/.",
            },
          ]);
        }
        return undefined;
      }),
      getRoom: vi.fn(async () => ({ source: "discord" })),
    } as unknown as IAgentRuntime;
    const message = {
      id: "message-1",
      entityId: "agent-1",
      roomId: "room-1",
      worldId: "world-1",
      content: {
        source: "discord",
        text: "app-groundcheck-1778176946 build me a tiny polished focus reset timer app I can open on your site.",
      },
    } as unknown as Memory;

    const result = await spawnAgentAction.handler?.(
      runtime,
      message,
      undefined,
      {
        parameters: {
          agentType: "codex",
          task: "Build a tiny polished focus reset timer app in this workspace. Keep it self-contained and production-ready for the Nubilio site.",
          workdir: "/workspace/planner-scratch",
        },
      },
      vi.fn(),
    );

    expect(result?.success).toBe(true);
    expect(spawnOptions).toMatchObject({
      workdir: "/workspace/site",
    });
    expect(String(spawnOptions?.initialTask)).toContain(
      "app-groundcheck-1778176946",
    );
    expect(String(spawnOptions?.memoryContent)).toContain(
      "Use existing local workspace: /workspace/site",
    );
  });
});
