import { describe, expect, it } from "vitest";
import { applyPluginAutoEnable } from "./plugin-auto-enable";
import type { ElizaConfig } from "./types.eliza";

describe("applyPluginAutoEnable subscription providers", () => {
  it("does not force-enable direct OpenAI runtime plugin for Codex subscriptions", () => {
    const result = applyPluginAutoEnable({
      config: {
        agents: {
          defaults: {
            subscriptionProvider: "openai-codex",
          },
        },
      } as Partial<ElizaConfig>,
      env: {},
    });

    expect(result.config.plugins?.allow ?? []).not.toContain(
      "@elizaos/plugin-openai",
    );
    expect(result.config.plugins?.entries?.openai?.enabled).not.toBe(true);
  });

  it("still enables direct OpenAI runtime plugin when a real API key exists", () => {
    const result = applyPluginAutoEnable({
      config: {} as Partial<ElizaConfig>,
      env: {
        OPENAI_API_KEY: "sk-direct-openai-key",
      } as NodeJS.ProcessEnv,
    });

    expect(result.config.plugins?.allow ?? []).toContain(
      "@elizaos/plugin-openai",
    );
  });
});
