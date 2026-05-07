import { describe, expect, it } from "vitest";
import {
  resolveRequestedApprovalPreset,
  userTextRequestsApprovalPreset,
} from "../services/approval-preset.js";

describe("approval preset routing", () => {
  it("does not honor planner-supplied readonly unless the user asked for read-only work", () => {
    expect(
      resolveRequestedApprovalPreset({
        parameterPreset: "readonly",
        userText: "what is the current BTC price in USD?",
      }),
    ).toBeUndefined();

    expect(
      resolveRequestedApprovalPreset({
        parameterPreset: "readonly",
        userText: "audit this repo read-only and do not write files",
      }),
    ).toBe("readonly");
  });

  it("honors structured content presets and explicit text requests", () => {
    expect(
      resolveRequestedApprovalPreset({
        contentPreset: "permissive",
        parameterPreset: "readonly",
        userText: "run this task",
      }),
    ).toBe("permissive");

    expect(
      userTextRequestsApprovalPreset(
        "run the task with full tool access and no approvals",
        "autonomous",
      ),
    ).toBe(true);
  });
});
