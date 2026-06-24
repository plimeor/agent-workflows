import { spawn } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import {
	clampConcurrency,
	getRun,
	newRunId,
	normalizeCwd,
	PROFILE_SET_VERSION,
	readJson,
	readWorkflowSource,
	resolveScript,
	runDir,
	runsDir,
	runWorkflow,
	sha256Text,
	workflowDirs,
	writeJsonAtomic,
	writeTextAtomic,
} from "../engine";
import { DEFAULT_HARNESS, openHarness } from "./harness";

export async function prepareRun(input: Record<string, any>) {
	const cwd = await normalizeCwd(input.cwd || process.cwd());
	const runId = input.runId || newRunId();
	const dir = runDir(cwd, runId);
	await mkdir(runsDir(cwd), { recursive: true });
	await mkdir(dir);

	const scriptPath =
		input.scriptPath ??
		(input.source != null ? null : await resolveScript(input.scriptRef, cwd));
	const source =
		input.source != null
			? String(input.source)
			: await readWorkflowSource(scriptPath);

	await writeTextAtomic(path.join(dir, "script.mjs"), source);
	const launch: Record<string, any> = {
		runId,
		detached: input.detached === true,
		scriptHash: sha256Text(source),
		scriptRef: input.scriptRef || scriptPath || input.name || `inline:${runId}`,
		cwd,
		args: input.args,
		budget: input.budget ?? null,
		harness: input.harness || DEFAULT_HARNESS,
		concurrency:
			input.concurrency == null ? null : clampConcurrency(input.concurrency),
		createdAt: Date.now(),
		profileSetVersion: PROFILE_SET_VERSION,
		resumeFromRunId: input.resumeFromRunId || null,
		schemaVersion: 1,
	};

	await writeJsonAtomic(path.join(dir, "launch.json"), launch);
	return { runId, runDir: dir, launch, source };
}

export async function prepareResumeRun(input: Record<string, any>) {
	const cwd = await normalizeCwd(input.cwd || process.cwd());
	const sourceRunDir = runDir(cwd, input.resumeFromRunId);
	const priorLaunch = await readJson(path.join(sourceRunDir, "launch.json"));
	if (!priorLaunch) throw new Error(`unknown run '${input.resumeFromRunId}'`);
	const priorJournal = await readJson(path.join(sourceRunDir, "journal.json"));
	const priorRun = await getRun(cwd, input.resumeFromRunId);
	if (
		!priorJournal &&
		["running", "starting", "stale", "unknown"].includes(priorRun.state)
	) {
		throw new Error(
			`run '${input.resumeFromRunId}' has no readable journal and cannot be used as a resume source`,
		);
	}
	const {
		runId: _oldRunId,
		createdAt: _oldCreatedAt,
		scriptHash: _oldScriptHash,
		...priorDefaults
	} = priorLaunch;
	const sourcePath = path.join(sourceRunDir, "script.mjs");
	const source = input.scriptRef
		? undefined
		: await readWorkflowSource(sourcePath);
	return prepareRun({
		...priorDefaults,
		...input,
		runId: input.runId,
		cwd,
		source,
		resumeFromRunId: input.resumeFromRunId,
		scriptPath: input.scriptRef ? undefined : sourcePath,
		scriptRef: input.scriptRef || priorLaunch.scriptRef || sourcePath,
	});
}

export async function executePreparedRun(
	prepared: any,
	opts: Record<string, any> = {},
) {
	const launch = prepared.launch;
	const harness =
		opts.harness ||
		(await openHarness(launch.harness || DEFAULT_HARNESS, launch.cwd));
	return runWorkflow({
		args: launch.args,
		harness,
		budgetTotal: launch.budget,
		concurrency: launch.concurrency || undefined,
		control: opts.control || null,
		cwd: launch.cwd,
		quiet: opts.quiet === true,
		resumeFromRunId: launch.resumeFromRunId,
		runId: launch.runId,
		runsDir: runsDir(launch.cwd),
		scriptPath: path.join(prepared.runDir, "script.mjs"),
		signal: opts.signal || null,
		source: prepared.source,
		workflowDirs: workflowDirs(launch.cwd),
	});
}

export async function startDetachedRun(prepared: any) {
	const entry = path.join(import.meta.dir, "run-process.ts");
	await chmod(entry, 0o755).catch(() => {});
	const child = spawn(process.execPath, [entry, "--run-dir", prepared.runDir], {
		cwd: prepared.launch.cwd,
		detached: true,
		env: process.env,
		stdio: "ignore",
	});
	child.unref();
	return { pid: child.pid };
}

export async function writeControlCommand(
	cwd: string,
	runId: string,
	command: Record<string, any>,
) {
	const allowed = new Set([
		"stop-run",
		"pause-admission",
		"resume-admission",
		"stop-agent",
		"restart-agent",
	]);
	if (!allowed.has(command.command)) {
		throw new Error(`unknown control command '${command.command}'`);
	}
	const requestedAt = Date.now();
	const payload = {
		agentId: command.agentId || null,
		command: command.command,
		id: `${requestedAt}-${process.pid}-${Math.random().toString(36).slice(2)}`,
		reason: command.reason || null,
		requestedAt,
		schemaVersion: 1,
	};
	const dir = runDir(cwd, runId);
	await mkdir(path.join(dir, "control"), { recursive: true });
	await writeJsonAtomic(
		path.join(dir, "control", `${payload.id}.json`),
		payload,
	);
	await writeJsonAtomic(path.join(dir, "control.json"), payload);
	return payload;
}
