#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { renderForcedPrompt, renderNaturalPrompt } from "./prompt-template";

const file = process.argv[2];
if (!file) {
	throw new Error(
		"usage: bun evals/scripts/render-codex-prompt.ts <case.json>",
	);
}

const c = JSON.parse(readFileSync(file, "utf8"));

// EVAL_FORCE_WORKFLOW=1 simulates a user who manually triggers the workflow skill (forced
// orchestration); unset, it renders the neutral natural prompt used by the free-choice run.
const forced = process.env.EVAL_FORCE_WORKFLOW === "1";
process.stdout.write(forced ? renderForcedPrompt(c) : renderNaturalPrompt(c));
