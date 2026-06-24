import { access, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { configuredAuthorizedRoots } from "./workflows";

export const BOOT_GRACE_MS = 5000;
export const HEARTBEAT_INTERVAL_MS = 10000;
export const STALE_AFTER_MS = HEARTBEAT_INTERVAL_MS * 3;

export function runsDir(cwd: string) {
	return path.join(cwd, ".agent-workflows", "runs");
}

export function runDir(cwd: string, runId: string) {
	return path.join(runsDir(cwd), runId);
}

export async function readJson(file: string) {
	try {
		return JSON.parse(await readFile(file, "utf8"));
	} catch {
		return null;
	}
}

export async function getRun(
	cwd: string,
	runId: string,
	options: { includeResult?: boolean; logTailBytes?: number } = {},
) {
	const dir = runDir(cwd, runId);
	const [launch, proc, heartbeat, status, result, control] = await Promise.all([
		readJson(path.join(dir, "launch.json")),
		readJson(path.join(dir, "process.json")),
		readJson(path.join(dir, "heartbeat.json")),
		readJson(path.join(dir, "status.json")),
		readJson(path.join(dir, "result.json")),
		readJson(path.join(dir, "control.json")),
	]);
	const inferred = inferState({ launch, heartbeat, result });
	return {
		runId,
		relativeRunDir: path.relative(cwd, dir),
		runDir: dir,
		launch,
		process: proc,
		heartbeat,
		status,
		progressLog: options.logTailBytes
			? await readTextTail(path.join(dir, "progress.log"), options.logTailBytes)
			: null,
		result: options.includeResult === false ? null : result,
		control,
		state: result?.status || inferred,
	};
}

export async function listRuns(
	cwd: string,
	options: { state?: string; limit?: number } = {},
) {
	const dir = runsDir(cwd);
	await mkdir(dir, { recursive: true });
	const ids = await readdir(dir).catch(() => []);
	const runs = await Promise.all(
		ids.map((id) => getRun(cwd, id).catch(() => null)),
	);
	const filtered = runs
		.filter(Boolean)
		.filter((run: any) => !options.state || run.state === options.state);
	return filtered
		.sort((a: any, b: any) => {
			const au = a.status?.updatedAt || a.launch?.createdAt || 0;
			const bu = b.status?.updatedAt || b.launch?.createdAt || 0;
			return bu - au;
		})
		.slice(0, options.limit || runs.length);
}

// Durable runId→cwd resolver. MCP resources are addressed by runId alone, but
// run dirs live under runsDir(cwd). Scan the authorized roots for the one whose
// runDir(root, runId)/launch.json exists, and return that root. Returns null on
// no match (an explicit miss the caller must surface as not-found) — never a
// process.cwd() fallback. Stays inside the normalizeCwd authorized-root seal
// because it only returns roots the scan produced.
export async function resolveRunCwd(runId: string): Promise<string | null> {
	const roots = await configuredAuthorizedRoots();
	for (const root of roots) {
		const launchPath = path.join(runDir(root, runId), "launch.json");
		try {
			await access(launchPath);
			return root;
		} catch {
			// not under this root; keep scanning
		}
	}
	return null;
}

function inferState({ launch, heartbeat, result }: any) {
	if (result?.status) return result.status;
	if (!launch) return "unknown";
	if (launch.detached === false) return "running";
	const age = Date.now() - (launch.createdAt || 0);
	if (!heartbeat && age <= BOOT_GRACE_MS) return "starting";
	if (heartbeat && Date.now() - heartbeat.updatedAt < STALE_AFTER_MS)
		return "running";
	return "stale";
}

async function readTextTail(file: string, bytes: number) {
	if (!Number.isFinite(bytes) || bytes <= 0) return null;
	try {
		const text = await readFile(file, "utf8");
		return text.slice(-Math.floor(bytes));
	} catch {
		return null;
	}
}
