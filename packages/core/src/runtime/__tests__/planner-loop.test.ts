import { describe, expect, it, vi } from "vitest";
import { ModelType } from "../../types/model";
import { TrajectoryLimitExceeded } from "../limits";
import {
	parsePlannerOutput,
	renderPlannerPrompt,
	runPlannerLoop,
} from "../planner-loop";

describe("v5 planner loop skeleton", () => {
	it("parses planner tool calls", () => {
		const output = parsePlannerOutput(`{
  "thought": "Fetch state.",
  "toolCalls": [
    {
      "name": "LOOKUP",
      "args": { "query": "status" }
    }
  ]
}`);

		expect(output.toolCalls).toEqual([
			{
				name: "LOOKUP",
				params: { query: "status" },
			},
		]);
	});

	it("parses planner toolName aliases", () => {
		const output = parsePlannerOutput(`{
  "thought": "Inspect disk.",
  "toolCalls": [
    {
      "toolName": "SHELL_COMMAND",
      "arguments": { "command": "df -h" }
    }
  ]
}`);

		expect(output.toolCalls).toEqual([
			{
				name: "SHELL_COMMAND",
				params: { command: "df -h" },
			},
		]);
	});

	it("parses recipient_name tool calls with parameters", () => {
		const output = parsePlannerOutput(`{
  "thought": "Delegate live lookup.",
  "toolCalls": [
    {
      "recipient_name": "SPAWN_AGENT",
      "parameters": {
        "agentType": "codex",
        "task": "look up current BTC price"
      }
    }
  ]
}`);

		expect(output.toolCalls).toEqual([
			{
				name: "SPAWN_AGENT",
				params: {
					agentType: "codex",
					task: "look up current BTC price",
				},
			},
		]);
	});

	it("instructs planners to use exposed tools for unresolved live or external work", () => {
		const prompt = renderPlannerPrompt({
			context: { id: "ctx" },
			trajectory: {
				context: { id: "ctx" },
				steps: [],
				plannedQueue: [],
				evaluatorOutputs: [],
			},
		});

		expect(prompt).toContain(
			"the task is not complete while the user still needs live/current/external data",
		);
		expect(prompt).toContain(
			"call that tool instead of replying that the current context cannot browse",
		);
		expect(prompt).toContain(
			"prefer SEARCH when it is exposed; otherwise use an exposed task-agent tool",
		);
	});

	it("calls ACTION_PLANNER, executes the first queued tool, then evaluates", async () => {
		const runtime = {
			useModel: vi.fn(async () => ({
				text: "",
				toolCalls: [
					{
						id: "call-1",
						name: "LOOKUP",
						arguments: { query: "status" },
					},
					{
						id: "call-2",
						name: "FOLLOW_UP",
						arguments: { id: "next" },
					},
				],
			})),
		};
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: "all good",
		}));
		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "FINISH" as const,
			thought: "Done.",
			messageToUser: "Done.",
		}));

		const result = await runPlannerLoop({
			runtime,
			context: {
				id: "ctx",
				staticPrefix: {
					characterPrompt: {
						content: "agent_name: Eliza",
						stable: true,
					},
				},
				events: [
					{
						id: "provider:RECENT_MESSAGES",
						type: "provider",
						name: "RECENT_MESSAGES",
						text: "Recent: user asked for status.",
					},
					{
						id: "msg",
						type: "message",
						message: {
							role: "user",
							content: { text: "Check status." },
						},
					},
				],
			},
			executeToolCall,
			evaluate,
		});

		expect(runtime.useModel).toHaveBeenCalledWith(
			ModelType.ACTION_PLANNER,
			expect.objectContaining({ prompt: expect.any(String) }),
			undefined,
		);
		const plannerParams = runtime.useModel.mock.calls[0][1];
		expect(plannerParams.messages.map((message) => message.role)).toEqual([
			"system",
			"user",
		]);
		expect(plannerParams.messages[0].content).toContain("planner_stage:");
		expect(plannerParams.messages[0].content).toContain("agent_name: Eliza");
		expect(plannerParams.messages[1].content).toContain(
			"provider: RECENT_MESSAGES",
		);
		expect(plannerParams.messages[1].content).toContain("Check status.");
		// After the stacking fix, trajectory steps are conveyed as assistant/tool
		// message pairs, NOT as a JSON dump in the user message. The user message
		// (messages[1]) should no longer contain "trajectory:\n[".
		expect(plannerParams.messages[1].content).not.toMatch(/^trajectory:\n\[/);
		expect(plannerParams.providerOptions.eliza.modelInputBudget).toMatchObject({
			reserveTokens: 10_000,
			shouldCompact: false,
		});
		expect(executeToolCall).toHaveBeenCalledWith(
			{ id: "call-1", name: "LOOKUP", params: { query: "status" } },
			expect.objectContaining({ iteration: 1 }),
		);
		expect(executeToolCall).toHaveBeenCalledTimes(1);
		expect(evaluate).toHaveBeenCalledTimes(1);
		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe("Done.");
	});

	it("evaluates terminal-only planner output without executing tools", async () => {
		const runtime = {
			useModel: vi.fn(
				async () => `{
  "thought": "Done.",
  "messageToUser": "Final answer.",
  "toolCalls": []
}`,
			),
		};
		const executeToolCall = vi.fn();
		const evaluate = vi.fn();

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall,
			evaluate,
		});

		expect(executeToolCall).not.toHaveBeenCalled();
		expect(evaluate).not.toHaveBeenCalled();
		expect(result.finalMessage).toBe("Final answer.");
	});

	it("stops planning when an action opts out of chaining", async () => {
		const runtime = {
			useModel: vi.fn(async () => ({
				text: "",
				toolCalls: [
					{
						id: "call-1",
						name: "SPAWN_AGENT",
						arguments: { task: "look up live price" },
					},
				],
			})),
		};
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: "",
			continueChain: false,
		}));
		const evaluate = vi.fn();

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall,
			evaluate,
		});

		expect(evaluate).not.toHaveBeenCalled();
		expect(result.status).toBe("finished");
		expect(result.trajectory.steps).toHaveLength(1);
		expect(result.trajectory.steps[0].toolCall?.name).toBe("SPAWN_AGENT");
	});

	it("records effective tool args while preserving requested planner args", async () => {
		const runtime = {
			useModel: vi.fn(async () => ({
				text: "",
				toolCalls: [
					{
						id: "call-1",
						name: "SPAWN_AGENT",
						arguments: {
							task: "build a timer",
							workdir: "/scratch/planner-choice",
						},
					},
				],
			})),
		};
		const stages: unknown[] = [];
		const recorder = {
			recordStage: vi.fn(async (_trajectoryId: string, stage: unknown) => {
				stages.push(stage);
			}),
		};

		await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			recorder: recorder as never,
			trajectoryId: "tj-effective-args",
			executeToolCall: vi.fn(async () => ({
				success: true,
				continueChain: false,
				data: {
					effectiveArgs: {
						task: "build a timer",
						workdir: "/home/site",
					},
				},
			})),
			evaluate: vi.fn(),
		});

		const toolStage = stages.find(
			(stage) =>
				typeof stage === "object" &&
				stage !== null &&
				(stage as { kind?: unknown }).kind === "tool",
		) as { tool?: { args?: unknown; requestedArgs?: unknown } } | undefined;

		expect(toolStage?.tool?.args).toEqual({
			task: "build a timer",
			workdir: "/home/site",
		});
		expect(toolStage?.tool?.requestedArgs).toEqual({
			task: "build a timer",
			workdir: "/scratch/planner-choice",
		});
	});

	it("throws when the same tool failure repeats beyond the configured limit", async () => {
		const runtime = {
			useModel: vi.fn(async () => ({
				text: "",
				toolCalls: [{ id: "call-1", name: "LOOKUP", arguments: {} }],
			})),
		};
		const executeToolCall = vi.fn(async () => ({
			success: false,
			error: "boom",
		}));
		const evaluate = vi.fn(async () => ({
			success: false,
			decision: "CONTINUE" as const,
			thought: "Retry.",
		}));

		await expect(
			runPlannerLoop({
				runtime,
				context: { id: "ctx" },
				config: { maxRepeatedFailures: 1 },
				executeToolCall,
				evaluate,
			}),
		).rejects.toBeInstanceOf(TrajectoryLimitExceeded);
	});
});
