#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
// `agent-workflows` — the invocation surface for multi-agent workflows on any supported
// CLI coding-agent harness, built on @plimeor/command-kit (Bun-first command declarations)
// + valibot schemas.
//   agent-workflows run <script|name> [opts]   run a workflow
//   other commands: resume · list · lint · ps · watch · control · doctor · mcp · install · uninstall
import path from "node:path";
import { defineCli, defineCommand } from "@plimeor/command-kit";
import { toStandardJsonSchema } from "@valibot/to-json-schema";
import * as v from "valibot";
import {
	getRun,
	lintSource,
	listRuns,
	listWorkflows,
	normalizeCwd,
	runsDir,
	workflowDirs,
} from "../engine";
import {
	DEFAULT_HARNESS,
	EXTENSION_ID,
	extensionSpec,
	harnessIds,
	openHarness,
} from "./harness";
import { startMcpServer } from "./mcp";
import {
	executePreparedRun,
	prepareResumeRun,
	prepareRun,
	startDetachedRun,
	writeControlCommand,
} from "./run-control";

// Whether the project `.gitignore` covers the `.agent-workflows/` run directory, so
// `doctor` can warn when run journals would otherwise be committed. A missing file or a
// commented-out entry both read as "not covered".
async function isAgentWorkflowsGitignored(cwd: string): Promise<boolean> {
	let text: string;
	try {
		text = await readFile(path.join(cwd, ".gitignore"), "utf8");
	} catch {
		return false;
	}
	return text.split("\n").some((line) => {
		const entry = line.trim();
		return entry === ".agent-workflows/" || entry === ".agent-workflows";
	});
}

// One shared next-step hint: the run dir plus the exact runnable command. Used by the
// detached run-start, the foreground summary, and the `control` human line so each
// surface tells the operator what to run next (never leaked into any JSON envelope).
function nextStepHint(runDir: string, command: string): string {
	return `  run dir: ${runDir}\n  next: ${command}\n`;
}

// ── helpers ───────────────────────────────────────────────────────────────────
async function parseArgsInput(o: {
	args?: string;
	argsFile?: string;
}): Promise<unknown> {
	if (o.argsFile) return JSON.parse(await readFile(o.argsFile, "utf8"));
	if (o.args != null) {
		// A value that LOOKS like a JSON object/array must parse — a typo (e.g. an unquoted key)
		// must not silently degrade to a raw string that the workflow then ignores. Any other input
		// is treated as a valid raw string arg (e.g. a prompt) when it isn't valid JSON.
		const looksStructured =
			o.args.trimStart().startsWith("{") || o.args.trimStart().startsWith("[");
		try {
			return JSON.parse(o.args);
		} catch (e) {
			if (looksStructured) {
				throw new Error(
					`--args looks like JSON but failed to parse: ${e instanceof Error ? e.message : String(e)}`,
				);
			}
			return o.args; // a bare raw string
		}
	}
	return undefined;
}

// `ps` column formatters (host CLI code — Date.now()/new Date() are allowed here, this is
// not a DSL script). `formatAbs` renders a started-at timestamp; `formatAge` renders a
// compact relative elapsed string ("2m", "3h", "1d").
function formatAbs(ms: unknown): string {
	if (typeof ms !== "number" || !Number.isFinite(ms)) return "-";
	return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

function formatAge(ms: unknown): string {
	if (typeof ms !== "number" || !Number.isFinite(ms)) return "-";
	const delta = Math.max(0, Date.now() - ms);
	const s = Math.floor(delta / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
}

// --budget is an ADVISORY cap a script can read (e.g. `budget.total` to size fan-out); the harness
// reports no token usage, so it is not an enforced ceiling. A non-positive value is still
// meaningless, so reject it loudly rather than silently coercing it to "unlimited".
function parseBudget(raw: unknown): number | null {
	if (raw == null || raw === "") return null;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) {
		throw new Error(`--budget must be a positive number (got ${String(raw)})`);
	}
	return n;
}

// Shared by `run` and `resume`.
async function executeRun(
	scriptRef: string,
	o: Record<string, any>,
	resumeFromRunId: string | null,
): Promise<unknown> {
	const cwd = await normalizeCwd(o.cwd || process.cwd());
	const json = o.json === true;
	const parsedArgs = await parseArgsInput(o);
	const budget = parseBudget(o.budget);
	const launchInput = {
		scriptRef,
		resumeFromRunId,
		cwd,
		detached: o.detach === true,
	};
	if (parsedArgs !== undefined) (launchInput as any).args = parsedArgs;
	if (o.budget != null) (launchInput as any).budget = budget;
	if (o.concurrency != null) (launchInput as any).concurrency = o.concurrency;
	if (o.harness) (launchInput as any).harness = o.harness;
	if (!resumeFromRunId) {
		if (!("budget" in launchInput)) (launchInput as any).budget = null;
	}

	const prepared = resumeFromRunId
		? await prepareResumeRun({
				...launchInput,
				resumeFromRunId,
				scriptRef: o.scriptOverride || scriptRef,
			})
		: await prepareRun(launchInput);

	if (!json)
		process.stderr.write(
			`▶ agent-workflows run ${scriptRef}  (runId ${prepared.runId})\n`,
		);

	if (o.detach === true) {
		const proc = await startDetachedRun(prepared);
		const data = {
			pid: proc.pid,
			runDir: path.relative(cwd, prepared.runDir),
			runId: prepared.runId,
			status: "running",
		};
		if (json) return data;
		process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
		process.stderr.write(
			nextStepHint(data.runDir, `agent-workflows watch ${data.runId} --follow`),
		);
		return undefined;
	}

	// Foreground run: forward Ctrl-C / SIGTERM into the same cooperative-abort seam the detached
	// run-process uses, so an interrupt kills in-flight harness children and records a terminal
	// `stopped` result + final journal flush instead of orphaning subprocesses on a hard exit.
	const controller = new AbortController();
	const onSignal = () => controller.abort();
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	let out: any;
	try {
		out = await executePreparedRun(prepared, {
			quiet: json,
			signal: controller.signal,
		});
	} finally {
		process.removeListener("SIGINT", onSignal);
		process.removeListener("SIGTERM", onSignal);
	}

	if (json) return out.result; // command-kit prints { ok:true, data }
	const s = out.summary;
	const mark = out.status === "stopped" ? "■" : "✓";
	process.stderr.write(
		`\n${mark} ${out.meta.name} ${out.status} — ${s.agents} agents (${s.done} ok, ${s.cached} cached, ${s.errored} err), ` +
			`${Math.round(s.elapsedMs / 100) / 10}s\n` +
			`  runId: ${out.runId}   →  ${out.runDir}\n` +
			nextStepHint(
				out.runDir,
				`agent-workflows resume ${out.runId}  (or watch ${out.runId} --follow)`,
			),
	);
	process.stdout.write(
		typeof out.result === "string"
			? `${out.result}\n`
			: `${JSON.stringify(out.result, null, 2)}\n`,
	);
	return undefined;
}

const RUN_OPTIONS = v.object({
	args: v.optional(
		v.pipe(
			v.string(),
			v.description(
				"inline JSON (or raw string) passed to the workflow as `args`",
			),
		),
	),
	argsFile: v.optional(
		v.pipe(v.string(), v.description("path to a JSON file for `args`")),
	),
	budget: v.optional(
		v.pipe(
			v.string(),
			v.description(
				"advisory budget cap a script can read via budget.total (number)",
			),
		),
	),
	concurrency: v.optional(
		v.pipe(v.string(), v.description("override concurrency (number)")),
	),
	cwd: v.optional(
		v.pipe(v.string(), v.description("working root for the run")),
	),
	detach: v.optional(
		v.pipe(
			v.boolean(),
			v.description("start the workflow in a detached background run process"),
		),
	),
	harness: v.optional(
		v.pipe(
			v.string(),
			v.description(
				`host harness to run subagents on (default: ${DEFAULT_HARNESS})`,
			),
		),
	),
	json: v.optional(
		v.pipe(v.boolean(), v.description("emit only the JSON result envelope")),
	),
	resumeFrom: v.optional(
		v.pipe(v.string(), v.description("runId to replay the journal from")),
	),
});

// ── render helpers for ps/watch ─────────────────────────────────────────────────
function renderStatus(status: any, result: any): string {
	const lines: string[] = [];
	lines.push(
		`■ ${status.name}  (${result?.status || "running"})  runId ${status.runId}`,
	);
	const byPhase = new Map<string | null, any[]>();
	for (const ph of status.phases) byPhase.set(ph, []);
	for (const a of status.agents) {
		const key = status.phases.includes(a.phase) ? a.phase : null;
		let list = byPhase.get(key);
		if (!list) {
			list = [];
			byPhase.set(key, list);
		}
		list.push(a);
	}
	const icon: Record<string, string> = {
		cached: "⤳",
		done: "✓",
		error: "✗",
		paused: "Ⅱ",
		queued: "·",
		running: "◐",
		stopped: "■",
	};
	// Narrators (log() lines) render ABOVE the phase tree, matching the Workflow tool.
	for (const n of (status.narration || []).slice(-8))
		lines.push(`◆ ${n.message}`);
	for (const [ph, list] of byPhase) {
		if (!list.length && ph === null) continue;
		lines.push(`┌─ ${ph ?? "(no phase)"}`);
		for (const a of list)
			lines.push(
				`│  ${icon[a.state] || "·"} ${a.label}${a.detail ? `  ${a.detail}` : ""}`,
			);
	}
	return lines.join("\n");
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const cli = defineCli({
	description:
		"Deterministic multi-agent workflow orchestration for CLI coding agents",
	name: "agent-workflows",
	schemaAdapter: { toStandardJsonSchema },
	commands: [
		defineCommand("run", {
			argBindings: [{ name: "script" }],
			args: v.object({
				script: v.pipe(
					v.string(),
					v.description("workflow .mjs path or a named workflow"),
				),
			}),
			description:
				"Run a workflow script (or named workflow) by orchestrating harness subagents",
			options: RUN_OPTIONS,
			run: (ctx) =>
				executeRun(
					ctx.args.script,
					ctx.options as any,
					(ctx.options as any).resumeFrom || null,
				),
		}),

		defineCommand("resume", {
			argBindings: [{ name: "runId" }, { name: "script", optional: true }],
			args: v.object({
				runId: v.pipe(v.string(), v.description("the runId to resume")),
				script: v.optional(
					v.pipe(
						v.string(),
						v.description("script path (defaults to the saved copy)"),
					),
				),
			}),
			description:
				"Re-run a workflow, replaying a prior run's journal (unchanged agents are free)",
			options: RUN_OPTIONS,
			run: async (ctx) => {
				const cwd = await normalizeCwd(
					(ctx.options as any).cwd || process.cwd(),
				);
				const options = {
					...(ctx.options as any),
					scriptOverride: ctx.args.script || null,
				};
				const script =
					ctx.args.script ||
					path.join(
						cwd,
						".agent-workflows",
						"runs",
						ctx.args.runId,
						"script.mjs",
					);
				return executeRun(script, options, ctx.args.runId);
			},
		}),

		defineCommand("list", {
			description: "List named workflows",
			options: v.object({
				cwd: v.optional(v.string()),
				json: v.optional(v.pipe(v.boolean(), v.description("emit JSON"))),
			}),
			run: async (ctx) => {
				const cwd = await normalizeCwd(
					(ctx.options as any).cwd || process.cwd(),
				);
				const wfs = await listWorkflows(workflowDirs(cwd));
				if ((ctx.options as any).json) return wfs;
				if (!wfs.length) process.stdout.write("no named workflows found\n");
				for (const w of wfs)
					process.stdout.write(
						`${w.name}\n  ${w.description}\n${w.whenToUse ? `  when: ${w.whenToUse}\n` : ""}`,
					);
				return undefined;
			},
		}),

		defineCommand("lint", {
			argBindings: [{ name: "script" }],
			args: v.object({
				script: v.pipe(v.string(), v.description("workflow .mjs path")),
			}),
			description:
				"Static-check a workflow script (meta is a pure literal + body compiles)",
			options: v.object({ cwd: v.optional(v.string()) }),
			run: async (ctx) => {
				const cwd = await normalizeCwd(
					(ctx.options as any).cwd || process.cwd(),
				);
				const scriptPath = path.resolve(cwd, ctx.args.script);
				const res = lintSource(await readFile(scriptPath, "utf8"), scriptPath);
				if (!res.ok) throw new Error(`${ctx.args.script}: ${res.error}`);
				if (!res.meta) throw new Error(`${ctx.args.script}: missing meta`);
				process.stdout.write(`✓ ${res.meta.name}: ${res.meta.description}\n`);
				return undefined;
			},
		}),

		defineCommand("ps", {
			description: "List recent runs",
			options: v.object({ cwd: v.optional(v.string()) }),
			run: async (ctx) => {
				const cwd = await normalizeCwd(
					(ctx.options as any).cwd || process.cwd(),
				);
				const runs = await listRuns(cwd);
				if (!runs.length) {
					process.stdout.write("no runs yet\n");
					return undefined;
				}
				for (const r of runs.slice(0, 30)) {
					const status = r.status || {};
					const startedAt = r.status?.startedAt ?? r.launch?.createdAt;
					const lastActivity = r.status?.updatedAt ?? startedAt;
					process.stdout.write(
						`${String(r.state).padEnd(8)} ${String(r.runId).padEnd(20)} ${String(status.name || r.launch?.scriptRef || "").padEnd(24)} ${(status.agents || []).length} agents ${formatAbs(startedAt).padEnd(19)} ${formatAge(lastActivity)}\n`,
					);
				}
				return undefined;
			},
		}),

		defineCommand("watch", {
			argBindings: [{ name: "runId" }],
			args: v.object({
				runId: v.pipe(v.string(), v.description("runId to watch")),
			}),
			description:
				"Show a run's progress tree (optionally follow until it finishes)",
			optionShortcuts: { tail: "n" },
			options: v.object({
				cwd: v.optional(v.string()),
				follow: v.optional(
					v.pipe(v.boolean(), v.description("refresh until the run completes")),
				),
				tail: v.optional(
					v.pipe(
						v.string(),
						v.description(
							"stream the last N lines of the run's progress.log (alias: -n N)",
						),
					),
				),
			}),
			run: async (ctx) => {
				const cwd = await normalizeCwd(
					(ctx.options as any).cwd || process.cwd(),
				);
				const tailRaw = (ctx.options as any).tail;
				if (tailRaw != null) {
					const tailCount = Number(tailRaw);
					if (!Number.isFinite(tailCount) || tailCount <= 0) {
						throw new Error(
							`--tail/-n must be a positive number of lines (got ${String(tailRaw)})`,
						);
					}
					// Reuse the existing byte-oriented logTailBytes path and slice the
					// last N lines inline (run-store stays line-agnostic). A generous
					// byte budget covers long progress lines.
					const run = await getRun(cwd, ctx.args.runId, {
						logTailBytes: tailCount * 4096,
					});
					const log = run.progressLog;
					if (log) {
						const lines = log.split("\n").filter((line) => line.length > 0);
						const tailLines = lines.slice(-tailCount);
						if (tailLines.length)
							process.stdout.write(`${tailLines.join("\n")}\n`);
					}
					return undefined;
				}
				const once = async () => {
					const run = await getRun(cwd, ctx.args.runId);
					if (!run.status)
						throw new Error(`run '${ctx.args.runId}' has no status yet`);
					process.stdout.write(
						`\x1b[2J\x1b[H${renderStatus(run.status, run.result || { status: run.state })}\n`,
					);
					return (
						run.result?.status || (run.state === "stale" ? "stale" : undefined)
					);
				};
				if (!(ctx.options as any).follow) {
					await once();
					return undefined;
				}
				while (true) {
					let state: string | undefined;
					try {
						state = await once();
					} catch {
						/* status not ready */
					}
					if (state) break;
					await Bun.sleep(1000);
				}
				return undefined;
			},
		}),

		defineCommand("control", {
			argBindings: [{ name: "runId" }, { name: "command" }],
			args: v.object({
				command: v.pipe(
					v.string(),
					v.description(
						"stop-run|pause-admission|resume-admission|stop-agent|restart-agent",
					),
				),
				runId: v.pipe(v.string(), v.description("runId to control")),
			}),
			description: "Send a control command to a running workflow",
			options: v.object({
				agent: v.optional(
					v.pipe(
						v.string(),
						v.description("agent id for stop-agent/restart-agent"),
					),
				),
				cwd: v.optional(v.string()),
				json: v.optional(v.boolean()),
				reason: v.optional(
					v.pipe(v.string(), v.description("human-readable reason")),
				),
			}),
			run: async (ctx) => {
				const cwd = await normalizeCwd(
					(ctx.options as any).cwd || process.cwd(),
				);
				const payload = await writeControlCommand(cwd, ctx.args.runId, {
					agentId: (ctx.options as any).agent || null,
					command: ctx.args.command,
					reason: (ctx.options as any).reason || null,
				});
				if ((ctx.options as any).json) return payload;
				const controlRunDir = path.relative(
					cwd,
					path.join(runsDir(cwd), ctx.args.runId),
				);
				process.stdout.write(
					`control written: ${payload.command}${payload.agentId ? ` ${payload.agentId}` : ""}\n` +
						nextStepHint(
							controlRunDir,
							`agent-workflows control ${ctx.args.runId} stop-run  (or stop-agent <id>)`,
						),
				);
				return undefined;
			},
		}),

		defineCommand("doctor", {
			description:
				"Diagnose the selected harness, run directory, and gitignore coverage",
			options: v.object({
				cwd: v.optional(v.string()),
				harness: v.optional(
					v.pipe(
						v.string(),
						v.description(`harness to diagnose (default: ${DEFAULT_HARNESS})`),
					),
				),
			}),
			run: async (ctx) => {
				const cwd = await normalizeCwd(
					(ctx.options as any).cwd || process.cwd(),
				);
				const harnessId = (ctx.options as any).harness || DEFAULT_HARNESS;

				// Host detection/health live in @plimeor/harness; the CLI stays
				// host-neutral and just reports what the harness returns.
				let runnable = false;
				try {
					const handle = await openHarness(harnessId, cwd);
					runnable = true;
					process.stdout.write(
						`harness: ${handle.detection.id} detected (${handle.detection.binary?.command ?? "?"})\n`,
					);
					const health = await handle.health.check();
					process.stdout.write(
						`health: ${health.success ? "ok" : `FAILED — ${health.message}`}\n`,
					);
					if (!health.success) runnable = false;
				} catch (e) {
					process.stdout.write(
						`harness: ${harnessId} NOT available — ${e instanceof Error ? e.message : String(e)}\n`,
					);
				}

				const runDirPath = runsDir(cwd);
				process.stdout.write(`run dir: ${runDirPath}\n`);

				const gitignored = await isAgentWorkflowsGitignored(cwd);
				process.stdout.write(
					`.agent-workflows/ gitignored: ${gitignored ? "yes" : "no"}\n`,
				);

				process.stdout.write(`bun: ${Bun.version}\n`);
				if (!runnable) process.exitCode = 1;
				return undefined;
			},
		}),
		defineCommand("mcp", {
			description: "Start the stdio MCP server for host integration",
			options: v.object({
				harness: v.optional(
					v.pipe(
						v.string(),
						v.description(
							`default harness for workflow subagents launched through this MCP server (default: ${DEFAULT_HARNESS})`,
						),
					),
				),
			}),
			run: async (ctx) => {
				await startMcpServer({
					defaultHarness: (ctx.options as any).harness || DEFAULT_HARNESS,
				});
				return undefined;
			},
		}),

		defineCommand("install", {
			argBindings: [{ name: "host", optional: true }],
			args: v.object({
				host: v.optional(
					v.pipe(
						v.string(),
						v.description(
							`harness to install into (default: ${DEFAULT_HARNESS}; available: ${harnessIds().join(", ")})`,
						),
					),
				),
			}),
			options: v.object({ cwd: v.optional(v.string()) }),
			description:
				"Install agent-workflows (MCP server + skills + hooks) into a harness",
			run: async (ctx) => {
				const harnessId = ctx.args.host || DEFAULT_HARNESS;
				const handle = await openHarness(
					harnessId,
					(ctx.options as any).cwd || process.cwd(),
				);
				const result = await handle.extensions.install(
					extensionSpec(handle.detection.id),
				);
				if (!result.success) {
					throw new Error(
						`install into ${handle.detection.id} failed:\n${result.issues
							.map((issue) => `  - ${issue.reason}`)
							.join("\n")}`,
					);
				}
				process.stdout.write(
					`✓ installed agent-workflows into ${handle.detection.id}\n` +
						"  next: start a fresh host thread to pick up the workflow tools + skills\n",
				);
				return undefined;
			},
		}),

		defineCommand("uninstall", {
			argBindings: [{ name: "host", optional: true }],
			args: v.object({
				host: v.optional(
					v.pipe(
						v.string(),
						v.description(
							`harness to uninstall from (default: ${DEFAULT_HARNESS})`,
						),
					),
				),
			}),
			options: v.object({ cwd: v.optional(v.string()) }),
			description: "Remove agent-workflows from a harness",
			run: async (ctx) => {
				const handle = await openHarness(
					ctx.args.host || DEFAULT_HARNESS,
					(ctx.options as any).cwd || process.cwd(),
				);
				const result = await handle.extensions.uninstall(EXTENSION_ID);
				if (!result.success) {
					throw new Error(
						`uninstall from ${handle.detection.id} failed:\n${result.issues
							.map((issue) => `  - ${issue.reason}`)
							.join("\n")}`,
					);
				}
				process.stdout.write(
					`✓ removed agent-workflows from ${handle.detection.id}\n` +
						"  next: start a fresh host thread to drop the workflow tools\n",
				);
				return undefined;
			},
		}),
	],
});

await cli.serve(process.argv.slice(2));
