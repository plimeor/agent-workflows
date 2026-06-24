#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { renderNaturalPrompt } from "./prompt-template";

const file = process.argv[2];
if (!file) {
	throw new Error(
		"usage: bun evals/scripts/render-claude-prompt.ts <case.json>",
	);
}

const c = JSON.parse(readFileSync(file, "utf8"));

process.stdout.write(renderNaturalPrompt(c));
