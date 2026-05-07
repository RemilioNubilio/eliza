import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type IAgentRuntime, ModelType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { taskAgentPlugin } from "../index.js";
import {
  buildCodexExecArgs,
  buildCodexExecEnv,
  buildCodexImageDescriptionPrompt,
  buildCodexModelPrompt,
  buildCodexObjectPrompt,
  codexCliImageDescriptionModel,
  codexCliObjectModel,
  codexCliTextModel,
  isCodexModelProviderEnabled,
  parseCodexImageDescriptionResult,
  parseCodexObjectResult,
  parseCodexToolCallResult,
  promptFromGenerateTextParams,
  readCodexModelProviderPriority,
  resolveCodexExecOptions,
  runCodexExec,
} from "../services/codex-model-provider.js";

function runtimeWithSettings(settings: Record<string, string>): IAgentRuntime {
  return {
    getSetting(key: string) {
      return settings[key];
    },
    registerModel: vi.fn(),
  } as IAgentRuntime;
}

describe("codex model provider", () => {
  it("uses codex exec in read-only non-interactive output-file mode", () => {
    const args = buildCodexExecArgs("/tmp/out.txt", {
      binary: "codex",
      workdir: "/workspace",
      model: "gpt-5.5",
      reasoningEffort: "low",
      timeoutMs: 1000,
      inheritOpenAIEnv: false,
    });

    expect(args).toEqual([
      "exec",
      "-s",
      "read-only",
      "-C",
      "/workspace",
      "--skip-git-repo-check",
      "--ephemeral",
      "--color",
      "never",
      "-c",
      "model_reasoning_effort=low",
      "-c",
      "tools.web_search=false",
      "--output-last-message",
      "/tmp/out.txt",
      "--model",
      "gpt-5.5",
      "-",
    ]);
  });

  it("reads Codex provider enablement from runtime settings", () => {
    const runtime = runtimeWithSettings({
      PARALLAX_CODEX_MODEL_PROVIDER: "true",
      PARALLAX_CODEX_MODEL_PRIORITY: "77",
    });

    expect(isCodexModelProviderEnabled(runtime)).toBe(true);
    expect(readCodexModelProviderPriority(runtime)).toBe(77);
  });

  it("enables the Codex provider when runtime model selection is openai-codex", () => {
    const runtime = runtimeWithSettings({
      MODEL_PROVIDER: "openai-codex",
    });

    expect(isCodexModelProviderEnabled(runtime)).toBe(true);
  });

  it("allows an explicit zero timeout for long-running Codex subscription calls", () => {
    const options = resolveCodexExecOptions(
      runtimeWithSettings({
        PARALLAX_CODEX_MODEL_TIMEOUT_MS: "0",
      }),
    );

    expect(options.timeoutMs).toBe(0);
  });

  it("registers Codex models during plugin init", () => {
    const runtime = runtimeWithSettings({
      PARALLAX_CODEX_MODEL_PROVIDER: "true",
      PARALLAX_CODEX_MODEL_PRIORITY: "77",
    });

    taskAgentPlugin.init?.({}, runtime);

    expect(runtime.registerModel).toHaveBeenCalledWith(
      ModelType.IMAGE_DESCRIPTION,
      codexCliImageDescriptionModel,
      taskAgentPlugin.name,
      77,
    );
    expect(runtime.registerModel).toHaveBeenCalledWith(
      ModelType.TEXT_LARGE,
      codexCliTextModel,
      taskAgentPlugin.name,
      77,
    );
    expect(runtime.registerModel).toHaveBeenCalledWith(
      ModelType.OBJECT_SMALL,
      codexCliObjectModel,
      taskAgentPlugin.name,
      77,
    );
  });

  it("extracts a plain prompt before falling back to messages", () => {
    expect(promptFromGenerateTextParams({ prompt: "hello" })).toBe("hello");
    expect(
      promptFromGenerateTextParams({
        prompt: "",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hi" },
        ],
      } as never),
    ).toContain("user: hi");
  });

  it("passes image files to codex exec before the stdin prompt marker", () => {
    const args = buildCodexExecArgs(
      "/tmp/out.txt",
      {
        binary: "codex",
        workdir: "/workspace",
        model: "gpt-5.4-mini",
        reasoningEffort: "low",
        timeoutMs: 1000,
        inheritOpenAIEnv: false,
      },
      true,
      { imagePaths: ["/tmp/a.png", "/tmp/b.webp"] },
    );

    expect(args.slice(-5)).toEqual([
      "--image",
      "/tmp/a.png",
      "--image",
      "/tmp/b.webp",
      "-",
    ]);
  });

  it("wraps eliza model calls with strict provider instructions", () => {
    const prompt = buildCodexModelPrompt(
      { prompt: "return <response><text>ok</text></response>" },
      "ACTION_PLANNER",
    );

    expect(prompt).toContain("non-interactive elizaOS model provider");
    expect(prompt).toContain("Model type: ACTION_PLANNER");
    expect(prompt).toContain("<eliza_prompt>");
    expect(prompt).toContain("return <response><text>ok</text></response>");
  });

  it("adds a tool-call bridge when Codex is used for native tool prompts", () => {
    const prompt = buildCodexModelPrompt(
      {
        prompt: "route the message",
        tools: [
          {
            name: "MESSAGE_HANDLER_PLAN",
            parameters: {
              type: "object",
              properties: {
                plan: { type: "object" },
                thought: { type: "string" },
              },
              required: ["plan", "thought"],
            },
            strict: true,
          },
        ],
        toolChoice: "required",
      },
      "RESPONSE_HANDLER",
    );

    expect(prompt).toContain("cannot emit provider-native tool calls");
    expect(prompt).toContain("choose an available host tool");
    expect(prompt).toContain(
      "The host requires exactly one call to MESSAGE_HANDLER_PLAN",
    );
    expect(prompt).toContain('"name":"MESSAGE_HANDLER_PLAN"');
  });

  it("converts required single-tool JSON into native tool calls", () => {
    const result = parseCodexToolCallResult(
      '{"plan":{"contexts":["simple"],"reply":"yes"},"thought":"direct"}',
      {
        prompt: "route",
        tools: [{ name: "MESSAGE_HANDLER_PLAN" }],
        toolChoice: "required",
      },
    );

    expect(result).toMatchObject({
      text: "",
      finishReason: "tool_calls",
      toolCalls: [
        {
          name: "MESSAGE_HANDLER_PLAN",
          arguments: {
            plan: { contexts: ["simple"], reply: "yes" },
            thought: "direct",
          },
          type: "function",
        },
      ],
    });
  });

  it("converts explicit Codex tool-call JSON into native tool calls", () => {
    const result = parseCodexToolCallResult(
      '{"toolCalls":[{"name":"LOOKUP","arguments":{"query":"docs"}}],"messageToUser":"checking"}',
      {
        prompt: "lookup",
        tools: [{ name: "LOOKUP" }, { name: "REPLY" }],
        toolChoice: "auto",
      },
    );

    expect(result).toMatchObject({
      text: "checking",
      finishReason: "tool_calls",
      toolCalls: [
        {
          name: "LOOKUP",
          arguments: { query: "docs" },
          type: "function",
        },
      ],
    });
  });

  it("keeps direct OpenAI runtime credentials out of Codex CLI subprocesses by default", () => {
    const env = buildCodexExecEnv(
      {
        OPENAI_API_KEY: "sk-runtime-key",
        OPENAI_BASE_URL: "https://api.example.test/v1",
        OPENAI_ORG_ID: "org_test",
        OPENAI_PROJECT: "proj_test",
        CODEX_HOME: "/tmp/codex-home",
      },
      { inheritOpenAIEnv: false },
    );

    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(env.OPENAI_ORG_ID).toBeUndefined();
    expect(env.OPENAI_PROJECT).toBeUndefined();
    expect(env.CODEX_HOME).toBe("/tmp/codex-home");
    expect(env.NO_COLOR).toBe("1");
  });

  it("can opt into inheriting OpenAI env for API-key Codex CLI setups", () => {
    const env = buildCodexExecEnv(
      {
        OPENAI_API_KEY: "sk-runtime-key",
        OPENAI_BASE_URL: "https://api.example.test/v1",
      },
      { inheritOpenAIEnv: true },
    );

    expect(env.OPENAI_API_KEY).toBe("sk-runtime-key");
    expect(env.OPENAI_BASE_URL).toBe("https://api.example.test/v1");
  });

  it("builds bounded image-description prompts and parses JSON results", () => {
    const prompt = buildCodexImageDescriptionPrompt({
      imageUrl: "https://example.test/image.png",
      prompt: "describe briefly",
    });

    expect(prompt).toContain("IMAGE_DESCRIPTION");
    expect(prompt).toContain("describe briefly");
    expect(prompt).toContain("Return JSON only");

    expect(
      parseCodexImageDescriptionResult(
        '{"title":"Red square","description":"A red square with the word RED."}',
      ),
    ).toEqual({
      title: "Red square",
      description: "A red square with the word RED.",
    });
  });

  it("builds object prompts and parses fenced JSON objects", () => {
    const prompt = buildCodexObjectPrompt(
      {
        prompt: "pick an action",
        schema: {
          type: "object",
          properties: {
            action: { type: "string" },
          },
          required: ["action"],
        },
      },
      "OBJECT_SMALL",
    );

    expect(prompt).toContain("object-generation model provider");
    expect(prompt).toContain("Model type: OBJECT_SMALL");
    expect(prompt).toContain('"action"');
    expect(parseCodexObjectResult('```json\n{"action":"REPLY"}\n```')).toEqual({
      action: "REPLY",
    });
    expect(parseCodexObjectResult('result: {"ok":true}')).toEqual({
      ok: true,
    });
  });

  it("blocks private image URLs before invoking codex", async () => {
    await expect(
      codexCliImageDescriptionModel(runtimeWithSettings({}), {
        imageUrl: "http://127.0.0.1/image.png",
        prompt: "describe this",
      }),
    ).rejects.toThrow(/private|internal|Blocked/i);
  });

  it("passes percent-encoded data URL image bytes to codex without utf8 corruption", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "codex-provider-test-"));
    try {
      const fakeCodex = path.join(tempDir, "fake-codex");
      await writeFile(
        fakeCodex,
        `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "exec" && args.includes("--help")) {
  console.log("--output-last-message");
  process.exit(0);
}
const outputFile = args[args.indexOf("--output-last-message") + 1];
const imagePath = args[args.indexOf("--image") + 1];
const description = fs.readFileSync(imagePath).subarray(0, 8).toString("hex");
fs.writeFileSync(outputFile, JSON.stringify({ title: "image", description }));
`,
        { mode: 0o755 },
      );

      await expect(
        codexCliImageDescriptionModel(
          runtimeWithSettings({
            PARALLAX_CODEX_BIN: fakeCodex,
            PARALLAX_CODEX_MODEL_WORKDIR: tempDir,
            PARALLAX_CODEX_MODEL_TIMEOUT_MS: "5000",
          }),
          {
            imageUrl: "data:image/png,%89PNG%0D%0A%1A%0A",
            prompt: "describe this",
          },
        ),
      ).resolves.toEqual({
        title: "image",
        description: "89504e470d0a1a0a",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects cleanly when codex exits before reading stdin", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "codex-provider-test-"));
    try {
      const fakeCodex = path.join(tempDir, "fake-codex");
      await writeFile(
        fakeCodex,
        `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "exec" && args.includes("--help")) {
  console.log("--output-last-message");
  process.exit(0);
}
process.exit(23);
`,
        { mode: 0o755 },
      );

      await expect(
        runCodexExec("x".repeat(2_000_000), {
          binary: fakeCodex,
          workdir: tempDir,
          reasoningEffort: "low",
          timeoutMs: 5000,
          inheritOpenAIEnv: false,
        }),
      ).rejects.toThrow(/code 23|empty model response/i);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
