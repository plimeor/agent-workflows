// Workflow engine: loads a script, extracts its `meta`, runs the body in a vm sandbox with
// the DSL injected, and orchestrates the run (concurrency, budget, journal/resume, progress).

import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

import { writeJsonAtomic, writeTextAtomic } from "./atomic";
import { createBudget } from "./budget";
import { buildDsl } from "./hooks";
import { createJournal, loadJournal, saveJournal } from "./journal";
import { createProgress } from "./progress";
import {
	clampConcurrency,
	createSemaphore,
	defaultConcurrency,
} from "./scheduler";
import { resolveChildWorkflow } from "./workflows";

type WorkflowMeta = {
	name: string;
	description: string;
	phases?: Array<{ title?: string }>;
	whenToUse?: string;
	[key: string]: unknown;
};

// ── Script parsing ─────────────────────────────────────────────────────────

// Scan a balanced object/array literal starting at the first bracket on/after `from`.
function readBracketed(src: string, from: number): string {
	let i = from;
	while (i < src.length && src[i] !== "{" && src[i] !== "[") i++;
	if (i >= src.length) throw new Error("could not find meta object literal");
	const open = src[i];
	const close = open === "{" ? "}" : "]";
	let depth = 0;
	let str: string | null = null; // current string delimiter
	for (; i < src.length; i++) {
		const c = src[i];
		if (str) {
			if (c === "\\") i++;
			else if (c === str) str = null;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			str = c;
			continue;
		}
		if (c === "/" && src[i + 1] === "/") {
			const nl = src.indexOf("\n", i);
			i = nl < 0 ? src.length : nl;
			continue;
		}
		if (c === "/" && src[i + 1] === "*") {
			const end = src.indexOf("*/", i + 2);
			i = end < 0 ? src.length : end + 1;
			continue;
		}
		if (c === open) depth++;
		else if (c === close) {
			depth--;
			if (depth === 0)
				return src
					.slice(from, i + 1)
					.slice(src.slice(from, i + 1).indexOf(open));
		}
	}
	throw new Error("unbalanced meta object literal");
}

// Index of the first significant (non-whitespace, non-comment) character, or -1.
function firstSignificantIndex(src: string): number {
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		if (c === " " || c === "\t" || c === "\r" || c === "\n") {
			i++;
		} else if (c === "/" && src[i + 1] === "/") {
			const nl = src.indexOf("\n", i);
			i = nl < 0 ? src.length : nl + 1;
		} else if (c === "/" && src[i + 1] === "*") {
			const end = src.indexOf("*/", i + 2);
			i = end < 0 ? src.length : end + 2;
		} else {
			return i;
		}
	}
	return -1;
}

// The canonical contract bans spreads and template interpolation in `meta` (they can hide
// non-constant expressions). vm evaluation only catches free identifiers/calls, so scan the
// literal's own tokens (outside strings/comments) for `...` and backticks and reject them.
function assertPureLiteral(literal: string): void {
	let str: string | null = null;
	for (let i = 0; i < literal.length; i++) {
		const c = literal[i];
		if (str) {
			if (c === "\\") i++;
			else if (c === str) str = null;
			continue;
		}
		if (c === '"' || c === "'") {
			str = c;
		} else if (c === "`") {
			throw new Error("template literals are not allowed (use a plain string)");
		} else if (c === "/" && literal[i + 1] === "/") {
			const nl = literal.indexOf("\n", i);
			i = nl < 0 ? literal.length : nl;
		} else if (c === "/" && literal[i + 1] === "*") {
			const end = literal.indexOf("*/", i + 2);
			i = end < 0 ? literal.length : end + 1;
		} else if (c === "." && literal[i + 1] === "." && literal[i + 2] === ".") {
			throw new Error("spread elements are not allowed");
		}
	}
}

export function extractMeta(source: string): WorkflowMeta {
	const m = source.match(/export\s+const\s+meta\s*=\s*/);
	if (!m) {
		throw new Error(
			"workflow script must begin with `export const meta = { name, description, ... }`",
		);
	}
	// `meta` must be the FIRST statement — nothing (except comments/whitespace) may precede it,
	// both because the contract says so and because the body runs verbatim, so pre-meta code
	// would execute before phase groups are established.
	if (m.index !== firstSignificantIndex(source)) {
		throw new Error(
			"`export const meta = {…}` must be the FIRST statement in the script (no code may precede it)",
		);
	}
	const literal = readBracketed(source, m.index + m[0].length);
	let meta: unknown;
	try {
		assertPureLiteral(literal);
		meta = vm.runInNewContext(`(${literal})`, Object.create(null), {
			timeout: 1000,
		});
	} catch (e) {
		throw new Error(
			`meta must be a pure literal (no variables, calls, spreads, or template interpolation): ${e.message}`,
		);
	}
	if (
		!meta ||
		typeof meta !== "object" ||
		!("name" in meta) ||
		!("description" in meta)
	) {
		throw new Error("meta requires at least `name` and `description`");
	}
	const workflowMeta = meta as WorkflowMeta;
	if (
		typeof workflowMeta.name !== "string" ||
		typeof workflowMeta.description !== "string"
	) {
		throw new Error("meta requires at least `name` and `description`");
	}
	return workflowMeta;
}

function transformSource(source) {
	// Strip ONLY the leading `export ` before `const meta` so the body keeps `const meta = …` as a
	// local; extractMeta already guarantees `export const meta` is the first statement. A
	// `/^export/gm` sweep would also match (with the m flag) inside a template literal and corrupt a
	// prompt string that embeds code starting with `export `.
	return source.replace(/export(\s+const\s+meta\b)/, "$1");
}

const SANDBOX_GUARD = `
{
  const disabled = (name) => () => {
    throw new Error(name + " is disabled in workflow scripts (it breaks resume determinism). Pass timestamps/seeds via args.");
  };
  Math.random = disabled("Math.random()");
  const _Date = Date;
  // GuardedDate blocks every wall-clock entry point. Crucially it does NOT reuse
  // _Date.prototype, and it pins prototype.constructor back to itself, so the real
  // constructor cannot be reached via Date.prototype.constructor (a resume-determinism hole).
  const GuardedDate = function (...a) {
    // Date(...) called WITHOUT new returns the current time as a string regardless of args.
    if (!new.target) return disabled("Date()")();
    if (a.length === 0) disabled("new Date()")();
    return Reflect.construct(_Date, a, new.target);
  };
  GuardedDate.prototype = Object.create(_Date.prototype);
  Object.defineProperty(GuardedDate.prototype, "constructor", {
    value: GuardedDate,
    writable: true,
    configurable: true,
  });
  GuardedDate.now = disabled("Date.now()");
  GuardedDate.parse = _Date.parse;
  GuardedDate.UTC = _Date.UTC;
  globalThis.Date = GuardedDate;
}
`;

// ── Run orchestration ──────────────────────────────────────────────────────

export function newRunId() {
	return `wf_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

async function runBody(source, ctx) {
	const body = transformSource(source);
	const sandbox = {
		console: {
			error: (...a) => ctx.dsl.log(a.join(" ")),
			log: (...a) => ctx.dsl.log(a.join(" ")),
			warn: (...a) => ctx.dsl.log(a.join(" ")),
		},
	};
	Object.assign(sandbox, ctx.dsl);
	const context = vm.createContext(sandbox);
	vm.runInContext(SANDBOX_GUARD, context);
	const wrapped = `(async () => {\n${body}\n})()`;
	return vm.runInContext(wrapped, context, {
		filename: ctx.filename || "workflow.mjs",
	});
}

/**
 * Run a workflow.
 * @returns {Promise<{runId, result, meta, summary, runDir}>}
 */
export async function runWorkflow(opts) {
	const {
		scriptPath,
		source: srcInput,
		args,
		budgetTotal = null,
		resumeFromRunId = null,
		cwd = process.cwd(),
		concurrency,
		quiet = false,
		signal = null,
		control = null,
		workflowDirs = [],
		harness,
	} = opts;
	if (!harness) throw new Error("runWorkflow requires a harness handle");

	const source =
		srcInput != null ? srcInput : await readFile(scriptPath, "utf8");
	const meta = extractMeta(source);
	const runId = opts.runId || newRunId();
	const runsDir = opts.runsDir || path.join(cwd, ".agent-workflows", "runs");
	const runDir = path.join(runsDir, runId);
	await mkdir(runDir, { recursive: true });
	await writeTextAtomic(path.join(runDir, "script.mjs"), source).catch(
		() => {},
	);

	const progress = createProgress({
		runDir,
		runId,
		name: meta.name,
		quiet,
		phases: (meta.phases || []).map((p) => p.title),
	});
	const budget = createBudget(budgetTotal);
	const sem = createSemaphore(
		clampConcurrency(concurrency, defaultConcurrency()),
	);
	const counters = { calls: 0, launched: 0 };

	const prior = resumeFromRunId
		? await loadJournal(path.join(runsDir, resumeFromRunId, "journal.json"))
		: null;
	const journalPath = path.join(runDir, "journal.json");
	const journal = createJournal(prior, journalPath);

	const baseCtx = {
		cwd,
		sem,
		budget,
		progress,
		journal,
		counters,
		signal,
		depth: 0, // nesting depth; root is 0, a child workflow is 1. Drives the one-level guard.
		control,
		harness,
	};

	async function runChild(ref, childArgs) {
		const parentDir = path.dirname(scriptPath || cwd);
		const childPath = await resolveChildWorkflow(
			ref,
			cwd,
			workflowDirs.length ? workflowDirs : [parentDir],
			parentDir,
		);
		const childSource = await readFile(childPath, "utf8");
		const childCtx = {
			...baseCtx,
			args: childArgs,
			depth: baseCtx.depth + 1,
			filename: childPath,
		};
		childCtx.dsl = buildDsl(childCtx);
		childCtx.runChild = () => {
			throw new Error("workflow() nesting is one level only");
		};
		progress.narrate(
			`↳ workflow(${typeof ref === "string" ? ref : "scriptPath"})`,
		);
		return runBody(childSource, childCtx);
	}

	const rootCtx = {
		...baseCtx,
		args,
		depth: 0,
		runChild,
		filename: scriptPath,
	};
	rootCtx.dsl = buildDsl(rootCtx);

	let result: unknown;
	let error: any;
	try {
		result = await runBody(source, rootCtx);
	} catch (e) {
		error = e;
	}

	await saveJournal(journalPath, journal);
	const summary = progress.summary();
	const status = signal?.aborted ? "stopped" : error ? "error" : "done";
	await writeJsonAtomic(path.join(runDir, "result.json"), {
		runId,
		status,
		error: error ? String(error.message || error) : null,
		result,
		summary,
		budget: { spent: budget.spent(), total: budget.total },
		endedAt: Date.now(),
	}).catch(() => {});
	progress.flush();

	if (error && status !== "stopped")
		throw Object.assign(error, { runId, runDir, summary });
	return {
		runId,
		status,
		result,
		meta,
		summary,
		runDir,
		budget: { spent: budget.spent(), total: budget.total },
	};
}

// Static check: meta extracts as a pure literal and the transformed body compiles. Does
// NOT execute the workflow (no host spawns). Returns { ok, meta?, error? }.
export function lintSource(source, filename = "workflow.mjs") {
	let meta: WorkflowMeta;
	try {
		meta = extractMeta(source);
	} catch (e) {
		return { error: `meta: ${e.message}`, ok: false };
	}
	try {
		const body = transformSource(source);
		new vm.Script(`(async () => {\n${body}\n})()`, { filename });
	} catch (e) {
		return { ok: false, meta, error: `body: ${e.message}` };
	}
	return { ok: true, meta };
}

export async function listWorkflows(workflowDirs) {
	const out = [];
	for (const dir of workflowDirs) {
		let files: string[];
		try {
			files = await readdir(dir);
		} catch {
			continue;
		}
		for (const f of files) {
			if (!f.endsWith(".mjs")) continue;
			try {
				const src = await readFile(path.join(dir, f), "utf8");
				const meta = extractMeta(src);
				out.push({
					description: meta.description,
					file: path.join(dir, f),
					name: meta.name,
					whenToUse: meta.whenToUse,
				});
			} catch {
				out.push({
					description: "(meta unreadable)",
					file: path.join(dir, f),
					name: f.replace(/\.mjs$/, ""),
				});
			}
		}
	}
	return out;
}

export const _internal = {
	readBracketed,
	transformSource,
};
