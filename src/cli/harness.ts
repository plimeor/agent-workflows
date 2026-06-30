// Host selection + extension resources. The CLI is the only layer that names a concrete
// harness: it opens one from @plimeor/harness (default `codex`) and injects it into the
// core engine, and it describes the agent-workflows extension (MCP server + skills + hooks)
// for `install`/`uninstall`. Core never sees any of this. See DECISIONS.xml decision 003.
import os from "node:os";
import path from "node:path";
import type { HarnessExtension, HarnessHandle } from "@plimeor/harness";
import { harness } from "@plimeor/harness";

export const DEFAULT_HARNESS = "codex";

// The stable extension id @plimeor/harness uses for install ownership + uninstall.
export const EXTENSION_ID = "agent-workflows";

// The portable launch command a host registers for the MCP server. `agent-workflows` is on
// PATH after install, so the host invokes the published binary, never a source path.
const MCP_LAUNCH = { command: "agent-workflows", args: ["mcp"] } as const;

// Bundled install assets (host skills + hook scripts) live under src/assets/ and ship with the
// package, so the path resolves identically in-repo and from an installed tarball.
const ASSETS_ROOT = path.resolve(import.meta.dir, "..", "assets");

export function harnessIds(): string[] {
	return harness.list().map((adapter) => adapter.id);
}

// Open the named harness and confirm it is actually present. An unknown id or a harness
// that is not detected on this machine is a hard error — the CLI never silently proceeds
// against a missing host.
export async function openHarness(
	harnessId: string,
	cwd: string,
): Promise<HarnessHandle> {
	let handle: HarnessHandle;
	try {
		handle = await harness.open(harnessId, {
			cwd,
			env: process.env,
			home: os.homedir(),
		});
	} catch {
		throw new Error(
			`unknown harness '${harnessId}' (available: ${harnessIds().join(", ")})`,
		);
	}
	if (!handle.detection.detected) {
		throw new Error(
			`harness '${harnessId}' was not detected on this machine. Install it and ensure it is on PATH, then retry.`,
		);
	}
	return handle;
}

// The agent-workflows extension: one MCP server, two skills, and the advisory session hooks.
export function extensionSpec(): HarnessExtension {
	const skillsRoot = path.join(ASSETS_ROOT, "skills");
	const hooksRoot = path.join(ASSETS_ROOT, "hooks");
	const hookCommand = (file: string) =>
		`bun ${shellQuote(path.join(hooksRoot, file))} || true`;
	return {
		id: EXTENSION_ID,
		resources: {
			mcpServers: {
				[EXTENSION_ID]: {
					command: MCP_LAUNCH.command,
					args: [...MCP_LAUNCH.args],
				},
			},
			skills: [
				path.join(skillsRoot, "agent-workflows"),
				path.join(skillsRoot, "agent-workflows-authoring"),
			],
			hooks: [
				{
					name: "workflow-lint",
					event: "PostToolUse",
					command: hookCommand("workflow-lint-post-tool-use.ts"),
				},
				{
					name: "run-surface",
					event: "PostToolUse",
					command: hookCommand("agent-workflows-run-post-tool-use.ts"),
				},
				{
					name: "summarize-active-runs",
					event: "Stop",
					command: hookCommand("summarize-active-runs.ts"),
				},
				{
					name: "session-start",
					event: "SessionStart",
					command:
						"echo 'Agent Workflows available: `agent-workflows list` to see named workflows, " +
						"`agent-workflows run <script|name>` to orchestrate subagents. While a run is active, " +
						"keep this parent session to progress relay unless the user asks for run control. " +
						"Long runs are normal; do not stop without explicit user confirmation.'",
				},
			],
		},
	};
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}
