#!/usr/bin/env bun

// Installed as a PostToolUse hook. The harness hook config carries no matcher, so this fires
// on EVERY tool call — self-guard on the tool name and only surface a run for the Agent
// Workflows start/resume run tools, instead of trusting any nested `runId` in an arbitrary event.
const event = await readHookEvent();
const toolName = String(
	(event as any)?.tool_name || (event as any)?.toolName || "",
);
const isRunTool = /agent_workflows_(start|resume)_run$/.test(toolName);

const found = isRunTool ? findRunPayload(event) : null;

if (found?.runId) {
	process.stdout.write(`Agent Workflows run ${found.runId} started.\n`);
	if (found.statusResource)
		process.stdout.write(`status: ${found.statusResource}\n`);
	if (found.resultResource)
		process.stdout.write(`result: ${found.resultResource}\n`);
	process.stdout.write(
		"Use agent_workflows_get_run or agent-workflows watch to follow progress.\n",
	);
}

async function readHookEvent() {
	try {
		return JSON.parse(await Bun.stdin.text());
	} catch {
		return null;
	}
}

function findRunPayload(value: unknown): any {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	if (typeof record.runId === "string") return record;
	for (const child of Object.values(record)) {
		const found = findRunPayload(child);
		if (found) return found;
	}
	return null;
}
