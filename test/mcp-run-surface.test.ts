// Characterization tests for the inline-authoring + durable MCP run surface
// (tasking T008–T011). These exercise the cross-layer run path (prepareRun in the
// CLI package), the deadline-bounded get_run poll, and the durable runId→cwd
// resolver — without spending Codex tokens.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { __testGetRunWithWait, __testStartRunTool } from "../src/cli/mcp";
import { prepareRun } from "../src/cli/run-control";
import { getRun, resolveRunCwd } from "../src/engine";

// Parse the jsonResult envelope a tool handler returns back into its payload.
function payloadOf(result: any) {
	if (result?.structuredContent) return result.structuredContent;
	return JSON.parse(result.content[0].text);
}

function runsRoot(root: string) {
	return path.join(root, ".agent-workflows", "runs");
}
function runDirCount(root: string) {
	try {
		return readdirSync(runsRoot(root)).length;
	} catch {
		return 0;
	}
}

const ENV_KEY = "AGENT_WORKFLOWS_AUTHORIZED_ROOTS";
let priorRoots: string | undefined;
let root: string;

beforeEach(async () => {
	priorRoots = process.env[ENV_KEY];
	// Authorize a fresh tmp root and run everything under it.
	root = await realpath(mkdtempSync(path.join(os.tmpdir(), "uc-mcp-")));
	process.env[ENV_KEY] = root;
});

afterEach(() => {
	if (priorRoots === undefined) delete process.env[ENV_KEY];
	else process.env[ENV_KEY] = priorRoots;
});

const VALID_SOURCE =
	"export const meta = { name: 'x', description: 'd' };\nreturn 0;";

// ── T008: one prepareRun path serves inline source AND on-disk scriptRef ──────
test("T008: inline source — prepareRun resolves with no scriptRef/scriptPath", async () => {
	const prepared = await prepareRun({
		source: VALID_SOURCE,
		cwd: root,
		detached: true,
	});
	// (a) returns without throwing — reaching here proves it.
	// (b) script.mjs bytes equal the supplied source.
	const written = readFileSync(
		path.join(prepared.runDir, "script.mjs"),
		"utf8",
	);
	expect(written).toBe(VALID_SOURCE);
	// (c) launch.scriptRef is a non-empty string (inline:<runId> fallback).
	expect(typeof prepared.launch.scriptRef).toBe("string");
	expect(prepared.launch.scriptRef.length).toBeGreaterThan(0);
	expect(prepared.launch.scriptRef).toBe(`inline:${prepared.runId}`);
});

test("T008: inline source + name — launch.scriptRef falls back to name", async () => {
	const prepared = await prepareRun({
		source: VALID_SOURCE,
		name: "my-inline-flow",
		cwd: root,
		detached: true,
	});
	expect(prepared.launch.scriptRef).toBe("my-inline-flow");
});

test("T008: on-disk scriptRef — same path resolves an on-disk workflow", async () => {
	const wfDir = path.join(root, "workflows");
	await mkdir(wfDir, { recursive: true });
	const scriptFile = path.join(wfDir, "ondisk.mjs");
	await writeFile(scriptFile, VALID_SOURCE);
	const prepared = await prepareRun({
		scriptRef: "workflows/ondisk.mjs",
		cwd: root,
		detached: true,
	});
	const written = readFileSync(
		path.join(prepared.runDir, "script.mjs"),
		"utf8",
	);
	expect(written).toBe(VALID_SOURCE);
	expect(typeof prepared.launch.scriptRef).toBe("string");
});

// ── T010: deadline-bounded get_run poll via the MCP handler ───────────────────
test("T010: still-running run with waitMs returns within an upper time bound", async () => {
	// Create a run dir with launch.json but NO result.json -> non-terminal.
	const prepared = await prepareRun({
		source: VALID_SOURCE,
		cwd: root,
		detached: true,
	});
	const waitMs = 50;
	const t0 = Date.now();
	const run = await __testGetRunWithWait(root, prepared.runId, { waitMs });
	const elapsed = Date.now() - t0;
	// Bounded: ~waitMs plus generous slack, NOT unbounded.
	expect(elapsed).toBeLessThan(waitMs + 1500);
	expect(run.runId).toBe(prepared.runId);
	// Non-terminal state so the caller can keep polling.
	expect(["starting", "running", "stale", "unknown"]).toContain(run.state);
});

test("T010: terminal run returns near-instantly even with a large waitMs", async () => {
	const prepared = await prepareRun({
		source: VALID_SOURCE,
		cwd: root,
		detached: true,
	});
	// Make it terminal by writing result.json.
	await writeFile(
		path.join(prepared.runDir, "result.json"),
		JSON.stringify({ status: "done" }),
	);
	const t0 = Date.now();
	const run = await __testGetRunWithWait(root, prepared.runId, {
		waitMs: 5000,
	});
	const elapsed = Date.now() - t0;
	expect(elapsed).toBeLessThan(1000);
	expect(run.state).toBe("done");
});

test("T010: no waitMs performs exactly one read (single-shot)", async () => {
	const prepared = await prepareRun({
		source: VALID_SOURCE,
		cwd: root,
		detached: true,
	});
	const t0 = Date.now();
	const run = await __testGetRunWithWait(root, prepared.runId, {});
	const elapsed = Date.now() - t0;
	// Single-shot: returns immediately, no polling delay.
	expect(elapsed).toBeLessThan(500);
	expect(run.runId).toBe(prepared.runId);
});

// ── T011: durable runId→cwd resolver across a fresh server (no in-memory state) ──
test("T011: resolveRunCwd resolves a run created under an authorized root != process.cwd()", async () => {
	const prepared = await prepareRun({
		source: VALID_SOURCE,
		cwd: root,
		detached: true,
	});
	// root is an authorized root that is NOT process.cwd() (a fresh tmp dir).
	expect(root).not.toBe(process.cwd());
	// Fresh resolver call — no in-memory state involved.
	const resolved = await resolveRunCwd(prepared.runId);
	expect(resolved).toBe(root);
	// And getRun(resolvedCwd, runId) yields that run's launch.json.
	const run = await getRun(resolved as string, prepared.runId, {});
	expect(run.launch).not.toBeNull();
	expect(run.runId).toBe(prepared.runId);
});

test("T011: resolveRunCwd returns null for an unknown runId (explicit miss)", async () => {
	const resolved = await resolveRunCwd("run-does-not-exist-zzz");
	expect(resolved).toBeNull();
});

// ── T009: fail-closed lint gate in start_run + agent_workflows_lint tool ──────
// `meta` as a bare const reference (not a pure literal) trips extractMeta.
const BAD_SOURCE = "export const meta = brokenRef;\nreturn 0;";

test("T009: bad inline source returns ok:false with a meta: error and spawns NO run", async () => {
	const before = runDirCount(root);
	const result = await (__testStartRunTool as any).handler(
		{ source: BAD_SOURCE, cwd: root },
		{},
	);
	const payload = payloadOf(result);
	expect(payload.ok).toBe(false);
	expect(typeof payload.error).toBe("string");
	expect(payload.error).toMatch(/^(meta|body):/);
	// No run id surfaced, no run directory created -> startDetachedRun never ran.
	expect(payload.runId).toBeUndefined();
	expect(runDirCount(root)).toBe(before);
});

test("T009: valid inline source still spawns and returns a runId", async () => {
	const result = await (__testStartRunTool as any).handler(
		{ source: VALID_SOURCE, cwd: root },
		{},
	);
	const payload = payloadOf(result);
	expect(typeof payload.runId).toBe("string");
	expect(payload.runId.length).toBeGreaterThan(0);
	// The run dir + the linted script.mjs were created from the supplied source.
	const scriptPath = path.join(runsRoot(root), payload.runId, "script.mjs");
	expect(existsSync(scriptPath)).toBe(true);
	expect(readFileSync(scriptPath, "utf8")).toBe(VALID_SOURCE);
});
