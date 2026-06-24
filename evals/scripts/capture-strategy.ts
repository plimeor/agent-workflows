#!/usr/bin/env bun
//
// capture-strategy.ts — read-only "what strategy did Codex actually choose?"
// recorder for the FAIR evals chain.
//
// After a live Codex host run (run-codex-host.sh), this parses the host JSONL
// event stream for the EXACT `agent_workflows_start_run` MCP tool-calls Codex
// made, resolves each launched runId from the start_run result shape, then reads
// that run's durable files to report the realized strategy: how many sub-agents
// Codex actually launched, with what labels and phases.
//
// Authoritative sources (single path, no fallback, no flag):
//   - tool-calls    : the host JSONL, matched on the EXACT tool name
//                     `agent_workflows_start_run` (mcp.ts:32). A loose
//                     `start_run` substring would also match
//                     `agent_workflows_resume_run` semantics, and the longer
//                     name would be over-matched — so we compare the full name.
//   - realized count: `result.json.summary.agents` — the count produced by
//                     progress.summary() (progress.ts:144-154) and persisted by
//                     the engine (engine.ts:346-354). This is the ONE
//                     realized-count source.
//   - labels/phases : `status.json` `agents[].label` / `.phase` and `phases`
//                     (progress.ts:40-49). status.json is the ONLY authoritative
//                     source for labels/phases.
//
// IMPORTANT: labels, phases, and the count are NEVER read from journal.json.
// journal.json is a content-addressed cache keyed by sha(prompt + KEY_OPTS), and
// KEY_OPTS (journal.ts:15-25) deliberately EXCLUDES `label` and `phase`, so any
// label/phase read from there is undefined/garbage. The journal can only serve
// as a coarse occurrence cross-check, never as a source of truth.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

interface StartRunCall {
	toolName: string;
	runId: string | null;
	runDir: string | null;
	statusResource: string | null;
}

// How the host launched the workflow. The skill documents TWO equivalent routes: the MCP
// inline route (agent_workflows_start_run) and the CLI route (`agent-workflows run <script>`).
// capture-strategy must report orchestration for BOTH — counting only the MCP tool-call
// silently mis-reports a CLI-route launch as "direct".
type LaunchRoute = "mcp" | "cli" | "filesystem" | "none";

interface StrategySummary {
	hostJsonl: string;
	startRunCalls: StartRunCall[];
	launchRoute: LaunchRoute;
	cliLaunchCommands: string[];
	resolvedRunId: string | null;
	realizedAgentCount: number | null;
	agents: Array<{ label: string | null; phase: string | null }>;
	phases: string[];
}

const EXACT_START_RUN_TOOL = "agent_workflows_start_run";

if (import.meta.main) {
	const hostJsonlArg = process.argv[2];
	// Optional: the directory that contains the launched run dir
	// (`.agent-workflows/runs`). When omitted we resolve relative to cwd, matching
	// where the engine writes runs.
	const runsRootArg = process.argv[3];
	if (!hostJsonlArg) {
		throw new Error(
			"usage: bun evals/scripts/capture-strategy.ts <host.jsonl> [runs-root-dir]",
		);
	}
	const summary = captureStrategy(hostJsonlArg, runsRootArg);
	process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

export function captureStrategy(
	hostJsonlPath: string,
	runsRoot?: string,
): StrategySummary {
	const lines = readFileSync(hostJsonlPath, "utf8").split("\n");

	const startRunCalls: StartRunCall[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let evt: unknown;
		try {
			evt = JSON.parse(trimmed);
		} catch {
			continue; // non-JSON noise
		}
		// A single JSONL event may carry the tool name and the start_run result in
		// different shapes depending on the host's item encoding. We walk the event
		// for any node whose tool/function name is EXACTLY the start_run tool, and
		// pair it with the start_run result payload found in (or alongside) it.
		for (const node of findExactStartRunNodes(evt)) {
			const payload = findStartRunResult(node) ?? findStartRunResult(evt);
			startRunCalls.push({
				toolName: EXACT_START_RUN_TOOL,
				runId: payload?.runId ?? null,
				runDir: payload?.runDir ?? null,
				statusResource: payload?.statusResource ?? null,
			});
		}
	}

	// Resolve the launched runId from the start_run result shape (mcp.ts:72-82).
	let resolvedRunId =
		startRunCalls.map((c) => c.runId).find((id) => id != null) ?? null;
	let resolvedRunDir: string | null = null;
	let launchRoute: LaunchRoute = startRunCalls.length ? "mcp" : "none";

	// CLI route: the host ran `agent-workflows run <script>` (or `bun …/cli.ts run …`) in a
	// shell instead of calling the MCP tool. That produces no start_run tool-call, so recover
	// the launch from the run store on disk — the authoritative record for BOTH routes.
	const cliLaunchCommands = findCliLaunchCommands(lines);
	if (!resolvedRunId) {
		const fromDisk = resolveRunFromRunStore(runsRoot, hostJsonlPath);
		if (fromDisk) {
			resolvedRunId = fromDisk.runId;
			resolvedRunDir = fromDisk.runDir;
			launchRoute = cliLaunchCommands.length ? "cli" : "filesystem";
		}
	}

	let realizedAgentCount: number | null = null;
	let agents: Array<{ label: string | null; phase: string | null }> = [];
	let phases: string[] = [];

	if (resolvedRunId) {
		const runDir =
			resolvedRunDir ??
			resolveRunDir(resolvedRunId, startRunCalls, runsRoot, hostJsonlPath);

		// Authoritative realized count: result.json.summary.agents (engine.ts:346-354).
		const result = readJson(path.join(runDir, "result.json"));
		const resultSummary = result?.summary as { agents?: unknown } | undefined;
		const count = resultSummary?.agents;
		realizedAgentCount = typeof count === "number" ? count : null;

		// Labels / phases: status.json agents[].label/.phase + phases (progress.ts:40-49).
		const status = readJson(path.join(runDir, "status.json"));
		const statusAgents = status?.agents;
		if (Array.isArray(statusAgents)) {
			agents = statusAgents.map((a: { label?: unknown; phase?: unknown }) => ({
				label: typeof a?.label === "string" ? a.label : null,
				phase: typeof a?.phase === "string" ? a.phase : null,
			}));
		}
		const statusPhases = status?.phases;
		if (Array.isArray(statusPhases)) {
			phases = statusPhases.filter(
				(p: unknown): p is string => typeof p === "string",
			);
		}
	}

	return {
		hostJsonl: hostJsonlPath,
		startRunCalls,
		launchRoute,
		cliLaunchCommands,
		resolvedRunId,
		realizedAgentCount,
		agents,
		phases,
	};
}

// Shell commands in the stream that launch a workflow via the CLI route, e.g.
// `agent-workflows run <script> --json` or `bun src/cli/cli.ts run <script>`.
function findCliLaunchCommands(lines: string[]): string[] {
	const out: string[] = [];
	const re = /(agent-workflows|cli\.ts)\s+run\s+\S+/;
	for (const line of lines) {
		const t = line.trim();
		if (!t.includes(" run ")) continue;
		let evt: unknown;
		try {
			evt = JSON.parse(t);
		} catch {
			continue;
		}
		const visit = (node: unknown) => {
			if (!node || typeof node !== "object") return;
			if (Array.isArray(node)) return node.forEach(visit);
			const rec = node as Record<string, unknown>;
			const cmd = rec.command;
			if (typeof cmd === "string" && re.test(cmd) && !out.includes(cmd)) {
				out.push(cmd);
			}
			for (const v of Object.values(rec)) visit(v);
		};
		visit(evt);
	}
	return out;
}

// Authoritative fallback: scan the run store under the host cwd and pick the run with the
// most agents (the real workflow; a lint-only/aborted attempt has fewer or none). Used when
// the stream carried no MCP start_run result — a CLI-route launch or an unparsed encoding.
function resolveRunFromRunStore(
	runsRoot: string | undefined,
	hostJsonlPath: string,
): { runId: string; runDir: string } | null {
	const base = runsRoot ?? path.dirname(path.resolve(hostJsonlPath));
	const runsDir = path.join(base, ".agent-workflows", "runs");
	let ids: string[];
	try {
		ids = readdirSync(runsDir);
	} catch {
		return null;
	}
	let best: { runId: string; runDir: string; agents: number } | null = null;
	for (const id of ids) {
		const runDir = path.join(runsDir, id);
		const result = readJson(path.join(runDir, "result.json"));
		const summary = result?.summary as { agents?: unknown } | undefined;
		const agents = typeof summary?.agents === "number" ? summary.agents : 0;
		if (!best || agents > best.agents) best = { runId: id, runDir, agents };
	}
	return best ? { runId: best.runId, runDir: best.runDir } : null;
}

// Yield every object in the event tree whose tool/function name field equals the
// EXACT start_run tool name. Matching the whole string (not a substring) avoids
// matching `agent_workflows_resume_run` or over-matching a longer name.
function findExactStartRunNodes(value: unknown): unknown[] {
	const out: unknown[] = [];
	// Each matched node is recorded once; `consumed` holds inner descriptor
	// objects (e.g. a `function:{name}` child) already accounted for by their
	// parent tool-call node, so they are not re-matched as a second call.
	const consumed = new Set<unknown>();
	const visit = (node: unknown) => {
		if (!node || typeof node !== "object") return;
		if (Array.isArray(node)) {
			for (const child of node) visit(child);
			return;
		}
		const record = node as Record<string, unknown>;
		// A nested function descriptor: { function: { name, arguments } }. The
		// OUTER node is the tool-call; mark the inner descriptor consumed so the
		// same call is not counted twice.
		const fn = record.function as Record<string, unknown> | undefined;
		const viaFunction = fn?.name === EXACT_START_RUN_TOOL;
		// Tool name surfaces under different keys across host item encodings; an
		// exact (===) compare on any of them is the match. Codex's JSONL encodes an MCP
		// call as { type:'mcp_tool_call', server:'agent-workflows', tool:'agent_workflows_start_run',
		// arguments, result } — so `tool` is the load-bearing key for the codex host.
		const viaDirectKey =
			!consumed.has(record) &&
			["name", "tool_name", "toolName", "function_name", "tool"].some(
				(key) => record[key] === EXACT_START_RUN_TOOL,
			);
		if (viaFunction || viaDirectKey) {
			out.push(record);
			if (fn) consumed.add(fn);
		}
		for (const child of Object.values(record)) visit(child);
	};
	visit(value);
	return out;
}

// Locate the start_run result payload (mcp.ts:72-82 → { runId, runDir,
// statusResource, ... }) anywhere within a node, including when it is delivered
// as a JSON string in an MCP content[].text field or under structuredContent.
function findStartRunResult(
	value: unknown,
): { runId: string; runDir?: string; statusResource?: string } | null {
	const visit = (
		node: unknown,
	): { runId: string; runDir?: string; statusResource?: string } | null => {
		if (!node) return null;
		if (typeof node === "string") {
			const trimmed = node.trim();
			if (!trimmed.startsWith("{")) return null;
			try {
				return visit(JSON.parse(trimmed));
			} catch {
				return null;
			}
		}
		if (typeof node !== "object") return null;
		if (Array.isArray(node)) {
			for (const child of node) {
				const hit = visit(child);
				if (hit) return hit;
			}
			return null;
		}
		const record = node as Record<string, unknown>;
		if (typeof record.runId === "string") {
			return {
				runId: record.runId,
				runDir: typeof record.runDir === "string" ? record.runDir : undefined,
				statusResource:
					typeof record.statusResource === "string"
						? record.statusResource
						: undefined,
			};
		}
		for (const child of Object.values(record)) {
			const hit = visit(child);
			if (hit) return hit;
		}
		return null;
	};
	return visit(value);
}

// Resolve the on-disk run dir for a runId. The start_run result's runDir is
// relative to the host's cwd (mcp.ts:77 `path.relative(cwd, runDir)`); when we
// know that cwd (via runsRoot) we join, otherwise we fall back to the standard
// run-store layout `<runsRoot>/.agent-workflows/runs/<runId>`.
function resolveRunDir(
	runId: string,
	calls: StartRunCall[],
	runsRoot: string | undefined,
	hostJsonlPath: string,
): string {
	const base = runsRoot ?? path.dirname(path.resolve(hostJsonlPath));
	const fromCall = calls.find((c) => c.runId === runId)?.runDir;
	if (fromCall) return path.resolve(base, fromCall);
	return path.join(base, ".agent-workflows", "runs", runId);
}

function readJson(file: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}
