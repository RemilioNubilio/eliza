import { describe, expect, it } from "vitest";
import {
  completeDecisionWithTurnOutput,
  completionReasoningFromTurnOutput,
  isCompletingWithCapturedOutput,
  taskAgentFailureReasonFromTurnOutput,
  uniqueSummaryParts,
} from "../services/swarm-decision-loop.js";

describe("completionReasoningFromTurnOutput", () => {
  it("uses the subagent output instead of internal assessor diagnostics", () => {
    expect(
      completionReasoningFromTurnOutput(
        "BTC is $101,234.56 USD on Coinbase as of 2026-05-07 10:55 UTC.",
      ),
    ).toBe("BTC is $101,234.56 USD on Coinbase as of 2026-05-07 10:55 UTC.");
  });

  it("keeps artifact summaries when the task produced a PR", () => {
    expect(
      completionReasoningFromTurnOutput(
        "Done\nhttps://github.com/elizaOS/eliza/pull/7459\n",
      ),
    ).toBe("https://github.com/elizaOS/eliza/pull/7459");
  });

  it("extracts public app URLs from ordinary completion text", () => {
    expect(
      completionReasoningFromTurnOutput(
        "Built the app at https://nubilio.org/apps/breath-orbit/ and verified it returns 200.",
      ),
    ).toBe("https://nubilio.org/apps/breath-orbit/");
  });

  it("does not surface raw patch/source dumps as the final chat answer", () => {
    expect(
      completionReasoningFromTurnOutput(`+ if (state.phase >= phases.length) state.phase = 0;
+ const phase = phases[state.phase];
+ const duration = settings[phase.key];
+ const progress = Math.min(1, Math.max(0, state.elapsed / duration));
+ const remaining = Math.max(0, Math.ceil(duration - state.elapsed));
+ orbit.style.setProperty("--progress", progress.toFixed(4));
+ orbit.style.setProperty("--breath-scale", phase.scale(progress).toFixed(4));
+ phaseName.textContent = state.done ? "Complete" : phase.label;
+ chips.forEach((chip) => {
+   chip.classList.toggle("active", chip.dataset.chip === phase.key);
+ });`),
    ).toBe(
      "Task agent completed but did not produce a user-facing final summary.",
    );
  });

  it("preserves a Codex final answer block with verification details", () => {
    expect(
      completionReasoningFromTurnOutput(`exec
/bin/bash -lc 'git diff'
 succeeded in 0ms:
diff --git a/app.js b/app.js
+ const noisy = true;

codex
Built the static breathing timer at \`data/apps/breath-ring/\`.

URL: https://nubilio.org/apps/breath-ring/

Verified:
- \`node --check data/apps/breath-ring/app.js\`
- public URL returned \`200\`

diff --git a/data/apps/breath-ring/app.js b/data/apps/breath-ring/app.js
+ const after = true;
tokens used
79,074`),
    ).toBe(`Built the static breathing timer at \`data/apps/breath-ring/\`.

URL: https://nubilio.org/apps/breath-ring/

Verified:
- \`node --check data/apps/breath-ring/app.js\`
- public URL returned \`200\``);
  });

  it("keeps structured URL and verification blocks without duplicating URLs", () => {
    expect(
      completionReasoningFromTurnOutput(`Built the static breathing timer at \`data/apps/breath-ring/\`.

URL: https://nubilio.org/apps/breath-ring/

Verified:
- \`node --check data/apps/breath-ring/app.js\`
- public URL returned \`200\`

https://nubilio.org/apps/breath-ring/`),
    ).toBe(`Built the static breathing timer at \`data/apps/breath-ring/\`.

URL: https://nubilio.org/apps/breath-ring/

Verified:
- \`node --check data/apps/breath-ring/app.js\`
- public URL returned \`200\``);
  });

  it("deduplicates labeled and bare URL fallback summaries", () => {
    expect(
      completionReasoningFromTurnOutput(`URL: https://nubilio.org/apps/breath-ring/
https://nubilio.org/apps/breath-ring/`),
    ).toBe("URL: https://nubilio.org/apps/breath-ring/");
  });
});

describe("taskAgentFailureReasonFromTurnOutput", () => {
  it("summarizes Codex auth failures without dumping raw terminal output", () => {
    expect(
      taskAgentFailureReasonFromTurnOutput(
        "failed to connect to websocket: HTTP error: 401 Unauthorized\nSet OPENAI_API_KEY environment variable or provide credentials in adapterConfig",
      ),
    ).toBe(
      "Task agent failed to authenticate with Codex/OpenAI before completing.",
    );
  });
});

describe("completeDecisionWithTurnOutput", () => {
  it("uses the subagent final output for complete decisions", () => {
    expect(
      completeDecisionWithTurnOutput(
        {
          action: "complete",
          reasoning: "Accept the agent's reported value and source as final.",
          keyDecision: "Accept the agent's reported value and source as final.",
        },
        "btc-parserfix-123 BTC is $81,000 USD from Coinbase at 2026-05-07T12:09:23Z.",
      ),
    ).toMatchObject({
      action: "complete",
      reasoning:
        "btc-parserfix-123 BTC is $81,000 USD from Coinbase at 2026-05-07T12:09:23Z.",
      keyDecision:
        "btc-parserfix-123 BTC is $81,000 USD from Coinbase at 2026-05-07T12:09:23Z.",
    });
  });

  it("does not rewrite non-complete decisions", () => {
    const decision = {
      action: "respond" as const,
      response: "continue",
      reasoning: "Needs another turn.",
    };

    expect(completeDecisionWithTurnOutput(decision, "final output")).toBe(
      decision,
    );
  });
});

describe("completion synthesis guards", () => {
  it("treats tool_running with captured output as completion in progress", () => {
    expect(
      isCompletingWithCapturedOutput({
        status: "tool_running",
        completionSummary: "final answer",
      }),
    ).toBe(true);
    expect(
      isCompletingWithCapturedOutput({
        status: "tool_running",
        completionSummary: "   ",
      }),
    ).toBe(false);
    expect(
      isCompletingWithCapturedOutput({
        status: "active",
        completionSummary: "final answer",
      }),
    ).toBe(false);
  });

  it("deduplicates identical completion summaries", () => {
    expect(uniqueSummaryParts(["BTC $81k", " BTC   $81k ", "other"])).toEqual([
      "BTC $81k",
      "other",
    ]);
  });
});
