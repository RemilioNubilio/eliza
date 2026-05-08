import { describe, expect, it } from "vitest";
import {
  formatTaskWorkdirRouteInstructions,
  parseTaskWorkdirRoutes,
  resolveTaskMemoryContent,
  resolveTaskWorkdirRoute,
  resolveTaskWorkdirSelection,
} from "../services/task-workdir-routes.js";

function runtimeWithSettings(settings: Record<string, string>) {
  return {
    getSetting(key: string) {
      return settings[key];
    },
  } as never;
}

describe("task workdir routes", () => {
  it("matches an operator-configured local workspace route", () => {
    const runtime = runtimeWithSettings({
      TASK_AGENT_WORKDIR_ROUTES: JSON.stringify([
        {
          id: "local-site",
          workdir: "/workspace/site",
          matchAll: ["app"],
          matchAny: ["site", "open"],
          excludeAny: ["production", "cloud"],
          instructions: "Write static apps under data/apps/<slug>/.",
        },
      ]),
    });

    const route = resolveTaskWorkdirRoute(
      runtime,
      "build me a breathing timer app I can open on your site",
    );

    expect(route).toMatchObject({
      id: "local-site",
      workdir: "/workspace/site",
      instructions: "Write static apps under data/apps/<slug>/.",
    });
    expect(route).not.toBeNull();
    if (!route) return;
    expect(formatTaskWorkdirRouteInstructions(route)).toContain(
      "Use existing local workspace: /workspace/site",
    );
  });

  it("does not match excluded production or cloud tasks", () => {
    const runtime = runtimeWithSettings({
      TASK_AGENT_WORKDIR_ROUTES: JSON.stringify([
        {
          workdir: "/workspace/site",
          matchAll: ["app"],
          matchAny: ["site", "open"],
          excludeAny: ["production", "cloud"],
        },
      ]),
    });

    expect(
      resolveTaskWorkdirRoute(
        runtime,
        "build a production cloud app I can open on your site",
      ),
    ).toBeNull();
  });

  it("uses token boundaries for short needles", () => {
    const runtime = runtimeWithSettings({
      TASK_AGENT_WORKDIR_ROUTES: JSON.stringify([
        {
          workdir: "/workspace/site",
          matchAll: ["app"],
          matchAny: ["site", "open"],
          excludeAny: ["ai", "pr"],
        },
      ]),
    });

    expect(
      resolveTaskWorkdirRoute(runtime, "build a tiny app for the current site"),
    ).toMatchObject({ workdir: "/workspace/site" });
    expect(
      resolveTaskWorkdirRoute(
        runtime,
        "build a tiny ai app for the current site",
      ),
    ).toBeNull();
    expect(
      resolveTaskWorkdirRoute(runtime, "build a tiny app and open a pr"),
    ).toBeNull();
  });

  it("ignores invalid or catch-all route entries", () => {
    expect(
      parseTaskWorkdirRoutes(
        JSON.stringify([
          { workdir: "relative/path", matchAny: ["app"] },
          { workdir: "/workspace/no-matchers" },
          null,
        ]),
      ),
    ).toEqual([]);
  });

  it("prefers a matching operator route over a planner-inferred workdir", () => {
    const runtime = runtimeWithSettings({
      TASK_AGENT_WORKDIR_ROUTES: JSON.stringify([
        {
          workdir: "/workspace/site",
          matchAll: ["app"],
          matchAny: ["site", "open"],
        },
      ]),
    });

    expect(
      resolveTaskWorkdirSelection(runtime, {
        routeText:
          "build me a tiny polished breathing app I can open on your site.",
        plannerWorkdir: "/workspace/stale-scratch",
      }),
    ).toMatchObject({
      workdir: "/workspace/site",
      source: "route",
    });
  });

  it("keeps content workdir above configured routes", () => {
    const runtime = runtimeWithSettings({
      TASK_AGENT_WORKDIR_ROUTES: JSON.stringify([
        {
          workdir: "/workspace/site",
          matchAll: ["app"],
          matchAny: ["site", "open"],
        },
      ]),
    });

    expect(
      resolveTaskWorkdirSelection(runtime, {
        routeText: "build an app I can open on your site",
        contentWorkdir: "/workspace/operator-explicit",
        plannerWorkdir: "/workspace/planner",
      }),
    ).toMatchObject({
      workdir: "/workspace/operator-explicit",
      source: "content",
    });
  });

  it("falls back to planner workdir when no route matches", () => {
    const runtime = runtimeWithSettings({
      TASK_AGENT_WORKDIR_ROUTES: JSON.stringify([
        {
          workdir: "/workspace/site",
          matchAll: ["app"],
          matchAny: ["site", "open"],
        },
      ]),
    });

    expect(
      resolveTaskWorkdirSelection(runtime, {
        routeText: "inspect current market data",
        plannerWorkdir: "/workspace/lookup",
      }),
    ).toMatchObject({
      workdir: "/workspace/lookup",
      source: "planner",
    });
  });

  it("drops planner-authored memory when an operator route overrides planner workdir", () => {
    expect(
      resolveTaskMemoryContent({
        contentMemoryContent: undefined,
        plannerMemoryContent: "Work only in /workspace/stale-pr-worktree.",
        workdirSelection: { source: "route" },
      }),
    ).toBeUndefined();

    expect(
      resolveTaskMemoryContent({
        contentMemoryContent: "Operator structured memory",
        plannerMemoryContent: "Work only in /workspace/stale-pr-worktree.",
        workdirSelection: { source: "route" },
      }),
    ).toBe("Operator structured memory");
  });

  it("keeps planner memory when no configured route overrides it", () => {
    expect(
      resolveTaskMemoryContent({
        plannerMemoryContent: "Use the requested repo checkout.",
        workdirSelection: { source: "planner" },
      }),
    ).toBe("Use the requested repo checkout.");
  });
});
