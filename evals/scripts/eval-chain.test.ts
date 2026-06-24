// Regression coverage for the FAIR-evals post-processing chain (WS4), exercised on fixtures
// so it needs no live host run: the shared natural-prompt renderer (the fairness guarantee),
// capture-strategy's realized-strategy reader, and extract-codex-answer's answer normalizer.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { captureStrategy } from "./capture-strategy";
import { extractAnswer } from "./extract-codex-answer";
import { renderNaturalPrompt } from "./prompt-template";

// Fairness: both render-codex-prompt and render-claude-prompt delegate to this one function,
// so a single rendering is the byte-identical prompt both hosts receive.
test("renderNaturalPrompt embeds the case context + task verbatim", () => {
	const out = renderNaturalPrompt({ context: "CTX-BODY", task: "TASK-BODY" });
	expect(out).toContain("CTX-BODY");
	expect(out).toContain("TASK-BODY");
});

test("captureStrategy resolves the launched runId and reads the realized strategy", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "aw-eval-"));
	const runId = "wf_fixture1";
	const runDir = path.join(root, ".agent-workflows", "runs", runId);
	mkdirSync(runDir, { recursive: true });
	writeFileSync(
		path.join(runDir, "result.json"),
		JSON.stringify({ runId, status: "done", summary: { agents: 3 } }),
	);
	writeFileSync(
		path.join(runDir, "status.json"),
		JSON.stringify({
			agents: [
				{ label: "review:bugs", phase: "Review" },
				{ label: "verify:bugs", phase: "Verify" },
			],
			phases: ["Review", "Verify"],
		}),
	);

	// The REAL codex JSONL shape for an MCP call: { type:'mcp_tool_call', server, tool, result }
	// with the start_run payload under result.structuredContent. The `tool` field is the match key.
	const hostJsonl = path.join(root, "host.jsonl");
	writeFileSync(
		hostJsonl,
		`${JSON.stringify({
			type: "item.completed",
			item: {
				type: "mcp_tool_call",
				server: "agent-workflows",
				tool: "agent_workflows_start_run",
				arguments: {
					source: "export const meta={name:'x',description:'d'}",
					name: "x",
				},
				status: "completed",
				result: {
					structuredContent: {
						runId,
						runDir: `.agent-workflows/runs/${runId}`,
						statusResource: `agent-workflows://runs/${runId}/status`,
						status: "running",
					},
				},
			},
		})}\nnot-json-noise\n`,
	);

	const summary = captureStrategy(hostJsonl, root);
	expect(summary.resolvedRunId).toBe(runId);
	expect(summary.realizedAgentCount).toBe(3);
	expect(summary.phases).toEqual(["Review", "Verify"]);
	expect(summary.agents.map((a) => a.label)).toEqual([
		"review:bugs",
		"verify:bugs",
	]);
	// The exact-name match must not also fire on agent_workflows_resume_run.
	expect(summary.startRunCalls.length).toBe(1);
});

test("captureStrategy reports no run when the host never called start_run", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "aw-eval-"));
	const hostJsonl = path.join(root, "host.jsonl");
	writeFileSync(
		hostJsonl,
		`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "answered directly" } })}\n`,
	);
	const summary = captureStrategy(hostJsonl, root);
	expect(summary.resolvedRunId).toBeNull();
	expect(summary.realizedAgentCount).toBeNull();
	expect(summary.startRunCalls).toEqual([]);
});

test("extractAnswer passes a direct final message through unchanged", () => {
	expect(extractAnswer("  The scheduler is correct.  ")).toBe(
		"The scheduler is correct.",
	);
});

test("extractAnswer unwraps an orchestrated result.json envelope to the answer only", () => {
	const envelope = JSON.stringify({
		runId: "wf_x",
		status: "done",
		error: null,
		result: { answer: "Use a bounded queue." },
		summary: { agents: 4 },
		budget: { spent: 0, total: null },
		endedAt: 1,
	});
	const out = extractAnswer(envelope);
	expect(out).toBe("Use a bounded queue.");
	// The envelope metadata must never leak into the graded answer.
	expect(out).not.toContain("runId");
	expect(out).not.toContain("summary");
});

test("extractAnswer does not misread ordinary answer JSON as an envelope", () => {
	// Answer JSON that happens to be an object but lacks the runId+status signature.
	const answerJson = JSON.stringify({ verdict: "ok", score: 9 });
	const out = extractAnswer(answerJson);
	expect(JSON.parse(out)).toEqual({ verdict: "ok", score: 9 });
});
