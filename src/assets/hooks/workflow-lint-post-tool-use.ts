#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import path from "node:path";

import { lintSource } from "../../engine";

const event = await readHookEvent();
const input = event?.tool_input || event?.toolInput || event?.input || {};
const rawFile = String(input.file_path || input.filePath || input.path || "");

if (rawFile && /(^|\/)workflows\/.*\.mjs$/.test(rawFile)) {
	const cwd = String(event?.cwd || process.cwd());
	const scriptPath = path.resolve(cwd, rawFile);
	const result = lintSource(await readFile(scriptPath, "utf8"), scriptPath);
	if (!result.ok) {
		process.stdout.write(
			`Agent Workflows workflow lint failed: ${rawFile}: ${result.error}\n`,
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
