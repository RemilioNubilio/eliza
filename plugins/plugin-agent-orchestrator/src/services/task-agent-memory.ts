import { readFile } from "node:fs/promises";
import type { IAgentRuntime } from "@elizaos/core";
import { readConfigEnvKey } from "./config-env.js";

const MEMORY_FILE_KEYS = [
  "PARALLAX_TASK_AGENT_MEMORY_FILE",
  "TASK_AGENT_MEMORY_FILE",
] as const;
const MEMORY_MAX_CHARS_KEYS = [
  "PARALLAX_TASK_AGENT_MEMORY_MAX_CHARS",
  "TASK_AGENT_MEMORY_MAX_CHARS",
] as const;
const DEFAULT_MEMORY_MAX_CHARS = 60_000;

function readSetting(runtime: IAgentRuntime, key: string): string | undefined {
  const value = runtime.getSetting?.(key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readFirstConfiguredValue(
  runtime: IAgentRuntime,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = readConfigEnvKey(key) ?? readSetting(runtime, key);
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function parseMaxChars(value: string | undefined): number {
  if (!value) return DEFAULT_MEMORY_MAX_CHARS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_MEMORY_MAX_CHARS;
  }
  return Math.floor(parsed);
}

export function resolveTaskAgentMemoryFile(
  runtime: IAgentRuntime,
): string | undefined {
  const configured = readFirstConfiguredValue(runtime, MEMORY_FILE_KEYS);
  if (!configured || configured.includes("\0")) {
    return undefined;
  }
  return configured;
}

export async function readConfiguredTaskAgentMemory(
  runtime: IAgentRuntime,
): Promise<string | undefined> {
  const file = resolveTaskAgentMemoryFile(runtime);
  if (!file) return undefined;

  const maxChars = parseMaxChars(
    readFirstConfiguredValue(runtime, MEMORY_MAX_CHARS_KEYS),
  );
  const raw = (await readFile(file, "utf8")).trim();
  if (!raw) return undefined;

  const body =
    raw.length > maxChars
      ? `${raw.slice(0, maxChars).trimEnd()}\n\n[task-agent memory truncated at ${maxChars} characters]`
      : raw;
  return `# Deployment Task-Agent Memory\n\n${body}`;
}
