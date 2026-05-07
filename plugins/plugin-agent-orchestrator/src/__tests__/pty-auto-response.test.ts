import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { splitAgentSpecsParam } from "../actions/coding-task-handlers.js";
import {
  needsIsolatedCodexHome,
  resolveOrchestratorIgnorePath,
  shouldSuppressCodexExecPtyManagerEvent,
} from "../services/pty-service.js";
import {
  removeOrchestratorHooksFromSettings,
  type SessionIOContext,
  stopSession as stopSessionIO,
} from "../services/pty-session-io.js";
import { buildSpawnConfig } from "../services/pty-spawn.js";

const require = createRequire(import.meta.url);

describe("buildSpawnConfig", () => {
  it("runs Codex initial tasks through non-interactive exec mode", () => {
    const config = buildSpawnConfig(
      "session-1",
      {
        name: "codex",
        agentType: "codex",
        approvalPreset: "autonomous",
        initialTask: "write the smoke app",
      },
      "/tmp/workdir",
    );

    expect(config.adapterConfig).toMatchObject({
      interactive: false,
      initialPrompt: "write the smoke app",
      skipGitRepoCheck: true,
      approvalPreset: "autonomous",
    });
    expect(config.adapterConfig).not.toHaveProperty("addDirs");
  });

  it("passes Codex exec output file path through adapter config", () => {
    const config = buildSpawnConfig(
      "session-1",
      {
        name: "codex",
        agentType: "codex",
        approvalPreset: "autonomous",
        initialTask: "check a domain",
        metadata: {
          codexExecOutputFile: "/tmp/codex-last-message.txt",
        },
      },
      "/tmp/workdir",
    );

    expect(config.adapterConfig).toMatchObject({
      initialPrompt: "check a domain",
      outputLastMessage: "/tmp/codex-last-message.txt",
    });
  });
});

describe("Codex exec adapter", () => {
  it("launches non-interactive workers with deterministic exec flags", () => {
    const adapters = require("../../scripts/codex-exec-adapters.cjs") as {
      createAllAdapters(): Array<{
        adapterType: string;
        getArgs(config: {
          workdir?: string;
          env?: Record<string, string>;
          adapterConfig?: Record<string, unknown>;
        }): string[];
      }>;
    };
    const codex = adapters
      .createAllAdapters()
      .find((adapter) => adapter.adapterType === "codex");

    const args = codex?.getArgs({
      workdir: "/tmp/workdir",
      env: { OPENAI_MODEL: "gpt-codex-test" },
      adapterConfig: {
        initialPrompt: "build the app",
        approvalPreset: "autonomous",
        skipGitRepoCheck: true,
        outputLastMessage: "/tmp/codex-last-message.txt",
      },
    });

    expect(args).toEqual([
      "exec",
      "--ignore-rules",
      "--ephemeral",
      "-c",
      "model_reasoning_effort=xhigh",
      "-c",
      "tools.web_search=true",
      "--model",
      "gpt-codex-test",
      "--yolo",
      "-C",
      "/tmp/workdir",
      "--skip-git-repo-check",
      "--color",
      "never",
      "--output-last-message",
      "/tmp/codex-last-message.txt",
      "build the app",
    ]);
  });

  it("can disable Codex CLI sandboxing for externally sandboxed deployments", () => {
    const previousSandboxMode = process.env.CODEX_EXEC_SANDBOX_MODE;
    const previousCodingSandbox = process.env.CODING_AGENT_SANDBOX;
    process.env.CODEX_EXEC_SANDBOX_MODE = "off";
    delete process.env.CODING_AGENT_SANDBOX;

    try {
      const adapters = require("../../scripts/codex-exec-adapters.cjs") as {
        createAllAdapters(): Array<{
          adapterType: string;
          getArgs(config: {
            workdir?: string;
            env?: Record<string, string>;
            adapterConfig?: Record<string, unknown>;
          }): string[];
        }>;
      };
      const codex = adapters
        .createAllAdapters()
        .find((adapter) => adapter.adapterType === "codex");

      const args = codex?.getArgs({
        workdir: "/tmp/workdir",
        env: { OPENAI_MODEL: "gpt-codex-test" },
        adapterConfig: {
          initialPrompt: "inspect status",
          approvalPreset: "readonly",
        },
      });

      expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(args).not.toContain("read-only");
    } finally {
      if (previousSandboxMode === undefined) {
        delete process.env.CODEX_EXEC_SANDBOX_MODE;
      } else {
        process.env.CODEX_EXEC_SANDBOX_MODE = previousSandboxMode;
      }
      if (previousCodingSandbox === undefined) {
        delete process.env.CODING_AGENT_SANDBOX;
      } else {
        process.env.CODING_AGENT_SANDBOX = previousCodingSandbox;
      }
    }
  });
});

describe("Codex auth home selection", () => {
  it("uses the normal Codex home for subscription auth and isolates API-key/cloud config", () => {
    expect(needsIsolatedCodexHome()).toBe(false);
    expect(needsIsolatedCodexHome({})).toBe(false);
    expect(needsIsolatedCodexHome({ openaiKey: "sk-test" })).toBe(true);
    expect(
      needsIsolatedCodexHome({ openaiBaseUrl: "https://example.test/v1" }),
    ).toBe(true);
    expect(
      needsIsolatedCodexHome({ extraConfigToml: 'model_provider = "x"' }),
    ).toBe(true);
  });
});

describe("resolveOrchestratorIgnorePath", () => {
  it("uses local git exclude files so tracked .gitignore stays clean", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "orchestrator-ignore-test-"));
    await mkdir(join(workdir, ".git", "info"), { recursive: true });

    await expect(resolveOrchestratorIgnorePath(workdir)).resolves.toBe(
      join(workdir, ".git", "info", "exclude"),
    );
  });

  it("resolves worktree gitdir files to their local exclude file", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestrator-worktree-test-"));
    const workdir = join(root, "worktree");
    const gitdir = join(root, "main.git", "worktrees", "worktree");
    await mkdir(workdir, { recursive: true });
    await mkdir(join(gitdir, "info"), { recursive: true });
    await writeFile(join(workdir, ".git"), `gitdir: ${gitdir}\n`, "utf-8");

    await expect(resolveOrchestratorIgnorePath(workdir)).resolves.toBe(
      join(gitdir, "info", "exclude"),
    );
  });
});

describe("removeOrchestratorHooksFromSettings", () => {
  it("removes only orchestrator telemetry hooks and preserves project hooks", () => {
    const settings = {
      hooks: {
        PostToolUse: [
          {
            matcher: "Edit|Write",
            hooks: [
              { type: "command", command: ".claude/hooks/check-node-path.sh" },
              {
                type: "command",
                command: "curl http://localhost:2138/api/coding-agents/hooks",
              },
            ],
          },
        ],
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: "curl http://localhost:2138/api/coding-agents/hooks",
              },
            ],
          },
        ],
      },
    };

    expect(removeOrchestratorHooksFromSettings(settings)).toBe(true);
    expect(settings).toEqual({
      hooks: {
        PostToolUse: [
          {
            matcher: "Edit|Write",
            hooks: [
              { type: "command", command: ".claude/hooks/check-node-path.sh" },
            ],
          },
        ],
      },
    });
  });

  it("leaves settings unchanged when no orchestrator hook is present", () => {
    const settings = {
      hooks: {
        PostToolUse: [
          {
            matcher: "Edit|Write",
            hooks: [
              { type: "command", command: ".claude/hooks/check-node-path.sh" },
            ],
          },
        ],
      },
    };

    expect(removeOrchestratorHooksFromSettings(settings)).toBe(false);
    expect(settings.hooks).toHaveProperty("PostToolUse");
  });
});

describe("shouldSuppressCodexExecPtyManagerEvent", () => {
  it("suppresses pty-manager prompt noise only for Codex exec sessions", () => {
    expect(
      shouldSuppressCodexExecPtyManagerEvent({
        codexExecMode: true,
        event: "blocked",
        data: { source: "pty_manager" },
      }),
    ).toBe(true);
    expect(
      shouldSuppressCodexExecPtyManagerEvent({
        codexExecMode: true,
        event: "login_required",
        data: { source: "pty_manager" },
      }),
    ).toBe(true);
    expect(
      shouldSuppressCodexExecPtyManagerEvent({
        codexExecMode: true,
        event: "task_complete",
        data: { source: "adapter_fast_path" },
      }),
    ).toBe(false);
    expect(
      shouldSuppressCodexExecPtyManagerEvent({
        codexExecMode: false,
        event: "blocked",
        data: { source: "pty_manager" },
      }),
    ).toBe(false);
  });
});

describe("stopSession", () => {
  it("removes temporary Codex exec output directories during teardown", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "codex-output-test-"));
    await writeFile(join(outputDir, "last-message.txt"), "done", "utf-8");
    const metadata = new Map<string, Record<string, unknown>>([
      ["session-1", { codexExecOutputDir: outputDir }],
    ]);
    const ctx = {
      manager: {
        get: () => ({ id: "session-1" }),
        kill: async () => undefined,
      },
      usingBunWorker: true,
      sessionOutputBuffers: new Map(),
      taskResponseMarkers: new Map(),
      outputUnsubscribers: new Map(),
    } as unknown as SessionIOContext;

    await stopSessionIO(ctx, "session-1", metadata, new Map(), () => undefined);

    await expect(stat(outputDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(metadata.has("session-1")).toBe(false);
  });
});

describe("splitAgentSpecsParam", () => {
  it("splits planner agent specs while preserving shell pipelines", () => {
    expect(
      splitAgentSpecsParam(
        "build the app | codex:run bun test | sed -n '1,20p' log.txt",
      ),
    ).toEqual(["build the app", "codex:run bun test | sed -n '1,20p' log.txt"]);
  });

  it("does not split quoted pipes", () => {
    expect(
      splitAgentSpecsParam(
        "codex:write 'a | b' into the parser | shell:status",
      ),
    ).toEqual(["codex:write 'a | b' into the parser", "shell:status"]);
  });
});
