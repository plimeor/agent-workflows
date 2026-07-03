#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
	McpServer,
	ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";
import {
	configuredAuthorizedRoots,
	getRun,
	lintSource,
	listRuns,
	normalizeCwd,
	resolveRunCwd,
} from "../engine";
import { DEFAULT_HARNESS } from "./harness";
import {
	prepareResumeRun,
	prepareRun,
	startDetachedRun,
	writeControlCommand,
} from "./run-control";

const server = new McpServer({ name: "agent-workflows", version: "0.1.1" });
let mcpDefaultHarness = DEFAULT_HARNESS;

export function __testSetMcpDefaultHarness(harnessId?: string | null) {
	mcpDefaultHarness = harnessId || DEFAULT_HARNESS;
}

// Exposed for characterization tests so they can drive the real start_run handler
// (including its fail-closed lint gate) without a live MCP transport.
export const __testStartRunTool = server.registerTool(
	"agent_workflows_start_run",
	{
		description:
			"Start a detached Agent Workflows run and return immediately with its run id.",
		title: "Start Agent Workflows Run",
		inputSchema: {
			args: z.any().optional(),
			budget: z.number().positive().optional(),
			concurrency: z.number().int().positive().optional(),
			cwd: z.string().optional(),
			harness: z.string().optional(),
			name: z.string().optional(),
			scriptRef: z.string().optional(),
			source: z.string().optional(),
		},
	},
	async (input) => {
		if (input.source != null) {
			const lint = lintSource(input.source);
			if (!lint.ok) return jsonResult({ error: lint.error, ok: false });
		}
		const cwd = await normalizeCwd(input.cwd || process.cwd());
		const prepared = await prepareRun({
			scriptRef: input.scriptRef,
			source: input.source,
			name: input.name,
			cwd,
			args: input.args,
			budget: input.budget ?? null,
			concurrency: input.concurrency || null,
			detached: true,
			harness: input.harness || mcpDefaultHarness,
		});
		const proc = await startDetachedRun(prepared);
		return jsonResult({
			journalResource: runResourceUri(prepared.runId, "journal"),
			pid: proc.pid,
			progressLogResource: runResourceUri(prepared.runId, "progress-log"),
			resultResource: runResourceUri(prepared.runId, "result"),
			runDir: path.relative(cwd, prepared.runDir),
			runId: prepared.runId,
			scriptResource: runResourceUri(prepared.runId, "script"),
			status: "running",
			statusResource: runResourceUri(prepared.runId, "status"),
		});
	},
);

server.registerTool(
	"agent_workflows_lint",
	{
		description:
			"Statically lint an Agent Workflows script source (meta + body compile) without running it.",
		title: "Lint Agent Workflows Source",
		inputSchema: {
			source: z.string(),
		},
	},
	async (input) => jsonResult(lintSource(input.source)),
);

server.registerTool(
	"agent_workflows_resume_run",
	{
		description: "Start a detached run that resumes from a prior run journal.",
		title: "Resume Agent Workflows Run",
		inputSchema: {
			args: z.any().optional(),
			budget: z.number().positive().optional(),
			concurrency: z.number().int().positive().optional(),
			cwd: z.string().optional(),
			harness: z.string().optional(),
			runId: z.string(),
			scriptRef: z.string().optional(),
		},
	},
	async (input) => {
		const cwd = await normalizeCwd(input.cwd || process.cwd());
		const prepared = await prepareResumeRun(
			compact({
				resumeFromRunId: input.runId,
				scriptRef: input.scriptRef,
				cwd,
				args: input.args,
				budget: input.budget ?? undefined,
				concurrency: input.concurrency,
				detached: true,
				harness: input.harness,
			}),
		);
		const proc = await startDetachedRun(prepared);
		return jsonResult({
			journalResource: runResourceUri(prepared.runId, "journal"),
			pid: proc.pid,
			progressLogResource: runResourceUri(prepared.runId, "progress-log"),
			resultResource: runResourceUri(prepared.runId, "result"),
			resumedFrom: input.runId,
			runDir: path.relative(cwd, prepared.runDir),
			runId: prepared.runId,
			scriptResource: runResourceUri(prepared.runId, "script"),
			status: "running",
			statusResource: runResourceUri(prepared.runId, "status"),
		});
	},
);

server.registerTool(
	"agent_workflows_get_run",
	{
		description:
			"Read durable status/result data for one Agent Workflows run. Returns a compact progress summary by default (state, currentPhase, per-phase agent counts, recent narration, and result once terminal) — enough to relay a one-line status without re-reading the full agent tree each poll. Pass view:'full' to drill into the complete agents[]/launch/process/heartbeat/control payload. waitMs is only a read deadline; it never stops or times out the run.",
		title: "Get Agent Workflows Run",
		inputSchema: {
			cwd: z.string().optional(),
			includeResult: z.boolean().optional(),
			logTailBytes: z.number().int().positive().max(1_000_000).optional(),
			runId: z.string(),
			view: z.enum(["summary", "full"]).optional(),
			waitMs: z.number().int().positive().max(300_000).optional(),
		},
	},
	async (input) => {
		const cwd = await normalizeCwd(input.cwd || process.cwd());
		return jsonResult(
			await __testGetRunWithWait(cwd, input.runId, {
				includeResult: input.includeResult !== false,
				logTailBytes: input.logTailBytes || 0,
				view: input.view ?? "summary",
				waitMs: input.waitMs,
			}),
		);
	},
);

server.registerTool(
	"agent_workflows_list_runs",
	{
		description:
			"List recent Agent Workflows runs from the workspace run store.",
		title: "List Agent Workflows Runs",
		inputSchema: {
			cwd: z.string().optional(),
			limit: z.number().int().positive().max(100).optional(),
			state: z
				.enum([
					"starting",
					"running",
					"done",
					"error",
					"stopped",
					"stale",
					"unknown",
				])
				.optional(),
		},
	},
	async (input) => {
		const cwd = await normalizeCwd(input.cwd || process.cwd());
		const runs = await listRuns(cwd, {
			limit: input.limit || 30,
			state: input.state,
		});
		return jsonResult(runs);
	},
);

server.registerTool(
	"agent_workflows_control_run",
	{
		description:
			"Write a control command for a running detached Agent Workflows run. Use stop-run or stop-agent only after explicit user confirmation.",
		title: "Control Agent Workflows Run",
		inputSchema: {
			agentId: z.string().optional(),
			command: z.enum([
				"stop-run",
				"pause-admission",
				"resume-admission",
				"stop-agent",
				"restart-agent",
			]),
			cwd: z.string().optional(),
			reason: z.string().optional(),
			runId: z.string(),
		},
	},
	async (input) => {
		const cwd = await normalizeCwd(input.cwd || process.cwd());
		const control = await writeControlCommand(cwd, input.runId, {
			agentId: input.agentId || null,
			command: input.command,
			reason: input.reason || null,
		});
		return jsonResult({ runId: input.runId, control });
	},
);

server.registerResource(
	"agent-workflows-run-resource",
	new ResourceTemplate("agent-workflows://runs/{runId}/{kind}", {
		list: async () => {
			const roots = await configuredAuthorizedRoots();
			const runIds = new Set<string>();
			for (const root of roots) {
				const runs = await listRuns(root).catch(() => []);
				for (const run of runs) {
					if (run) runIds.add(run.runId);
				}
			}
			return {
				resources: [...runIds].flatMap((runId) =>
					["status", "result", "progress-log", "script", "journal"].map(
						(kind) => ({
							name: `Agent Workflows ${runId} ${kind}`,
							title: `Agent Workflows ${runId} ${kind}`,
							uri: runResourceUri(runId, kind),
						}),
					),
				),
			};
		},
	}),
	{
		description: "Durable Agent Workflows run files exposed as MCP resources.",
		mimeType: "application/json",
		title: "Agent Workflows Run Resource",
	},
	async (uri, variables) => readRunResource(uri, variables),
);

export async function startMcpServer(
	opts: { defaultHarness?: string | null } = {},
) {
	__testSetMcpDefaultHarness(opts.defaultHarness);
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

if (import.meta.main) {
	await startMcpServer();
}

function jsonResult(value: unknown) {
	const structuredContent =
		value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: { value };
	return {
		content: [{ text: JSON.stringify(value, null, 2), type: "text" as const }],
		structuredContent,
	};
}

function compact(value: Record<string, any>) {
	return Object.fromEntries(
		Object.entries(value).filter(([, v]) => v !== undefined),
	);
}

const TERMINAL_STATES = new Set(["done", "error", "stopped"]);

// Deadline-bounded get_run read. With no `waitMs` it performs exactly one read
// (single-shot). With `waitMs` it re-reads (read-only) until the run is terminal
// or the deadline elapses, then returns the latest read so the caller can keep
// polling when not yet terminal. The wait lives here, never in core getRun.
// Exported under a `__test` name so the characterization tests can drive the same
// code path the get_run handler uses.
export async function __testGetRunWithWait(
	cwd: string,
	runId: string,
	options: {
		includeResult?: boolean;
		logTailBytes?: number;
		view?: "summary" | "full";
		waitMs?: number;
	} = {},
) {
	const view = options.view ?? "summary";
	const readOptions = {
		includeResult: options.includeResult !== false,
		// The summary projection never surfaces the raw progress.log tail, so don't
		// even read it; only the full view honors logTailBytes.
		logTailBytes: view === "full" ? options.logTailBytes || 0 : 0,
	};
	const deadline = options.waitMs != null ? Date.now() + options.waitMs : null;
	while (true) {
		const run = await getRun(cwd, runId, readOptions);
		const terminal =
			run.result != null || TERMINAL_STATES.has(String(run.state));
		if (deadline == null || terminal || Date.now() >= deadline)
			return projectRun(run, view);
		const remaining = deadline - Date.now();
		await new Promise((resolve) =>
			setTimeout(resolve, Math.min(50, Math.max(1, remaining))),
		);
	}
}

// Compact MCP read projection. `get_run` is polled repeatedly across a long run, and
// the full read — status.agents[] plus launch/process/heartbeat/control plus a
// monotonically growing progress.log tail — accumulates in the caller's context on
// every poll. The summary view returns only what a progress relay needs: per-phase
// agent counts (non-zero states only), the recent narration, and the terminal result.
// Each poll then stays bounded regardless of agent count or run length. `view: 'full'`
// returns the unprojected read for drilling into one run. The projection lives in the
// MCP layer only; getRun core and status.json are unchanged, so CLI watch/ps still see
// the full agent tree.
function projectRun(run: any, view: "summary" | "full") {
	if (view === "full") return run;
	const status = run.status || {};
	const agents = Array.isArray(status.agents) ? status.agents : [];
	const declared = Array.isArray(status.phases) ? status.phases : [];
	const counts = new Map<string, Record<string, number>>();
	for (const a of agents) {
		const title = a.phase ?? "-";
		const bucket = counts.get(title) || {};
		bucket[a.state] = (bucket[a.state] || 0) + 1;
		counts.set(title, bucket);
	}
	const titles = [...declared];
	for (const title of counts.keys())
		if (!titles.includes(title)) titles.push(title);
	const phases = titles.map((title) => ({
		title,
		...(counts.get(title) || {}),
	}));
	const narration = Array.isArray(status.narration)
		? status.narration.slice(-5).map((n: any) => n?.message ?? String(n))
		: [];
	return {
		runId: run.runId,
		name: status.name ?? run.launch?.name ?? null,
		state: run.state,
		currentPhase: status.currentPhase ?? null,
		updatedAt: status.updatedAt ?? null,
		phases,
		narration,
		result: run.result ?? null,
		view: "summary",
	};
}

function runResourceUri(runId: string, kind: string) {
	return `agent-workflows://runs/${encodeURIComponent(runId)}/${kind}`;
}

async function readRunResource(
	uri: URL,
	variables: Record<string, string | string[]>,
) {
	const runId = String(variables.runId);
	const kind = String(variables.kind);
	const cwd = await resolveRunCwd(runId);
	if (cwd == null) {
		throw new Error(`unknown Agent Workflows run '${runId}'`);
	}
	const run = await getRun(cwd, runId, {
		includeResult: true,
		logTailBytes: 12000,
	});

	if (kind === "status")
		return resourceText(uri, run.status || null, "application/json");
	if (kind === "result")
		return resourceText(uri, run.result || null, "application/json");
	if (kind === "progress-log") {
		const text = await readFile(
			path.join(run.runDir, "progress.log"),
			"utf8",
		).catch(() => "");
		return resourceText(uri, text, "text/plain");
	}
	if (kind === "script") {
		const text = await readFile(
			path.join(run.runDir, "script.mjs"),
			"utf8",
		).catch(() => "");
		return resourceText(uri, text, "text/javascript");
	}
	if (kind === "journal") {
		const text = await readFile(
			path.join(run.runDir, "journal.json"),
			"utf8",
		).catch(() => "null");
		return {
			contents: [{ mimeType: "application/json", text, uri: uri.href }],
		};
	}
	throw new Error(`unknown Agent Workflows run resource kind '${kind}'`);
}

function resourceText(uri: URL, value: unknown, mimeType: string) {
	const text =
		typeof value === "string" ? value : JSON.stringify(value, null, 2);
	return { contents: [{ mimeType, text, uri: uri.href }] };
}
