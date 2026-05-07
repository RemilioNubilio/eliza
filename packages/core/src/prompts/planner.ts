import type { JSONSchema } from "../types/model";

export const v5PlannerTemplate = `task: Plan the next native tool calls for the current ContextObject.

rules:
- use only tools exposed in the current context object
- plan the smallest grounded queue of useful tool calls
- include arguments only when grounded in the user request or prior tool results
- the task is not complete while the user still needs live/current/external data, filesystem/runtime state, command output, repo work, app builds, PR work, deployment, verification, or another side effect and a relevant exposed tool can attempt it
- when a relevant exposed tool can attempt the needed work, call that tool instead of replying that the current context cannot browse, search, run commands, inspect, build, deploy, or verify
- for live/current/external-data requests, prefer SEARCH when it is exposed; otherwise use an exposed task-agent tool such as SPAWN_AGENT or START_CODING_TASK when one is available
- if the task is complete or the only next step is speaking to the user, return no toolCalls and set messageToUser
- do not invent tool names, connector names, providers, ids, or benchmark ids

return:
JSON object only. No markdown, no prose, no XML, no legacy formats.

context_object:
{{contextObject}}

trajectory:
{{trajectory}}`;

export const V5_PLANNER_TEMPLATE = v5PlannerTemplate;

export const v5PlannerSchema: JSONSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		thought: { type: "string" },
		toolCalls: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: { type: "string" },
					name: { type: "string" },
					args: {
						type: "object",
						additionalProperties: false,
					},
				},
				required: ["name"],
			},
		},
		messageToUser: { type: "string" },
	},
	required: ["thought", "toolCalls"],
};

export const V5_PLANNER_SCHEMA = v5PlannerSchema;
