import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentCredentials } from "../services/agent-credentials.js";

const originalStateDir = process.env.ELIZA_STATE_DIR;
const originalNamespace = process.env.ELIZA_NAMESPACE;
const tempDirs: string[] = [];

function runtimeWithSettings(settings: Record<string, string | undefined>) {
  return {
    getSetting(key: string) {
      return settings[key];
    },
  } as Parameters<typeof buildAgentCredentials>[0];
}

async function writeConfig(env: Record<string, string>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "agent-credentials-test-"));
  tempDirs.push(dir);
  process.env.ELIZA_STATE_DIR = dir;
  delete process.env.ELIZA_NAMESPACE;
  await writeFile(join(dir, "eliza.json"), JSON.stringify({ env }), "utf8");
}

afterEach(async () => {
  if (originalStateDir === undefined) {
    delete process.env.ELIZA_STATE_DIR;
  } else {
    process.env.ELIZA_STATE_DIR = originalStateDir;
  }
  if (originalNamespace === undefined) {
    delete process.env.ELIZA_NAMESPACE;
  } else {
    process.env.ELIZA_NAMESPACE = originalNamespace;
  }
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("buildAgentCredentials", () => {
  it("keeps OpenAI runtime keys out of subscription-mode Codex credentials", () => {
    const credentials = buildAgentCredentials(
      runtimeWithSettings({
        OPENAI_API_KEY: "not-a-codex-subscription-token",
        OPENAI_BASE_URL: "https://api.example.test/v1",
      }),
    );

    expect(credentials.openaiKey).toBeUndefined();
    expect(credentials.openaiBaseUrl).toBeUndefined();
  });

  it("uses OpenAI API credentials when direct provider mode is selected", async () => {
    await writeConfig({ PARALLAX_LLM_PROVIDER: "direct" });

    const credentials = buildAgentCredentials(
      runtimeWithSettings({
        OPENAI_API_KEY: "sk-runtime-key",
        OPENAI_BASE_URL: "https://api.example.test/v1",
      }),
    );

    expect(credentials.openaiKey).toBe("sk-runtime-key");
    expect(credentials.openaiBaseUrl).toBe("https://api.example.test/v1");
  });
});
