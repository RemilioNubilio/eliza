import { afterEach, describe, expect, it } from "vitest";
import type { ElizaConfig } from "../config/types.eliza";
import {
  applySubscriptionProviderConfig,
  clearSubscriptionProviderConfig,
} from "./provider-switch-config";

const codexEnvKeys = [
  "PARALLAX_CODEX_MODEL_PROVIDER",
  "PARALLAX_CODEX_MODEL_PRIORITY",
  "PARALLAX_CODEX_MODEL_REASONING_EFFORT",
  "PARALLAX_CODEX_MODEL_TIMEOUT_MS",
  "PARALLAX_CODEX_MODEL",
  "PARALLAX_CODEX_MODEL_FAST",
  "PARALLAX_CODEX_MODEL_POWERFUL",
] as const;

afterEach(() => {
  for (const key of codexEnvKeys) {
    delete process.env[key];
  }
});

describe("applySubscriptionProviderConfig", () => {
  it("configures Codex subscriptions as Codex CLI model provider, not OpenAI API plugin", () => {
    const config: Partial<ElizaConfig> = {};

    applySubscriptionProviderConfig(config, "openai-codex");

    expect(config.agents?.defaults?.subscriptionProvider).toBe("openai-codex");
    expect(config.agents?.defaults?.model?.primary).toBeUndefined();
    expect(config.env).toMatchObject({
      PARALLAX_CODEX_MODEL_PROVIDER: "true",
      PARALLAX_CODEX_MODEL_PRIORITY: "50",
      PARALLAX_CODEX_MODEL_REASONING_EFFORT: "low",
      PARALLAX_CODEX_MODEL_TIMEOUT_MS: "0",
      PARALLAX_CODEX_MODEL: "gpt-5.4-mini",
      PARALLAX_CODEX_MODEL_FAST: "gpt-5.4-mini",
      PARALLAX_CODEX_MODEL_POWERFUL: "gpt-5.5",
    });
  });

  it("clears stale parent Codex model provider settings when subscription mode is cleared", () => {
    const config: Partial<ElizaConfig> = {};

    applySubscriptionProviderConfig(config, "openai-codex");
    clearSubscriptionProviderConfig(config);

    expect(config.agents?.defaults?.subscriptionProvider).toBeUndefined();
    expect(config.env).not.toMatchObject({
      PARALLAX_CODEX_MODEL_PROVIDER: expect.any(String),
      PARALLAX_CODEX_MODEL: expect.any(String),
    });
  });
});
