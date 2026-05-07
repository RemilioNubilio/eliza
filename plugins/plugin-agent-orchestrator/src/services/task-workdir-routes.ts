import * as path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";

export interface TaskWorkdirRoute {
  id?: string;
  workdir: string;
  matchAll?: string[];
  matchAny?: string[];
  excludeAny?: string[];
  instructions?: string;
}

export interface TaskWorkdirSelectionInput {
  routeText: string;
  repo?: string | null;
  contentWorkdir?: string | null;
  plannerWorkdir?: string | null;
}

export interface TaskWorkdirSelection {
  workdir?: string;
  route: TaskWorkdirRoute | null;
  source: "content" | "route" | "planner" | "none";
}

const ROUTES_SETTING_KEYS = [
  "TASK_AGENT_WORKDIR_ROUTES",
  "PARALLAX_TASK_AGENT_WORKDIR_ROUTES",
] as const;

function readSetting(runtime: IAgentRuntime, key: string): string | undefined {
  const value = runtime.getSetting(key);
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function normalizeNeedle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase().replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeWorkdir(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeNeedle)
    .filter((entry): entry is string => entry !== null);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textMatchesNeedle(text: string, needle: string): boolean {
  if (needle.includes(" ")) {
    return text.includes(needle);
  }
  return new RegExp(
    `(?:^|[^a-z0-9])${escapeRegExp(needle)}(?:$|[^a-z0-9])`,
  ).test(text);
}

function normalizeRoute(value: unknown): TaskWorkdirRoute | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.workdir !== "string" || !path.isAbsolute(raw.workdir)) {
    return null;
  }
  const matchAll = normalizeStringList(raw.matchAll);
  const matchAny = normalizeStringList(raw.matchAny);
  if (matchAll.length === 0 && matchAny.length === 0) {
    return null;
  }
  return {
    workdir: path.resolve(raw.workdir),
    ...(typeof raw.id === "string" && raw.id.trim()
      ? { id: raw.id.trim() }
      : {}),
    ...(matchAll.length > 0 ? { matchAll } : {}),
    ...(matchAny.length > 0 ? { matchAny } : {}),
    ...(normalizeStringList(raw.excludeAny).length > 0
      ? { excludeAny: normalizeStringList(raw.excludeAny) }
      : {}),
    ...(typeof raw.instructions === "string" && raw.instructions.trim()
      ? { instructions: raw.instructions.trim() }
      : {}),
  };
}

export function parseTaskWorkdirRoutes(
  raw: string | undefined,
): TaskWorkdirRoute[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const routes = Array.isArray(parsed)
    ? parsed
    : parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { routes?: unknown }).routes)
      ? (parsed as { routes: unknown[] }).routes
      : [];
  return routes
    .map(normalizeRoute)
    .filter((route): route is TaskWorkdirRoute => route !== null);
}

export function readConfiguredTaskWorkdirRoutes(
  runtime: IAgentRuntime,
): TaskWorkdirRoute[] {
  for (const key of ROUTES_SETTING_KEYS) {
    const routes = parseTaskWorkdirRoutes(readSetting(runtime, key));
    if (routes.length > 0) return routes;
  }
  return [];
}

function routeMatches(route: TaskWorkdirRoute, taskText: string): boolean {
  const text = normalizeNeedle(taskText);
  if (!text) return false;
  if (route.excludeAny?.some((needle) => textMatchesNeedle(text, needle))) {
    return false;
  }
  if (route.matchAll?.some((needle) => !textMatchesNeedle(text, needle))) {
    return false;
  }
  if (route.matchAny && route.matchAny.length > 0) {
    return route.matchAny.some((needle) => textMatchesNeedle(text, needle));
  }
  return true;
}

export function resolveTaskWorkdirRoute(
  runtime: IAgentRuntime,
  taskText: string,
): TaskWorkdirRoute | null {
  for (const route of readConfiguredTaskWorkdirRoutes(runtime)) {
    if (routeMatches(route, taskText)) return route;
  }
  return null;
}

export function resolveTaskWorkdirSelection(
  runtime: IAgentRuntime,
  input: TaskWorkdirSelectionInput,
): TaskWorkdirSelection {
  const contentWorkdir = normalizeWorkdir(input.contentWorkdir);
  if (contentWorkdir) {
    return { workdir: contentWorkdir, route: null, source: "content" };
  }

  // Tool-call parameters are planner inferences. Operator-configured routes
  // are stronger when they match the current user request, because routes
  // encode deployment-specific workspace ownership outside the model.
  const route = input.repo
    ? null
    : resolveTaskWorkdirRoute(runtime, input.routeText);
  if (route) {
    return { workdir: route.workdir, route, source: "route" };
  }

  const plannerWorkdir = normalizeWorkdir(input.plannerWorkdir);
  if (plannerWorkdir) {
    return { workdir: plannerWorkdir, route: null, source: "planner" };
  }

  return { route: null, source: "none" };
}

export function formatTaskWorkdirRouteInstructions(
  route: TaskWorkdirRoute,
): string {
  const lines = [
    "# Assigned Local Workspace Route",
    "",
    `Use existing local workspace: ${route.workdir}`,
  ];
  if (route.id) {
    lines.push(`Route id: ${route.id}`);
  }
  if (route.instructions) {
    lines.push("", route.instructions);
  }
  return lines.join("\n");
}
