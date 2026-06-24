#!/usr/bin/env bun
//
// extract-codex-answer.ts — flatten a live-host Codex artifact into the
// answer-only plain text the blind grader reads, for the FAIR evals chain.
//
// The blind grader (render-grader-prompt.ts) reads its answer file as RAW TEXT
// (render-grader-prompt.ts:13) and grades the answer, not the prompt style — it
// is byte-unchanged and must never see a JSON envelope. So the entire
// normalization burden lives here.
//
// ONE entrypoint, auto-detecting two input modes (no --json / --mode / --legacy
// flag, no dead branch, no envelope passthrough):
//
//   1. Direct final message — `codex exec -o last.txt` writes the clean final
//      agent message as plain text (codex.ts:189). We trim and pass it through.
//
//   2. Orchestrated run result — when Codex authored+launched an Agent Workflows
//      run inline, the engine writes result.json with the envelope shape
//      `{runId,status,error,result,summary,budget,endedAt}` (engine.ts:346-354).
//      We extract the human-readable answer from `result` (falling back to the
//      summary text) and emit ONLY that — the surrounding envelope keys
//      (runId/status/budget/endedAt/summary) are NEVER written to the output.
//
// Both modes converge on the SAME non-empty, JSON-envelope-free string written
// to `<case>.codex.txt`, which feeds the unchanged grader unchanged.
//
// Usage:
//   bun evals/scripts/extract-codex-answer.ts <input.(txt|json)> <out.codex.txt>

import { readFileSync, writeFileSync } from "node:fs";

// The result.json envelope keys (engine.ts:346-354). Used ONLY to detect the
// orchestrated mode — these keys are never emitted into the answer text.
const ENVELOPE_KEYS = [
	"runId",
	"status",
	"error",
	"result",
	"summary",
	"budget",
	"endedAt",
];

export function extractAnswer(raw: string): string {
	const trimmed = raw.trim();

	// Auto-detect: only an orchestrated result.json parses to an object carrying
	// the engine envelope signature. A direct last.txt is plain prose (or, at
	// most, prose that does not look like the envelope) and is passed through.
	let parsed: unknown = null;
	if (trimmed.startsWith("{")) {
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			parsed = null;
		}
	}

	if (isResultEnvelope(parsed)) {
		return answerFromEnvelope(parsed as Record<string, unknown>);
	}

	// Direct final message (codex.ts:189): the artifact already IS the answer.
	return trimmed;
}

function isResultEnvelope(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	// The engine envelope always carries runId + status; require those plus at
	// least one more envelope-only key so ordinary answer JSON is not misread.
	if (typeof record.runId !== "string" || record.status === undefined) {
		return false;
	}
	return ENVELOPE_KEYS.some(
		(key) => key !== "runId" && key !== "status" && key in record,
	);
}

// Extract the human-readable answer from the run result (NOT the envelope).
// Priority: the `result` payload (the workflow's top-level return — the actual
// answer), then a human-readable summary text if the result is absent.
function answerFromEnvelope(envelope: Record<string, unknown>): string {
	const fromResult = humanText(envelope.result);
	if (fromResult) return fromResult;
	const fromSummary = humanText(envelope.summary);
	if (fromSummary) return fromSummary;
	return "";
}

// Flatten an arbitrary result payload to human-readable plain text without ever
// re-introducing the envelope. Strings pass through; an object that wraps its
// answer in a common text field is unwrapped; otherwise the payload is
// pretty-printed (the answer content, never the {runId,status,...} envelope).
function humanText(value: unknown): string {
	if (value == null) return "";
	if (typeof value === "string") return value.trim();
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (Array.isArray(value)) {
		const parts = value.map((v) => humanText(v)).filter(Boolean);
		return parts.join("\n\n").trim();
	}
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		for (const key of ["answer", "text", "content", "output", "message"]) {
			const inner = humanText(record[key]);
			if (inner) return inner;
		}
		// No conventional text field — serialize the answer payload itself.
		return JSON.stringify(value, null, 2).trim();
	}
	return "";
}

// --- entrypoint (after all declarations so consts are initialized) ---
if (import.meta.main) {
	const inputPath = process.argv[2];
	const outPath = process.argv[3];
	if (!inputPath || !outPath) {
		throw new Error(
			"usage: bun evals/scripts/extract-codex-answer.ts <input.(txt|json)> <out.codex.txt>",
		);
	}
	const raw = readFileSync(inputPath, "utf8");
	const answer = extractAnswer(raw);
	if (!answer.trim()) {
		throw new Error(`extract-codex-answer: empty answer from ${inputPath}`);
	}
	writeFileSync(outPath, `${answer.trim()}\n`);
}
