import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../runtime";
import type { Character } from "../types";

describe("AgentRuntime.getSetting", () => {
	it("reads non-secret character env values as runtime settings", () => {
		const runtime = new AgentRuntime({
			character: {
				name: "env-settings-test",
				env: {
					ACTION_ROLE_POLICY: '{"SPAWN_AGENT":"GUEST"}',
					vars: {
						TASK_AGENT_ROLE_POLICY: '{"default":"GUEST"}',
					},
				},
				settings: {
					ACTION_ROLE_POLICY: '{"SPAWN_AGENT":"OWNER"}',
				},
			} as Character,
		});

		expect(runtime.getSetting("ACTION_ROLE_POLICY")).toBe(
			'{"SPAWN_AGENT":"OWNER"}',
		);
		expect(runtime.getSetting("TASK_AGENT_ROLE_POLICY")).toBe(
			'{"default":"GUEST"}',
		);
	});
});
