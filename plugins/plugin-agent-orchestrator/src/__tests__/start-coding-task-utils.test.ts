import { describe, expect, it } from "vitest";
import { preserveUserPromptInTask } from "../actions/start-coding-task.js";

describe("START_CODING_TASK prompt preservation", () => {
  it("keeps exact user tags even when the planner expanded the task", () => {
    expect(
      preserveUserPromptInTask(
        "Build a tiny polished breathing timer app that can be opened on the site. Use the agent-home workspace only.",
        "app-routecfg-123 build me a tiny polished breathing timer app I can open on your site. Include the URL and what you verified.",
      ),
    ).toContain("app-routecfg-123");
  });

  it("does not duplicate the user prompt when the extracted task already contains it", () => {
    expect(
      preserveUserPromptInTask(
        "app-routecfg-123 build me a timer app. Keep it small.",
        "app-routecfg-123 build me a timer app.",
      ),
    ).toBe("app-routecfg-123 build me a timer app. Keep it small.");
  });

  it("trusts the current user prompt when the planner reuses a stale request token", () => {
    expect(
      preserveUserPromptInTask(
        "Look up the current BTC price in USD and include btc-finalclean-1778164527888.",
        "app-finalclean-1778164527888 build me a tiny polished breathing app I can open on your site.",
      ),
    ).toBe(
      "app-finalclean-1778164527888 build me a tiny polished breathing app I can open on your site.",
    );
  });
});
