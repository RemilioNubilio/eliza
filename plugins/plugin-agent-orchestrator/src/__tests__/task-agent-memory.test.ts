import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readConfiguredTaskAgentMemory } from "../services/task-agent-memory.js";

function runtimeWithSettings(settings: Record<string, string>) {
  return {
    getSetting(key: string) {
      return settings[key];
    },
  } as never;
}

describe("task-agent memory", () => {
  it("loads an operator-configured memory file into subagent context", async () => {
    const dir = await mkdtemp(join(tmpdir(), "task-agent-memory-"));
    try {
      const file = join(dir, "memory.md");
      await writeFile(file, "Use /repo/app for local app work.\n", "utf8");

      await expect(
        readConfiguredTaskAgentMemory(
          runtimeWithSettings({ TASK_AGENT_MEMORY_FILE: file }),
        ),
      ).resolves.toBe(
        "# Deployment Task-Agent Memory\n\nUse /repo/app for local app work.",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("honors the configured maximum size", async () => {
    const dir = await mkdtemp(join(tmpdir(), "task-agent-memory-"));
    try {
      const file = join(dir, "memory.md");
      await writeFile(file, "abcdef", "utf8");

      await expect(
        readConfiguredTaskAgentMemory(
          runtimeWithSettings({
            TASK_AGENT_MEMORY_FILE: file,
            TASK_AGENT_MEMORY_MAX_CHARS: "3",
          }),
        ),
      ).resolves.toBe(
        "# Deployment Task-Agent Memory\n\nabc\n\n[task-agent memory truncated at 3 characters]",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
