#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
	createControlRuntime,
	HEARTBEAT_INTERVAL_MS,
	readJson,
	writeJsonAtomic,
} from "../engine";
import { executePreparedRun } from "./run-control";

async function main() {
	const runDirArg = process.argv[process.argv.indexOf("--run-dir") + 1];
	if (!runDirArg || process.argv.indexOf("--run-dir") < 0) {
		throw new Error("run-process requires --run-dir <dir>");
	}

	const runDir = path.resolve(runDirArg);
	const launch = await readJson(path.join(runDir, "launch.json"));
	if (!launch) throw new Error(`missing launch.json in ${runDir}`);
	await writeJsonAtomic(path.join(runDir, "process.json"), {
		pgid: process.pid,
		pid: process.pid,
		processGroupSupported: process.platform !== "win32",
		runId: launch.runId,
		schemaVersion: 1,
		startedAt: Date.now(),
	});
	const source = await readFile(path.join(runDir, "script.mjs"), "utf8");
	const rootController = new AbortController();
	const control = createControlRuntime({ runDir, rootController });
	control.start();

	const heartbeat = setInterval(() => {
		writeJsonAtomic(path.join(runDir, "heartbeat.json"), {
			pid: process.pid,
			runId: launch.runId,
			schemaVersion: 1,
			updatedAt: Date.now(),
		}).catch(() => {});
	}, HEARTBEAT_INTERVAL_MS);

	try {
		await writeJsonAtomic(path.join(runDir, "heartbeat.json"), {
			pid: process.pid,
			runId: launch.runId,
			schemaVersion: 1,
			updatedAt: Date.now(),
		});
		await executePreparedRun(
			{ runId: launch.runId, runDir, launch, source },
			{ quiet: true, control, signal: rootController.signal },
		);
	} catch (e: any) {
		const existing = await readJson(path.join(runDir, "result.json"));
		if (!existing?.status) {
			await writeJsonAtomic(path.join(runDir, "result.json"), {
				endedAt: Date.now(),
				error: String(e?.message || e),
				result: null,
				runId: launch.runId,
				status: rootController.signal.aborted ? "stopped" : "error",
				summary: null,
			});
		}
		if (!rootController.signal.aborted) process.exitCode = 1;
	} finally {
		clearInterval(heartbeat);
		control.stop();
		await writeJsonAtomic(path.join(runDir, "heartbeat.json"), {
			endedAt: Date.now(),
			pid: process.pid,
			runId: launch.runId,
			schemaVersion: 1,
			updatedAt: Date.now(),
		}).catch(() => {});
	}
}

main().catch(async (e) => {
	process.stderr.write(`${String(e?.stack || e?.message || e)}\n`);
	process.exit(1);
});
