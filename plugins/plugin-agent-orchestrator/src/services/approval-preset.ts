import type { ApprovalPreset } from "coding-agent-adapters";

const APPROVAL_PRESETS = new Set<ApprovalPreset>([
  "readonly",
  "standard",
  "permissive",
  "autonomous",
]);

export function normalizeApprovalPreset(
  value: unknown,
): ApprovalPreset | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase() as ApprovalPreset;
  return APPROVAL_PRESETS.has(normalized) ? normalized : undefined;
}

export function resolveRequestedApprovalPreset(args: {
  contentPreset?: unknown;
  parameterPreset?: unknown;
  userText?: string;
}): ApprovalPreset | undefined {
  const contentPreset = normalizeApprovalPreset(args.contentPreset);
  if (contentPreset) {
    return contentPreset;
  }

  const parameterPreset = normalizeApprovalPreset(args.parameterPreset);
  if (!parameterPreset) {
    return undefined;
  }

  return userTextRequestsApprovalPreset(args.userText ?? "", parameterPreset)
    ? parameterPreset
    : undefined;
}

export function userTextRequestsApprovalPreset(
  text: string,
  preset: ApprovalPreset,
): boolean {
  const normalized = text.toLowerCase();
  switch (preset) {
    case "readonly":
      return /\b(read[-\s]?only|readonly|audit[-\s]?only|no[-\s]?write|no writes?|do(?:n't| not)\s+(?:edit|write|change)|without\s+(?:editing|writing|changing))\b/u.test(
        normalized,
      );
    case "standard":
      return /\bstandard\b.*\b(approval|permission|preset|mode)\b|\b(approval|permission|preset|mode)\b.*\bstandard\b/u.test(
        normalized,
      );
    case "permissive":
      return /\bpermissive\b/u.test(normalized);
    case "autonomous":
      return /\b(autonomous|full\s+(?:tool\s+)?access|full\s+permissions?|no\s+approvals?|without\s+asking|skip\s+approvals?)\b/u.test(
        normalized,
      );
  }
}
