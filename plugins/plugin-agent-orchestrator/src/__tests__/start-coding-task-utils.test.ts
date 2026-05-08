import { describe, expect, it } from "vitest";
import { preserveUserPromptInTask } from "../actions/start-coding-task.js";

describe("START_CODING_TASK prompt preservation", () => {
  it("keeps the full current user prompt when the planner expanded the task", () => {
    expect(
      preserveUserPromptInTask(
        "Build a tiny polished breathing timer app that can be opened on the site. Use the agent-home workspace only.",
        "build me a tiny polished breathing timer app I can open on your site. Include the URL and what you verified.",
      ),
    ).toContain("Include the URL and what you verified.");
  });

  it("does not duplicate the user prompt when the extracted task already contains it", () => {
    expect(
      preserveUserPromptInTask(
        "build me a timer app. Keep it small.",
        "build me a timer app.",
      ),
    ).toBe("build me a timer app. Keep it small.");
  });

  it("uses the current user prompt when it already contains the extracted task", () => {
    expect(
      preserveUserPromptInTask(
        "build me a tiny breathing app",
        "please build me a tiny breathing app and include what you verified",
      ),
    ).toBe(
      "please build me a tiny breathing app and include what you verified",
    );
  });
});
