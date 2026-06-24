// Subagent substrate. One agent() call == one harness `process.run` (a text run). This is
// the only place the engine touches the host: it hands the harness a prompt + cwd and reads
// back { ok, text }. The harness (@plimeor/harness) owns every host detail — which CLI runs,
// its flags, sandboxing — so core stays host-agnostic. See docs/decisions/003-harness-adoption.md.
import type {
	HarnessHandle,
	HarnessRun,
	RunRequest,
	TextOutputRequest,
} from "@plimeor/harness";

// The minimal slice of a @plimeor/harness HarnessHandle the engine consumes: a text run.
// A real HarnessHandle is assignable to this; tests inject a structural stand-in.
export type AgentHarness = Pick<HarnessHandle, "process">;

export type AgentRunResult = {
	ok: boolean;
	text: string;
	error?: string;
};

export const SUBAGENT_PREAMBLE =
	"[Agent Workflows subagent] Your final message is consumed programmatically as this task's return value — it is NOT shown to a human. Do the work, then return ONLY the requested content (or JSON when a schema is given), with no preamble, sign-off, or framing. Be precise and self-contained.";

// Assemble the prompt sent to the host agent. The schema (when present) is embedded as an
// instruction because the engine — not the host — validates and retries (decision 003); a
// correction line is appended on a retry to tell the fresh agent what the last try got wrong.
export function buildAgentPrompt(
	prompt: string,
	preamble: string,
	schema: unknown | null,
	correction: string,
): string {
	const parts = [SUBAGENT_PREAMBLE];
	if (preamble) parts.push(preamble);
	parts.push(prompt);
	if (schema)
		parts.push(
			`Return ONLY a single JSON value (no prose, no code fences) conforming to this JSON Schema:\n${JSON.stringify(schema)}`,
		);
	if (correction) parts.push(correction);
	return parts.join("\n\n---\n\n");
}

// Parse a JSON value out of a text-mode agent reply. Tries the whole string first, then
// extracts the first balanced {…}/[…] so incidental prose around the JSON does not force a
// spurious retry. Throws when no balanced JSON value is present.
export function extractJson(text: string): unknown {
	const t = String(text).trim();
	try {
		return JSON.parse(t);
	} catch {
		// fall through to balanced extraction
	}
	const start = t.search(/[{[]/);
	if (start < 0) throw new Error("no JSON value found");
	const open = t[start];
	const close = open === "{" ? "}" : "]";
	let depth = 0;
	let inStr = false;
	for (let i = start; i < t.length; i++) {
		const c = t[i];
		if (inStr) {
			if (c === "\\") i++;
			else if (c === '"') inStr = false;
			continue;
		}
		if (c === '"') {
			inStr = true;
		} else if (c === open) {
			depth++;
		} else if (c === close && --depth === 0) {
			return JSON.parse(t.slice(start, i + 1));
		}
	}
	throw new Error("unbalanced JSON value");
}

// Run one agent turn through the harness as a text run. ok = exitCode === 0 (decision 003).
// An AbortSignal kills the live run. Never throws: a spawn/run failure becomes { ok:false }.
export async function runHarnessAgent(
	harness: AgentHarness,
	opts: { prompt: string; cwd: string; signal?: AbortSignal | null },
): Promise<AgentRunResult> {
	const request: RunRequest<TextOutputRequest> = {
		prompt: opts.prompt,
		cwd: opts.cwd,
		output: { mode: "text" },
	};
	let run: HarnessRun<TextOutputRequest>;
	try {
		run = await harness.process.run(request);
	} catch (e) {
		return { ok: false, text: "", error: errorText(e) };
	}

	const onAbort = () => {
		try {
			run.kill();
		} catch {
			/* already gone */
		}
	};
	const signal = opts.signal;
	if (signal) {
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	}

	try {
		const res = await run.result;
		const ok = res.exitCode === 0;
		return {
			ok,
			text: String(res.finalText ?? "").trim(),
			error: ok ? undefined : `agent exited ${res.exitCode ?? "?"}`,
		};
	} catch (e) {
		return { ok: false, text: "", error: errorText(e) };
	} finally {
		if (signal) signal.removeEventListener("abort", onAbort);
	}
}

function errorText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
