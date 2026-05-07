import { describe, expect, it } from "vitest";
import {
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
  it("preserves concise captured Codex final answers with tags and verification", () => {
    const raw = [
      "app-racefix-1778174949598",
      "",
      "Built the stretch break timer here: https://nubilio.org/apps/stretch-break-timer/",
      "",
      "Changed `data/apps/stretch-break-timer/` with the app HTML/CSS/JS/meta. Verified `app.js` syntax, local route `200` for HTML/CSS/JS, and public Nubilio route `200` for HTML/CSS/JS/meta.",
    ].join("\n");

    expect(summarizeUserFacingTurnOutput(raw)).toBe(
      [
        "app-racefix-1778174949598",
        "Built the stretch break timer here: https://nubilio.org/apps/stretch-break-timer/",
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
});
