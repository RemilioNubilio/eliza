import { describe, expect, it } from "vitest";
import {
  closeUnbalancedMarkdownFences,
  extractCompletionSummary,
  summarizeUserFacingTurnOutput,
} from "../services/ansi-utils.js";

describe("extractCompletionSummary", () => {
  it("uses the final assistant block instead of app guidance from the prompt transcript", () => {
    const raw = [
      "user",
      "Build apps with Eliza Cloud when appropriate.",
      "Want me to buy one of these for you?",
      "appId: <APP_ID>",
      "custom domain options (one-time, paid from your cloud credits):",
      "monetization: enabled for app chat inference",
      "auth: eliza cloud oauth",
      "https://nubilio.org",
      "https://cloud.nubs.site",
      "codex",
      "disk-runtimeactions-1778170115195 `/dev/sda1`: 95% used, 22G free. Urgent: cleanup should happen now.",
      "tokens used 1234",
    ].join("\n");

    expect(extractCompletionSummary(raw)).toBe(
      "disk-runtimeactions-1778170115195 `/dev/sda1`: 95% used, 22G free. Urgent: cleanup should happen now.",
    );
  });

  it("keeps normal app result summaries from the final assistant block", () => {
    const raw = [
      "codex",
      "Built Pocket Breath.",
      "URL: https://nubilio.org/apps/pocket-breath/",
      "Verified: public 200 OK and controls work.",
      "tokens used 1234",
    ].join("\n");

    expect(extractCompletionSummary(raw)).toBe(
      [
        "Built Pocket Breath.",
        "URL: https://nubilio.org/apps/pocket-breath/",
        "Verified: public 200 OK and controls work.",
      ].join("\n"),
    );
  });

  it("keeps the whole app result block when verification follows changed files", () => {
    const raw = [
      "Built the static app at:",
      "",
      "URL: https://nubilio.org/apps/tiny-stretch-timer/",
      "",
      "Files changed:",
      "- `data/apps/tiny-stretch-timer/index.html`",
      "- `data/apps/tiny-stretch-timer/style.css`",
      "- `data/apps/tiny-stretch-timer/app.js`",
      "- `data/apps/tiny-stretch-timer/meta.json`",
      "",
      "Verified:",
      "- `node --check` passed for `app.js`",
      "- Local route returned `200 OK`",
      "- Public route returned `200 OK`",
      "",
      "Browser automation was not available: Chromium is not installed.",
      "",
      "Tag: app-currentargs-1778184418",
    ].join("\n");

    expect(extractCompletionSummary(raw)).toBe(
      [
        "Built the static app at:",
        "",
        "URL: https://nubilio.org/apps/tiny-stretch-timer/",
        "",
        "Files changed:",
        "- `data/apps/tiny-stretch-timer/index.html`",
        "- `data/apps/tiny-stretch-timer/style.css`",
        "- `data/apps/tiny-stretch-timer/app.js`",
        "- `data/apps/tiny-stretch-timer/meta.json`",
        "",
        "Verified:",
        "- `node --check` passed for `app.js`",
        "- Local route returned `200 OK`",
        "- Public route returned `200 OK`",
        "",
        "Browser automation was not available: Chromium is not installed.",
        "",
        "Tag: app-currentargs-1778184418",
      ].join("\n"),
    );
  });

  it("drops a bare duplicate URL when the final block also has a sourced line", () => {
    const raw = [
      "codex",
      "https://api.coinbase.com/v2/prices/BTC-USD/spot",
      "btc-final BTC/USD: $79,821.015",
      "Source: Coinbase Spot Price API https://api.coinbase.com/v2/prices/BTC-USD/spot",
      "UTC timestamp: 2026-05-07T17:11:49.779Z",
      "tokens used 1234",
    ].join("\n");

    expect(extractCompletionSummary(raw)).toBe(
      [
        "btc-final BTC/USD: $79,821.015",
        "Source: Coinbase Spot Price API https://api.coinbase.com/v2/prices/BTC-USD/spot",
        "UTC timestamp: 2026-05-07T17:11:49.779Z",
      ].join("\n"),
    );
  });
});

describe("summarizeUserFacingTurnOutput", () => {
  it("preserves concise captured Codex final answers with verification", () => {
    const raw = [
      "transient correlation id",
      "",
      "Built the stretch break timer here: https://nubilio.org/apps/stretch-break-timer/",
      "",
      "Changed `data/apps/stretch-break-timer/` with the app HTML/CSS/JS/meta. Verified `app.js` syntax, local route `200` for HTML/CSS/JS, and public Nubilio route `200` for HTML/CSS/JS/meta.",
    ].join("\n");

    expect(summarizeUserFacingTurnOutput(raw)).toBe(
      [
        "Built the stretch break timer here: https://nubilio.org/apps/stretch-break-timer/",
        "",
        "Changed `data/apps/stretch-break-timer/` with the app HTML/CSS/JS/meta. Verified `app.js` syntax, local route `200` for HTML/CSS/JS, and public Nubilio route `200` for HTML/CSS/JS/meta.",
      ].join("\n"),
    );
  });

  it("dedupes a bare URL from concise captured answers when a sourced line has the same URL", () => {
    const raw = [
      "https://api.coinbase.com/v2/prices/BTC-USD/spot",
      "btc-final BTC/USD: $79,821.015",
      "Source: Coinbase Spot Price API https://api.coinbase.com/v2/prices/BTC-USD/spot",
      "UTC timestamp: 2026-05-07T17:11:49.779Z",
    ].join("\n");

    expect(summarizeUserFacingTurnOutput(raw)).toBe(
      [
        "btc-final BTC/USD: $79,821.015",
        "Source: Coinbase Spot Price API https://api.coinbase.com/v2/prices/BTC-USD/spot",
        "UTC timestamp: 2026-05-07T17:11:49.779Z",
      ].join("\n"),
    );
  });

  it("unwraps inline-code URLs so Discord can autolink them", () => {
    const raw = [
      "Branch: `feature/example`",
      "Open PR: `#123`",
      "`https://github.com/example/project/pull/123`",
      "Remotes:",
      "- `origin`: `https://github.com/example/project.git`",
    ].join("\n");

    expect(summarizeUserFacingTurnOutput(raw)).toBe(
      [
        "Branch: `feature/example`",
        "Open PR: `#123`",
        "https://github.com/example/project/pull/123",
        "Remotes:",
        "- `origin`: https://github.com/example/project.git",
      ].join("\n"),
    );
  });

  it("preserves generic structured summaries by shape instead of task keywords", () => {
    const raw = [
      "Result:",
      "Location: `https://example.com/reports/status`",
      "Checks:",
      "- first route returned `200`",
      "- second route returned `200`",
      "Outcome: ready for review.",
    ].join("\n");

    expect(summarizeUserFacingTurnOutput(raw)).toBe(
      [
        "Result:",
        "Location: https://example.com/reports/status",
        "Checks:",
        "- first route returned `200`",
        "- second route returned `200`",
        "Outcome: ready for review.",
      ].join("\n"),
    );
  });

  it("collapses duplicated status summaries while keeping the richer repeated line", () => {
    const raw = [
      "Branch: `remilio/local-eliza-link-precedence-20260507` at `46191f5c9`",
      "Worktree: clean.",
      "Upstream/tracking: `origin/develop`. Ahead/behind relative to `origin/develop`: `ahead 1, behind 1`.",
      "Open PR: `#2119` open, `RemilioNubilio:remilio/local-eliza-link-precedence-20260507` `develop`",
      "`https://github.com/milady-ai/milady/pull/2119`",
      "Remotes:",
      "- `origin`: `https://github.com/milady-ai/milady.git`",
      "- `remilio`: `https://github.com/RemilioNubilio/milady.git`",
      "No files changed.",
      "",
      "Branch: `remilio/local-eliza-link-precedence-20260507` at `46191f5c9`",
      "",
      "Worktree: clean.",
      "",
      "Upstream/tracking: `origin/develop`. Ahead/behind relative to `origin/develop`: `ahead 1, behind 1`.",
      "",
      "Open PR: `#2119` open, `RemilioNubilio:remilio/local-eliza-link-precedence-20260507` → `develop`",
      "`https://github.com/milady-ai/milady/pull/2119`",
      "",
      "Remotes:",
      "- `origin`: `https://github.com/milady-ai/milady.git`",
      "- `remilio`: `https://github.com/RemilioNubilio/milady.git`",
      "",
      "No files changed.",
    ].join("\n");

    expect(summarizeUserFacingTurnOutput(raw)).toBe(
      [
        "Branch: `remilio/local-eliza-link-precedence-20260507` at `46191f5c9`",
        "Worktree: clean.",
        "Upstream/tracking: `origin/develop`. Ahead/behind relative to `origin/develop`: `ahead 1, behind 1`.",
        "Open PR: `#2119` open, `RemilioNubilio:remilio/local-eliza-link-precedence-20260507` `develop`",
        "https://github.com/milady-ai/milady/pull/2119",
        "Remotes:",
        "- `origin`: https://github.com/milady-ai/milady.git",
        "- `remilio`: https://github.com/RemilioNubilio/milady.git",
        "No files changed.",
      ].join("\n"),
    );
  });
});

describe("closeUnbalancedMarkdownFences", () => {
  it("closes an unfinished fenced block before chat delivery", () => {
    expect(
      closeUnbalancedMarkdownFences(
        [
          "disk-fresh Disk check: urgent.",
          "`df -h` source:",
          "```text",
          "/dev/sda1 387G 372G 15G 97% /",
        ].join("\n"),
      ),
    ).toBe(
      [
        "disk-fresh Disk check: urgent.",
        "`df -h` source:",
        "```text",
        "/dev/sda1 387G 372G 15G 97% /",
        "```",
      ].join("\n"),
    );
  });

  it("repairs nested fenced openers with info strings", () => {
    expect(
      closeUnbalancedMarkdownFences(
        [
          "Branch: clean.",
          "```text",
          "## branch...origin/develop",
          "Remotes:",
          "```text",
          "origin https://github.com/example/repo.git",
        ].join("\n"),
      ),
    ).toBe(
      [
        "Branch: clean.",
        "```text",
        "## branch...origin/develop",
        "Remotes:",
        "```",
        "```text",
        "origin https://github.com/example/repo.git",
        "```",
      ].join("\n"),
    );
  });
});
