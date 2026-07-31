/**
 * Runtime plugin for the Showcase app. Registers a single DESCRIBE_ELIZA action
 * that hands the caller the same curated briefing the web UI renders, sourced
 * from the shared `getElizaShowcase` use case so the agent and the page can
 * never describe elizaOS differently.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  Plugin,
  State,
} from "@elizaos/core";
import { formatShowcaseText, getElizaShowcase } from "./showcase.js";

const APP_NAME = "eliza-showcase";

const describeElizaAction: Action = {
  name: "DESCRIBE_ELIZA",
  similes: ["EXPLAIN_ELIZA", "WHAT_IS_ELIZA", "ELIZA_OVERVIEW"],
  description: "Describe what elizaOS is, using the curated Showcase briefing.",
  validate: async () => true,
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const text = formatShowcaseText(getElizaShowcase());
    if (callback) {
      await callback({ text, actions: ["DESCRIBE_ELIZA"] });
    }
    return { text, success: true };
  },
  examples: [],
};

const plugin: Plugin = {
  name: APP_NAME,
  description: `Runtime plugin for the ${APP_NAME} app.`,
  actions: [describeElizaAction],
};

export default plugin;
export { describeElizaAction, plugin };
