// Coverage for the install surface (decision 003): the extension spec the CLI hands to
// @plimeor/harness, and the install/uninstall round-trip through the codex extensions facet.
// No host CLI is required — harness.open() returns a handle (with a working extensions facet)
// even when the host binary is absent, so this runs the same in CI as on a dev box.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { harness } from "@plimeor/harness";
import { EXTENSION_ID, extensionSpec } from "../src/cli/harness";

let home: string;
beforeEach(async () => {
	home = await mkdtemp(path.join(os.tmpdir(), "aw-harness-"));
});
afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

function openCodex() {
	return harness.open("codex", { home, cwd: home });
}

test("extensionSpec: MCP server launches the published binary, not a source path", () => {
	const spec = extensionSpec();
	expect(spec.id).toBe(EXTENSION_ID);
	const server = spec.resources.mcpServers?.[EXTENSION_ID];
	expect(server?.command).toBe("agent-workflows");
	expect(server?.args).toEqual(["mcp"]);
	const json = JSON.stringify(spec.resources.mcpServers);
	expect(json).not.toContain("mcp.ts");
	expect(json).not.toContain(".ts");
});

test("extensionSpec: every bundled skill path exists on disk", () => {
	for (const skill of extensionSpec().resources.skills ?? []) {
		expect(existsSync(skill)).toBe(true);
		expect(existsSync(path.join(skill, "SKILL.md"))).toBe(true);
	}
});

test("extensionSpec: installed guidance preserves long-run patience boundary", () => {
	const root = path.resolve(import.meta.dir, "..");
	const workflowSkill = readFileSync(
		path.join(root, "src/assets/skills/agent-workflows/SKILL.md"),
		"utf8",
	);
	expect(workflowSkill).toContain(
		"A single agent may legitimately run for 30-60 minutes",
	);
	expect(workflowSkill).toContain(
		"Before issuing `stop-run` or `stop-agent`, ask the user for confirmation",
	);

	const runHook = readFileSync(
		path.join(root, "src/assets/hooks/agent-workflows-run-post-tool-use.ts"),
		"utf8",
	);
	const activeRunsHook = readFileSync(
		path.join(root, "src/assets/hooks/summarize-active-runs.ts"),
		"utf8",
	);
	expect(runHook).toContain(
		"Long runs are normal; do not stop without explicit user confirmation",
	);
	expect(activeRunsHook).toContain(
		"Long runs are normal; do not stop without explicit user confirmation",
	);
	expect(JSON.stringify(extensionSpec())).toContain(
		"Long runs are normal; do not stop without explicit user confirmation",
	);
});

test("extensionSpec: the codex harness reports the spec as compatible", async () => {
	const handle = await openCodex();
	const check = await handle.extensions.check(extensionSpec());
	// compatible === no unsupported resource kinds and no unsupported hook events.
	expect(check.issues).toEqual([]);
	expect(check.compatible).toBe(true);
});

test("install writes the MCP block + skills + hooks, and uninstall removes them", async () => {
	const handle = await openCodex();

	const installed = await handle.extensions.install(extensionSpec());
	expect(installed.success).toBe(true);

	const configToml = readFileSync(
		path.join(home, ".codex", "config.toml"),
		"utf8",
	);
	expect(configToml).toContain("[mcp_servers.agent-workflows]");
	expect(configToml).toContain('command = "agent-workflows"');

	const hooks = JSON.parse(
		readFileSync(path.join(home, ".codex", "hooks.json"), "utf8"),
	);
	expect(Object.keys(hooks.hooks)).toEqual(
		expect.arrayContaining(["PostToolUse", "Stop", "SessionStart"]),
	);

	const skillLinks = await readdir(path.join(home, ".codex", "skills"));
	expect(skillLinks.length).toBe(2);

	const removed = await handle.extensions.uninstall(EXTENSION_ID);
	expect(removed.success).toBe(true);
	const afterToml = readFileSync(
		path.join(home, ".codex", "config.toml"),
		"utf8",
	);
	expect(afterToml).not.toContain("[mcp_servers.agent-workflows]");
	const afterSkills = await readdir(path.join(home, ".codex", "skills")).catch(
		() => [],
	);
	expect(afterSkills.length).toBe(0);
});
