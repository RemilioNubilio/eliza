import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  fetchRemoteMedia,
  type GenerateTextParams,
  type GenerateTextResult,
  type IAgentRuntime,
  type ImageDescriptionParams,
  type ImageDescriptionResult,
  type LookupFn,
  logger,
  type ObjectGenerationParams,
  type ToolCall,
  type ToolChoice,
  type ToolDefinition,
} from "@elizaos/core";
import { readConfigEnvKey } from "./config-env.js";

const TRUE_VALUE = /^(1|true|yes|on)$/i;
const FALSE_VALUE = /^(0|false|no|off)$/i;
const DEFAULT_TIMEOUT_MS = 105_000;
const MAX_CAPTURE_CHARS = 16_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 5_000;
const OUTPUT_LAST_MESSAGE_HELP_TIMEOUT_MS = 5_000;
const outputLastMessageSupportCache = new Map<string, Promise<boolean>>();

type CodexExecInput = {
  imagePaths?: string[];
};

export type CodexExecOptions = {
  binary: string;
  workdir: string;
  model?: string;
  reasoningEffort: string;
  timeoutMs: number;
  inheritOpenAIEnv: boolean;
};

function readSetting(
  runtime: IAgentRuntime | undefined,
  key: string,
): string | undefined {
  const runtimeValue = runtime?.getSetting(key);
  if (typeof runtimeValue === "string" && runtimeValue.trim()) {
    return runtimeValue.trim();
  }
  const configValue = readConfigEnvKey(key);
  if (typeof configValue === "string" && configValue.trim()) {
    return configValue.trim();
  }
  const envValue = process.env[key];
  return typeof envValue === "string" && envValue.trim()
    ? envValue.trim()
    : undefined;
}

export function isCodexModelProviderEnabled(runtime?: IAgentRuntime): boolean {
  const raw = readSetting(runtime, "PARALLAX_CODEX_MODEL_PROVIDER");
  if (raw && TRUE_VALUE.test(raw)) return true;
  if (raw && FALSE_VALUE.test(raw)) return false;
  const selectedProvider = readSetting(runtime, "MODEL_PROVIDER")
    ?.trim()
    .toLowerCase();
  return (
    selectedProvider === "openai-codex" ||
    selectedProvider === "openai-subscription" ||
    selectedProvider === "codex"
  );
}

export function readCodexModelProviderPriority(
  runtime?: IAgentRuntime,
): number {
  const raw = readSetting(runtime, "PARALLAX_CODEX_MODEL_PRIORITY");
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 50;
}

export function resolveCodexExecOptions(
  runtime?: IAgentRuntime,
): CodexExecOptions {
  const timeoutRaw = readSetting(runtime, "PARALLAX_CODEX_MODEL_TIMEOUT_MS");
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : DEFAULT_TIMEOUT_MS;
  const inheritOpenAIEnvRaw = readSetting(
    runtime,
    "PARALLAX_CODEX_INHERIT_OPENAI_ENV",
  );
  return {
    binary: readSetting(runtime, "PARALLAX_CODEX_BIN") ?? "codex",
    workdir:
      readSetting(runtime, "PARALLAX_CODEX_MODEL_WORKDIR") ?? process.cwd(),
    model:
      readSetting(runtime, "PARALLAX_CODEX_MODEL") ??
      readSetting(runtime, "PARALLAX_CODEX_EXEC_MODEL"),
    reasoningEffort:
      readSetting(runtime, "PARALLAX_CODEX_MODEL_REASONING_EFFORT") ?? "low",
    timeoutMs:
      Number.isFinite(timeoutMs) && timeoutMs >= 0
        ? Math.floor(timeoutMs)
        : DEFAULT_TIMEOUT_MS,
    inheritOpenAIEnv: inheritOpenAIEnvRaw
      ? TRUE_VALUE.test(inheritOpenAIEnvRaw)
      : false,
  };
}

export function buildCodexExecArgs(
  outputFile: string,
  options: CodexExecOptions,
  useOutputLastMessage = true,
  input: CodexExecInput = {},
): string[] {
  const args = [
    "exec",
    "-s",
    "read-only",
    "-C",
    options.workdir,
    "--skip-git-repo-check",
    "--ephemeral",
    "--color",
    "never",
    "-c",
    `model_reasoning_effort=${options.reasoningEffort}`,
  ];
  if (useOutputLastMessage) {
    args.push("--output-last-message", outputFile);
  }
  if (options.model) {
    args.push("--model", options.model);
  }
  for (const imagePath of input.imagePaths ?? []) {
    args.push("--image", imagePath);
  }
  args.push("-");
  return args;
}

export function promptFromGenerateTextParams(
  params: GenerateTextParams,
): string {
  if (typeof params.prompt === "string" && params.prompt.length > 0) {
    return params.prompt;
  }
  const maybeMessages = (params as unknown as { messages?: unknown }).messages;
  if (Array.isArray(maybeMessages)) {
    return maybeMessages
      .map((message) => {
        if (!message || typeof message !== "object") return String(message);
        const record = message as Record<string, unknown>;
        const role = typeof record.role === "string" ? record.role : "message";
        const content =
          typeof record.content === "string"
            ? record.content
            : JSON.stringify(record.content);
        return `${role}: ${content}`;
      })
      .join("\n\n");
  }
  return JSON.stringify(params);
}

function toolChoiceName(choice: ToolChoice | undefined): string | undefined {
  if (
    !choice ||
    choice === "auto" ||
    choice === "none" ||
    choice === "required"
  ) {
    return undefined;
  }
  if (typeof choice === "object") {
    const record = choice as Record<string, unknown>;
    if (typeof record.name === "string") {
      return record.name;
    }
    const fn = record.function;
    if (fn && typeof fn === "object" && !Array.isArray(fn)) {
      const functionName = (fn as Record<string, unknown>).name;
      return typeof functionName === "string" ? functionName : undefined;
    }
  }
  return undefined;
}

function requiredSingleTool(
  params: GenerateTextParams,
): ToolDefinition | undefined {
  const tools = Array.isArray(params.tools) ? params.tools : [];
  const selectedName = toolChoiceName(params.toolChoice);
  if (selectedName) {
    return tools.find((tool) => tool.name === selectedName);
  }
  if (params.toolChoice === "required" && tools.length === 1) {
    return tools[0];
  }
  return undefined;
}

function buildCodexToolBridgeInstructions(params: GenerateTextParams): string {
  const tools = Array.isArray(params.tools) ? params.tools : [];
  if (tools.length === 0) {
    return "";
  }
  const toolSummary = tools
    .map((tool) =>
      JSON.stringify({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: tool.strict,
      }),
    )
    .join("\n");
  const selectedTool = requiredSingleTool(params);
  const selectedInstruction = selectedTool
    ? `The host requires exactly one call to ${selectedTool.name}. Return only that tool's arguments as a JSON object matching its parameters.`
    : 'If a tool is needed, return JSON only in this shape: {"toolCalls":[{"name":"TOOL_NAME","arguments":{...}}],"messageToUser":"optional user-facing text"}.';

  return [
    "The host supplied native tool definitions, but this Codex CLI subprocess cannot emit provider-native tool calls.",
    selectedInstruction,
    "Do not answer in natural language when a tool call is required. Do not include markdown fences or commentary around the JSON.",
    "Available tools:",
    toolSummary,
  ].join("\n");
}

export function buildCodexModelPrompt(
  params: GenerateTextParams,
  modelType?: string,
): string {
  const responseFormat =
    typeof params.responseFormat === "string"
      ? params.responseFormat
      : params.responseFormat?.type;
  const formatHint = responseFormat
    ? `The requested response format is ${responseFormat}.`
    : "Use the response format requested by the prompt.";
  return [
    "You are running as a non-interactive elizaOS model provider.",
    "Use the prompt below as the complete task. Do not inspect local files or run shell commands unless the prompt explicitly asks for local filesystem facts.",
    "Return only the final model output. No labels, no status text, no markdown fences unless the prompt explicitly asks for markdown.",
    modelType ? `Model type: ${modelType}.` : "",
    formatHint,
    buildCodexToolBridgeInstructions(params),
    "",
    "<eliza_prompt>",
    promptFromGenerateTextParams(params),
    "</eliza_prompt>",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildCodexImageDescriptionPrompt(
  params: ImageDescriptionParams | string,
): string {
  const prompt =
    typeof params === "string"
      ? "Describe this image accurately."
      : params.prompt?.trim() || "Describe this image accurately.";
  return [
    "You are running as a non-interactive elizaOS IMAGE_DESCRIPTION model provider.",
    "Use only the attached image content and the user prompt below.",
    "Do not run shell commands, inspect files, mention file paths, or include implementation details.",
    'Return JSON only, with this shape: {"title":"short title","description":"natural language description"}.',
    "",
    "<user_prompt>",
    prompt,
    "</user_prompt>",
  ].join("\n");
}

export function buildCodexObjectPrompt(
  params: ObjectGenerationParams,
  modelType?: string,
): string {
  const schema = params.schema
    ? JSON.stringify(params.schema, null, 2)
    : "No JSON schema was provided. Return the most appropriate JSON object for the prompt.";
  const enumValues =
    Array.isArray(params.enumValues) && params.enumValues.length > 0
      ? `Allowed enum values: ${params.enumValues.join(", ")}.`
      : "";
  return [
    "You are running as a non-interactive elizaOS object-generation model provider.",
    "Return JSON only. Do not include markdown fences, labels, commentary, or surrounding text.",
    "The top-level response must be a JSON object.",
    modelType ? `Model type: ${modelType}.` : "",
    enumValues,
    "",
    "<json_schema>",
    schema,
    "</json_schema>",
    "",
    "<eliza_prompt>",
    params.prompt,
    "</eliza_prompt>",
  ]
    .filter(Boolean)
    .join("\n");
}

function stripMarkdownJsonFence(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function extractJsonObjectText(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

export function parseCodexObjectResult(text: string): Record<string, unknown> {
  const cleaned = stripMarkdownJsonFence(text);
  const candidates = [cleaned, extractJsonObjectText(cleaned)].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error("Codex object model returned non-JSON output");
}

function parseToolCallArguments(
  value: unknown,
): Record<string, unknown> | string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Keep opaque string arguments for providers/tools that accept them.
    }
    return trimmed;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function makeToolCall(
  name: string,
  args: Record<string, unknown> | string,
  id?: unknown,
): ToolCall {
  return {
    id:
      typeof id === "string" && id.trim()
        ? id.trim()
        : `codex-tool-${randomUUID()}`,
    name,
    arguments: args as ToolCall["arguments"],
    type: "function",
    status: "pending",
  };
}

function normalizeNamedToolCall(
  value: unknown,
  availableToolNames: Set<string>,
): ToolCall | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const functionRecord =
    record.function &&
    typeof record.function === "object" &&
    !Array.isArray(record.function)
      ? (record.function as Record<string, unknown>)
      : undefined;
  const name = String(
    record.name ?? record.toolName ?? record.tool ?? functionRecord?.name ?? "",
  ).trim();
  if (!name || !availableToolNames.has(name)) {
    return null;
  }
  const args = parseToolCallArguments(
    record.arguments ??
      record.args ??
      record.input ??
      record.params ??
      functionRecord?.arguments,
  );
  return makeToolCall(name, args, record.id ?? record.toolCallId);
}

function normalizeToolCallArray(
  value: unknown,
  availableToolNames: Set<string>,
): ToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normalizeNamedToolCall(entry, availableToolNames))
    .filter((entry): entry is ToolCall => entry !== null);
}

export function parseCodexToolCallResult(
  text: string,
  params: GenerateTextParams,
): GenerateTextResult | null {
  const tools = Array.isArray(params.tools) ? params.tools : [];
  if (tools.length === 0) {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseCodexObjectResult(text);
  } catch {
    return null;
  }

  const availableToolNames = new Set(tools.map((tool) => tool.name));
  const explicitCalls = normalizeToolCallArray(
    parsed.toolCalls ?? parsed.calls,
    availableToolNames,
  );
  if (explicitCalls.length > 0) {
    return {
      text:
        typeof parsed.messageToUser === "string" ? parsed.messageToUser : "",
      toolCalls: explicitCalls,
      finishReason: "tool_calls",
      providerMetadata: { provider: "codex-cli-tool-bridge" },
    };
  }

  const namedCall = normalizeNamedToolCall(parsed, availableToolNames);
  if (namedCall) {
    return {
      text: "",
      toolCalls: [namedCall],
      finishReason: "tool_calls",
      providerMetadata: { provider: "codex-cli-tool-bridge" },
    };
  }

  const selectedTool = requiredSingleTool(params);
  if (selectedTool) {
    return {
      text: "",
      toolCalls: [makeToolCall(selectedTool.name, parsed)],
      finishReason: "tool_calls",
      providerMetadata: { provider: "codex-cli-tool-bridge" },
    };
  }

  return null;
}

export function parseCodexImageDescriptionResult(
  text: string,
): ImageDescriptionResult {
  const cleaned = stripMarkdownJsonFence(text);
  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
    const description =
      typeof parsed.description === "string" ? parsed.description.trim() : "";
    if (title || description) {
      return {
        title: title || "Image Analysis",
        description: description || title,
      };
    }
  } catch {
    // Plain text is acceptable; older Codex CLI builds do not always honor JSON-only prompts.
  }

  const firstLine = cleaned
    .split(/\r?\n/)
    .find((line) => line.trim())
    ?.trim();
  return {
    title: firstLine?.slice(0, 80) || "Image Analysis",
    description: cleaned || "Image description unavailable.",
  };
}

function appendCapture(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  if (next.length <= MAX_CAPTURE_CHARS) return next;
  return next.slice(next.length - MAX_CAPTURE_CHARS);
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" ? code : undefined;
}

export function buildCodexExecEnv(
  baseEnv: NodeJS.ProcessEnv,
  options: Pick<CodexExecOptions, "inheritOpenAIEnv">,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    NO_COLOR: "1",
  };
  if (!options.inheritOpenAIEnv) {
    delete env.OPENAI_API_KEY;
    delete env.OPENAI_BASE_URL;
    delete env.OPENAI_ORG_ID;
    delete env.OPENAI_ORGANIZATION;
    delete env.OPENAI_PROJECT;
  }
  return env;
}

function codexSupportsOutputLastMessage(binary: string): Promise<boolean> {
  const cached = outputLastMessageSupportCache.get(binary);
  if (cached) return cached;

  const probe = new Promise<boolean>((resolve) => {
    const child = spawn(binary, ["exec", "--help"], {
      env: buildCodexExecEnv(process.env, { inheritOpenAIEnv: false }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    const finish = (supported: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(supported);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(false);
    }, OUTPUT_LAST_MESSAGE_HELP_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      output = appendCapture(output, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output = appendCapture(output, chunk);
    });
    child.on("error", () => finish(false));
    child.on("close", () => finish(output.includes("--output-last-message")));
  });

  outputLastMessageSupportCache.set(binary, probe);
  return probe;
}

export async function runCodexExec(
  prompt: string,
  options: CodexExecOptions,
  input: CodexExecInput = {},
): Promise<string> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "eliza-codex-model-"));
  const outputFile = path.join(tempDir, `${randomUUID()}.txt`);
  const supportsOutputLastMessage = await codexSupportsOutputLastMessage(
    options.binary,
  );
  const args = buildCodexExecArgs(
    outputFile,
    options,
    supportsOutputLastMessage,
    input,
  );
  let stdout = "";
  let stderr = "";

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(options.binary, args, {
        cwd: options.workdir,
        env: buildCodexExecEnv(process.env, options),
        stdio: ["pipe", "pipe", "pipe"],
      });

      let settled = false;
      let escalationTimer: ReturnType<typeof setTimeout> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanupTimers = () => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        if (escalationTimer) {
          clearTimeout(escalationTimer);
          escalationTimer = undefined;
        }
      };
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanupTimers();
        fn();
      };

      if (options.timeoutMs > 0) {
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanupTimers();
          child.kill("SIGTERM");
          escalationTimer = setTimeout(() => {
            child.kill("SIGKILL");
          }, KILL_GRACE_MS);
          reject(
            new Error(
              `codex exec timed out after ${options.timeoutMs}ms for model provider call`,
            ),
          );
        }, options.timeoutMs);
      }

      child.stdout.on("data", (chunk: Buffer) => {
        stdout = appendCapture(stdout, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = appendCapture(stderr, chunk);
      });
      child.stdin.on("error", (error) => {
        if (settled) return;
        if (errorCode(error) === "EPIPE") {
          stderr = appendCapture(stderr, Buffer.from(error.message));
          return;
        }
        settle(() => reject(error));
      });
      child.on("error", (error) => {
        cleanupTimers();
        if (settled) return;
        settle(() => reject(error));
      });
      child.on("close", (code, signal) => {
        cleanupTimers();
        if (settled) return;
        if (code === 0) {
          settle(resolve);
          return;
        }
        settle(() =>
          reject(
            new Error(
              `codex exec exited with code ${code ?? "null"} signal ${
                signal ?? "null"
              }. ${stderr || stdout}`.trim(),
            ),
          ),
        );
      });

      child.stdin.end(prompt);
    });

    const finalMessage = supportsOutputLastMessage
      ? await readFile(outputFile, "utf8")
          .then((value) => value.trim())
          .catch((error) => {
            throw new Error(
              `codex exec did not write --output-last-message output (${error instanceof Error ? error.message : String(error)}). ${stderr || stdout}`.trim(),
            );
          })
      : stdout.trim();
    if (!finalMessage) {
      throw new Error(
        `codex exec produced an empty model response. ${stderr || stdout}`.trim(),
      );
    }
    return finalMessage;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function imageUrlFromParams(params: ImageDescriptionParams | string): string {
  if (typeof params === "string") return params.trim();
  return params.imageUrl.trim();
}

function imageExtensionForMime(mime: string | undefined): string {
  if (!mime) return "";
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/gif") return ".gif";
  return ".img";
}

function imageExtensionForUrl(url: URL): string {
  const extension = path.extname(url.pathname).toLowerCase();
  if ([".gif", ".jpg", ".jpeg", ".png", ".webp"].includes(extension)) {
    return extension;
  }
  return "";
}

const nodeLookup: LookupFn = async (hostname, options) => {
  const records = await dnsLookup(hostname, options);
  return records.map((record) => ({
    address: record.address,
    family: record.family,
  }));
};

async function imageFetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    IMAGE_FETCH_TIMEOUT_MS,
  );
  const upstreamSignal = init?.signal;
  const abortFromUpstream = () => controller.abort();
  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      controller.abort();
    } else {
      upstreamSignal.addEventListener("abort", abortFromUpstream, {
        once: true,
      });
    }
  }

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
    upstreamSignal?.removeEventListener("abort", abortFromUpstream);
  }
}

function decodePercentEncodedBytes(value: string): Buffer {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "%") {
      const hex = value.slice(index + 1, index + 3);
      if (!/^[0-9a-f]{2}$/i.test(hex)) {
        throw new Error(
          "IMAGE_DESCRIPTION data URL has invalid percent encoding",
        );
      }
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
      continue;
    }
    const code = char.charCodeAt(0);
    if (code > 0x7f) {
      throw new Error(
        "IMAGE_DESCRIPTION non-base64 data URLs must use percent-encoded bytes",
      );
    }
    bytes.push(code);
  }
  return Buffer.from(bytes);
}

async function writeDataUrlImage(
  imageUrl: string,
  tempDir: string,
): Promise<string> {
  const match = imageUrl.match(/^data:([^,]*),(.*)$/s);
  if (!match) {
    throw new Error(
      "IMAGE_DESCRIPTION requires an http(s) URL or image data URL",
    );
  }
  const metadata = (match[1] ?? "").split(";").filter(Boolean);
  const mime = metadata[0]?.toLowerCase() || "text/plain";
  const isBase64 = metadata
    .slice(1)
    .some((part) => part.toLowerCase() === "base64");
  if (!mime?.startsWith("image/")) {
    throw new Error(
      `IMAGE_DESCRIPTION data URL is not an image: ${mime ?? "unknown"}`,
    );
  }
  const payload = match[2] ?? "";
  const buffer = isBase64
    ? Buffer.from(payload, "base64")
    : decodePercentEncodedBytes(payload);
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`IMAGE_DESCRIPTION image exceeds ${MAX_IMAGE_BYTES} bytes`);
  }
  const imagePath = path.join(
    tempDir,
    `${randomUUID()}${imageExtensionForMime(mime)}`,
  );
  await writeFile(imagePath, buffer);
  return imagePath;
}

async function downloadImageUrl(
  imageUrl: string,
  tempDir: string,
): Promise<string> {
  if (imageUrl.startsWith("data:")) {
    return writeDataUrlImage(imageUrl, tempDir);
  }

  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    throw new Error(
      "IMAGE_DESCRIPTION requires an http(s) URL or image data URL",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `IMAGE_DESCRIPTION does not support ${parsed.protocol} URLs`,
    );
  }

  let buffer: Buffer;
  let contentType: string | undefined;
  try {
    const result = await fetchRemoteMedia({
      url: parsed.toString(),
      fetchImpl: imageFetchWithTimeout,
      maxBytes: MAX_IMAGE_BYTES,
      maxRedirects: 3,
      lookupFn: nodeLookup,
    });
    buffer = result.buffer;
    contentType = result.contentType?.split(";")[0]?.trim().toLowerCase();
  } catch (error) {
    throw new Error(
      `IMAGE_DESCRIPTION image fetch failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (contentType && !contentType.startsWith("image/")) {
    throw new Error(`IMAGE_DESCRIPTION URL is not an image: ${contentType}`);
  }
  const imagePath = path.join(
    tempDir,
    `${randomUUID()}${imageExtensionForMime(contentType) || imageExtensionForUrl(parsed)}`,
  );
  await writeFile(imagePath, buffer);
  return imagePath;
}

export async function codexCliImageDescriptionModel(
  runtime: IAgentRuntime,
  params: ImageDescriptionParams | string,
): Promise<ImageDescriptionResult> {
  const imageUrl = imageUrlFromParams(params);
  if (!imageUrl) {
    throw new Error("IMAGE_DESCRIPTION requires a valid image URL");
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), "eliza-codex-image-"));
  try {
    const imagePath = await downloadImageUrl(imageUrl, tempDir);
    const options = resolveCodexExecOptions(runtime);
    logger.info(
      `[codex-model-provider] running codex exec for IMAGE_DESCRIPTION in ${options.workdir}`,
    );
    const text = await runCodexExec(
      buildCodexImageDescriptionPrompt(params),
      options,
      {
        imagePaths: [imagePath],
      },
    );
    return parseCodexImageDescriptionResult(text);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function codexCliTextModel(
  runtime: IAgentRuntime,
  params: GenerateTextParams,
): Promise<string | GenerateTextResult> {
  const rawModelType = (params as unknown as { modelType?: unknown }).modelType;
  const modelType = typeof rawModelType === "string" ? rawModelType : undefined;
  const options = resolveCodexExecOptions(runtime);
  const prompt = buildCodexModelPrompt(params, modelType);
  logger.info(
    `[codex-model-provider] running codex exec for ${modelType ?? "text"} in ${options.workdir}`,
  );
  const text = await runCodexExec(prompt, options);
  return parseCodexToolCallResult(text, params) ?? text;
}

export async function codexCliObjectModel(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams,
): Promise<Record<string, unknown>> {
  const rawModelType = (params as unknown as { modelType?: unknown }).modelType;
  const modelType = typeof rawModelType === "string" ? rawModelType : undefined;
  const options = resolveCodexExecOptions(runtime);
  const prompt = buildCodexObjectPrompt(params, modelType);
  logger.info(
    `[codex-model-provider] running codex exec for ${modelType ?? "object"} in ${options.workdir}`,
  );
  const text = await runCodexExec(prompt, options);
  return parseCodexObjectResult(text);
}
