#!/usr/bin/env bun

import { listRuns, normalizeCwd } from "../../engine";

const event = await readHookEvent();
const rawCwd = event?.cwd;
if (typeof rawCwd === "string" && rawCwd.length > 0) {
	const cwd = await normalizeCwd(rawCwd);
	const runs = await listRuns(cwd, { limit: 10 });
	const active = runs.filter(
		(run) => run.state === "starting" || run.state === "running",
	);
	if (active.length) {
		process.stdout.write("Agent Workflows active runs:\n");
		for (const run of active) {
			process.stdout.write(
				`${run.runId} ${run.state} ${run.status?.name || run.launch?.scriptRef || ""}\n`,
			);
		}
		process.stdout.write(
			"Use agent-workflows watch <runId> --follow or agent_workflows_get_run for details; " +
				"keep the parent session to progress relay unless the user asks for run control. " +
				"Long runs are normal; do not stop without explicit user confirmation.\n",
		);
	}
}

async function readHookEvent() {
	try {
		return JSON.parse(await Bun.stdin.text());
	} catch {
		return null;
	}
}
