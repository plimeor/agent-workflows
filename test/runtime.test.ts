// Runtime self-test (bun:test). Exercises the engine against an in-process fake harness (no
// host CLI, no tokens), validating the fidelity-critical behaviors from
// DECISIONS.xml decision 001 and the harness seam from decision 003.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	_internal,
	extractJson,
	extractMeta,
	runHarnessAgent,
	runWorkflow,
} from "../src/engine";
import { createFakeHarness } from "./fake-harness";

// A one-shot harness whose process.run returns a caller-supplied run object — used to drive
// runHarnessAgent directly (the abort→kill + exit-code mapping the engine relies on).
// biome-ignore lint/suspicious/noExplicitAny: structural stand-in for a HarnessHandle in tests.
function stubHarness(run: { result: Promise<any>; kill: () => void }): any {
	return { process: { run: async () => run } };
}

function tmpRuns(): string {
	return mkdtempSync(path.join(os.tmpdir(), "uc-test-"));
}

async function run(source: string, extra: Record<string, any> = {}) {
	return runWorkflow({
		harness: createFakeHarness(),
		source,
		cwd: import.meta.dir,
		quiet: true,
		runsDir: tmpRuns(),
		...extra,
	});
}

// ── meta extraction ─────────────────────────────────────────────────────────
test("meta: parses a pure literal", () => {
	const meta = extractMeta(
		`export const meta = { name: 'x', description: 'd', phases: [{title:'A'}] }\nreturn 1`,
	);
	expect(meta.name).toBe("x");
	expect(meta.phases[0].title).toBe("A");
});

test("meta: rejects a non-literal meta", () => {
	expect(() => extractMeta(`export const meta = { name: foo() }\n`)).toThrow();
});

test("meta: requires `export const meta`", () => {
	expect(() =>
		extractMeta(`const meta = {name:'x',description:'d'}`),
	).toThrow();
});

test("meta: must be the FIRST statement (pre-meta code rejected)", () => {
	expect(() =>
		extractMeta(`const x = 1;\nexport const meta = {name:'x',description:'d'}`),
	).toThrow(/FIRST statement/);
});

test("meta: leading comments/whitespace before meta are allowed", () => {
	const meta = extractMeta(
		`// header\n/* block */\nexport const meta = {name:'x',description:'d'}`,
	);
	expect(meta.name).toBe("x");
});

test("meta: rejects spreads and template interpolation (pure-literal rule)", () => {
	expect(() =>
		extractMeta(`export const meta = {...{name:'x'}, description:'d'}`),
	).toThrow(/pure literal/);
	const interpolatedTemplateMeta = [
		"export const meta = {name:`x-$",
		"{1}`, description:'d'}",
	].join("");
	expect(() => extractMeta(interpolatedTemplateMeta)).toThrow(/pure literal/);
});

// ── pipeline (no barrier) + parallel (barrier, null on throw) ─────────────────
test("pipeline runs all stages per item with (prev, orig, i)", async () => {
	const out = await run(`
    export const meta = { name: 'fan', description: 'd' }
    const r = await pipeline(['a','b','c'],
      (it) => agent('RETURN:' + it.toUpperCase()),
      (prev, orig, i) => prev + ':' + orig + ':' + i)
    return r`);
	expect(out.result).toEqual(["A:a:0", "B:b:1", "C:c:2"]);
});

test("parallel is a barrier; failed agent and throwing thunk → null", async () => {
	const out = await run(`
    export const meta = { name: 'par', description: 'd' }
    return await parallel([ () => agent('RETURN:one'), () => agent('FAIL'), () => { throw new Error('boom') } ])`);
	expect(out.result.length).toBe(3);
	expect(out.result[0]).toBe("one");
	expect(out.result[1]).toBeNull();
	expect(out.result[2]).toBeNull();
});

test("pipeline stage throw drops that item to null", async () => {
	const out = await run(`
    export const meta = { name: 'pipefail', description: 'd' }
    return await pipeline(['x'], () => agent('RETURN:hi'), () => { throw new Error('boom') }, () => 'never')`);
	expect(out.result[0]).toBeNull();
});

// ── harness seam: runHarnessAgent (decision 003) ──────────────────────────────
test("runHarnessAgent: exitCode 0 → ok with trimmed finalText", async () => {
	const h = stubHarness({
		result: Promise.resolve({ exitCode: 0, finalText: "  hi  " }),
		kill() {},
	});
	expect(await runHarnessAgent(h, { prompt: "p", cwd: "/" })).toEqual({
		ok: true,
		text: "hi",
		error: undefined,
	});
});

test("runHarnessAgent: null exit (signal-killed) and non-zero exit are not ok", async () => {
	const nullExit = stubHarness({
		result: Promise.resolve({
			exitCode: null,
			finalText: "",
			signal: "SIGTERM",
		}),
		kill() {},
	});
	expect((await runHarnessAgent(nullExit, { prompt: "p", cwd: "/" })).ok).toBe(
		false,
	);
	const nonZero = stubHarness({
		result: Promise.resolve({ exitCode: 2, finalText: "boom" }),
		kill() {},
	});
	expect((await runHarnessAgent(nonZero, { prompt: "p", cwd: "/" })).ok).toBe(
		false,
	);
});

test("runHarnessAgent: an abort kills the live run and yields not-ok", async () => {
	let killed = false;
	let resolveResult: (v: unknown) => void = () => {};
	const run = {
		result: new Promise<unknown>((res) => {
			resolveResult = res;
		}),
		kill() {
			killed = true;
			resolveResult({ exitCode: null, finalText: "", signal: "SIGTERM" });
		},
	};
	const ac = new AbortController();
	const pending = runHarnessAgent(stubHarness(run), {
		prompt: "p",
		cwd: "/",
		signal: ac.signal,
	});
	ac.abort(); // abort while the run is in flight
	const res = await pending;
	expect(killed).toBe(true);
	expect(res.ok).toBe(false);
});

// ── extractJson (the schema text-extraction the engine validates) ─────────────
test("extractJson: bare, prose-wrapped, fenced, array, and brace-in-string", () => {
	expect(extractJson('{"a":1}')).toEqual({ a: 1 });
	expect(extractJson('Here is the result: {"a":1} done')).toEqual({ a: 1 });
	expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
	expect(extractJson("prefix [1,2] suffix")).toEqual([1, 2]);
	expect(extractJson('{"s":"has } brace in string"}')).toEqual({
		s: "has } brace in string",
	});
});

test("extractJson: throws when no balanced JSON value is present", () => {
	expect(() => extractJson("no json here")).toThrow();
});

// ── structured output (schema) ────────────────────────────────────────────────
test("schema agent returns a validated object", async () => {
	const out = await run(`
    export const meta = { name: 'sch', description: 'd' }
    const S = { type:'object', additionalProperties:false, required:['ok','n'], properties:{ ok:{type:'boolean'}, n:{type:'number'} } }
    return await agent('SET n=42', { schema: S })`);
	expect(out.result).toEqual({ n: 42, ok: true });
});

test("schema agent with non-JSON output → null after retries", async () => {
	const out = await run(`
    export const meta = { name: 'schbad', description: 'd' }
    const S = { type:'object', required:['a'], properties:{ a:{type:'string'} } }
    return await agent('BADJSON', { schema: S })`);
	expect(out.result).toBeNull();
});

test("schema agent recovers on retry by repairing the prior reply (no full re-run)", async () => {
	const out = await run(`
    export const meta = { name: 'schretry', description: 'd' }
    const S = { type:'object', additionalProperties:false, required:['n'], properties:{ n:{type:'number'} } }
    return await agent('TYPEFAIL SET n=5', { schema: S })`);
	// First reply emits {"n":"5"} (number stringified → type error); the repair pass coerces it
	// back rather than re-running the task, preserving the emitted value.
	expect(out.result).toEqual({ n: 5 });
});

test("schema retry sends a repair prompt (prior reply + errors), NOT the original task", async () => {
	const S = {
		type: "object",
		required: ["n"],
		properties: { n: { type: "number" } },
	};
	const prompts: string[] = [];
	const replies = [
		{ exitCode: 0, finalText: '{"n":"5"}' }, // attempt 0: parses, fails on type
		{ exitCode: 0, finalText: '{"n":5}' }, // attempt 1: the repaired reply
	];
	let i = 0;
	// biome-ignore lint/suspicious/noExplicitAny: structural stand-in for a HarnessHandle.
	const harness: any = {
		process: {
			// biome-ignore lint/suspicious/noExplicitAny: request is the engine's RunRequest.
			async run(request: any) {
				prompts.push(String(request.prompt));
				const r = replies[Math.min(i++, replies.length - 1)];
				return {
					result: Promise.resolve({ ...r, signal: undefined }),
					kill() {},
				};
			},
		},
	};
	const out = await run(
		`export const meta = { name: 'rep', description: 'd' }
     const S = ${JSON.stringify(S)}
     return await agent('UNIQUE_TASK_MARKER read the files and analyze', { schema: S })`,
		{ harness },
	);
	expect(out.result).toEqual({ n: 5 });
	expect(prompts).toHaveLength(2);
	// Attempt 0 carries the full task; the retry must NOT re-send it (that is the token win).
	expect(prompts[0]).toContain("UNIQUE_TASK_MARKER");
	expect(prompts[1]).not.toContain("UNIQUE_TASK_MARKER");
	// The retry is the repair prompt: it reshapes the prior reply and names the exact error.
	expect(prompts[1]).toContain("Reshape ONLY");
	expect(prompts[1]).toContain('{"n":"5"}');
	expect(prompts[1]).toContain("expected number");
});

// ── budget (inert under the harness; decision 003) ────────────────────────────
test("budget.total is honored as an advisory cap; spent() stays 0", async () => {
	const out = await run(
		`export const meta = { name: 'bud', description: 'd' }
     for (let i=0;i<5;i++) await agent('RETURN:'+i)
     return { total: budget.total, spent: budget.spent(), remaining: budget.remaining() }`,
		{ budgetTotal: 250 },
	);
	expect(out.result.total).toBe(250);
	expect(out.result.spent).toBe(0);
	expect(out.result.remaining).toBe(250);
});

// ── resume / journal ──────────────────────────────────────────────────────────
test("resume replays the journal with no live spawns", async () => {
	const runsDir = tmpRuns();
	const source = `
    export const meta = { name: 'res', description: 'd' }
    return await parallel([ () => agent('RETURN:a'), () => agent('RETURN:b') ])`;
	const first = await runWorkflow({
		harness: createFakeHarness(),
		source,
		quiet: true,
		runsDir,
		cwd: import.meta.dir,
		runId: "wf_first",
	});
	expect(first.summary.done).toBe(2);
	expect(first.summary.cached).toBe(0);
	const second = await runWorkflow({
		harness: createFakeHarness(),
		source,
		quiet: true,
		runsDir,
		cwd: import.meta.dir,
		resumeFromRunId: "wf_first",
		runId: "wf_second",
	});
	expect(second.summary.cached).toBe(2);
	expect(second.summary.done).toBe(0);
	expect(second.result).toEqual(first.result);
});

// ── determinism guards ────────────────────────────────────────────────────────
for (const [name, expr] of [
	["Math.random()", "Math.random()"],
	["Date.now()", "Date.now()"],
	["new Date()", "new Date()"],
] as const) {
	test(`${name} is blocked`, async () => {
		await expect(
			run(
				`export const meta = { name:'det', description:'d' }\n${expr};\nreturn 1`,
			),
		).rejects.toThrow(/disabled in workflow scripts/);
	});
}

test("new Date(ms) still works", async () => {
	const out = await run(
		`export const meta={name:'det2',description:'d'}\nreturn new Date(0).getTime()`,
	);
	expect(out.result).toBe(0);
});

// The determinism guard must not be escapable via Date.prototype.constructor, and the
// function-call form Date() (no `new`) is just as non-deterministic as new Date().
for (const [name, expr] of [
	["Date.prototype.constructor.now()", "Date.prototype.constructor.now()"],
	["new (Date.prototype.constructor)()", "new (Date.prototype.constructor)()"],
	["Date() as a function", "Date()"],
] as const) {
	test(`determinism guard: ${name} is blocked`, async () => {
		await expect(
			run(`export const meta={name:'g',description:'d'}\n${expr};\nreturn 1`),
		).rejects.toThrow(/disabled in workflow scripts/);
	});
}

// ── limit guards ──────────────────────────────────────────────────────────────
test("parallel rejects > 4096 items", async () => {
	await expect(
		run(`
      export const meta = { name:'cap', description:'d' }
      const big = Array.from({length:5000}, (_,i)=>i)
      return await parallel(big.map(i => () => agent('RETURN:'+i)))`),
	).rejects.toThrow(/at most 4096 items/);
});

test("parallel rejects non-function thunks (passing agent() Promises is a footgun)", async () => {
	await expect(
		run(
			`export const meta={name:'pg',description:'d'}\nreturn await parallel([agent('RETURN:x')])`,
		),
	).rejects.toThrow(/zero-arg function/);
});

test("transformSource strips only the meta export, preserving `export` inside a template literal", () => {
	const src = [
		"export const meta = { name: 'x', description: 'd' }",
		"const code = `\\nexport function f(){}`",
		"return code",
	].join("\n");
	const out = _internal.transformSource(src);
	expect(out).not.toMatch(/^export const meta/m); // meta export stripped
	expect(out).toContain("export function f(){}"); // template-literal export preserved
});

// ── fidelity fixes (from adversarial review) ──────────────────────────────────
test("F3: a non-schema agent retries a transient death", async () => {
	const out = await run(
		`export const meta = { name:'f3', description:'d' }\nreturn await agent('FAILONCE RETURN:recovered')`,
	);
	expect(out.result).toBe("recovered");
});

test("F4: changing the schema busts the resume cache (and same schema hits)", async () => {
	const runsDir = tmpRuns();
	const srcA = `export const meta={name:'f4',description:'d'}\nconst S={type:'object',required:['n'],properties:{n:{type:'number'}}}\nreturn await agent('SET n=1', { schema: S })`;
	const srcB = `export const meta={name:'f4',description:'d'}\nconst S={type:'object',required:['m'],properties:{m:{type:'number'}}}\nreturn await agent('SET m=2', { schema: S })`;
	await runWorkflow({
		harness: createFakeHarness(),
		quiet: true,
		source: srcA,
		runsDir,
		cwd: import.meta.dir,
		runId: "f4a",
	});
	const f4b = await runWorkflow({
		harness: createFakeHarness(),
		quiet: true,
		source: srcB,
		runsDir,
		cwd: import.meta.dir,
		resumeFromRunId: "f4a",
		runId: "f4b",
	});
	expect(f4b.summary.cached).toBe(0);
	expect(f4b.summary.done).toBe(1);
	const f4c = await runWorkflow({
		harness: createFakeHarness(),
		quiet: true,
		source: srcA,
		runsDir,
		cwd: import.meta.dir,
		resumeFromRunId: "f4a",
		runId: "f4c",
	});
	expect(f4c.summary.cached).toBe(1);
	expect(f4c.summary.done).toBe(0);
});

test("F5: a pre-aborted run yields null for a bare agent() (no throw)", async () => {
	const ac = new AbortController();
	ac.abort();
	const out = await run(
		`export const meta={name:'f5',description:'d'}\nreturn await agent('RETURN:x')`,
		{
			signal: ac.signal,
		},
	);
	expect(out.result).toBeNull();
});

// ── fidelity-audit fixes (round 2) ────────────────────────────────────────────
test("profile: an unknown profile throws", async () => {
	await expect(
		run(
			`export const meta={name:'profile',description:'d'}\nreturn await agent('RETURN:x', { profile: 'nope' })`,
		),
	).rejects.toThrow(/unknown profile/);
});

test("profile: a builtin profile is accepted", async () => {
	const out = await run(
		`export const meta={name:'profile2',description:'d'}\nreturn await agent('RETURN:ok', { profile: 'reviewer' })`,
	);
	expect(out.result).toBe("ok");
});

test("progress.log is persisted to the run dir with narrator lines", async () => {
	const out = await run(
		`export const meta={name:'plog',description:'d'}\nlog('hello-narrator')\nreturn 1`,
	);
	const txt = readFileSync(path.join(out.runDir, "progress.log"), "utf8");
	expect(txt).toContain("hello-narrator");
});

test("workflow() nesting is blocked by the live depth guard (one level only)", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "uc-depth-"));
	const child = path.join(dir, "child.mjs");
	// The grandchild ref is irrelevant — the depth guard must fire before resolving it.
	writeFileSync(
		child,
		`export const meta={name:'child',description:'d'}\ntry { await workflow({scriptPath:'/whatever.mjs'}); return 'NO-THROW' } catch(e){ return 'blocked:'+e.message }`,
	);
	const out = await runWorkflow({
		harness: createFakeHarness(),
		cwd: dir,
		quiet: true,
		runsDir: tmpRuns(),
		source: `export const meta={name:'parent',description:'d'}\nreturn await workflow({scriptPath:${JSON.stringify(child)}})`,
		workflowDirs: [dir],
	});
	expect(out.result).toBe("blocked:workflow() nesting is one level only");
});
