import type { Memory } from "@elizaos/core";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function getOriginExternalMessageId(
  message: Memory,
): string | undefined {
  const metadata = asRecord(message.metadata);
  const content = asRecord(message.content);
  const contentMetadata = asRecord(content?.metadata);
  const discord =
    asRecord(metadata?.discord) ?? asRecord(contentMetadata?.discord);

  return (
    stringValue(metadata?.discordMessageId) ??
    stringValue(metadata?.messageIdFull) ??
    stringValue(discord?.messageId) ??
    stringValue(contentMetadata?.discordMessageId) ??
    stringValue(contentMetadata?.messageIdFull)
  );
}
