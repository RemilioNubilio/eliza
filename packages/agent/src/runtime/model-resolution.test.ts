import { describe, expect, it } from "vitest";
import type { ElizaConfig } from "../config/types.eliza";
import { resolvePreferredProviderId } from "./model-resolution";

describe("resolvePreferredProviderId", () => {
  it("preserves Codex subscription selection for the Codex CLI model provider", () => {
    const config: Partial<ElizaConfig> = {
      agents: {
        defaults: {
          subscriptionProvider: "openai-codex",
        },
      },
    };

    expect(resolvePreferredProviderId(config as ElizaConfig)).toBe(
      "openai-codex",
    );
  });
});
