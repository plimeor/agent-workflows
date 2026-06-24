// Git worktree isolation for `isolation: 'worktree'` agents. Mirrors the Workflow tool:
// an agent gets its own writable checkout; on completion the worktree is auto-removed if
// it has no changes, otherwise kept and its path reported.
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function git(args, cwd) {
	const { stdout } = await exec("git", args, { cwd, maxBuffer: 1 << 24 });
	return stdout.trim();
}

export async function repoRoot(cwd) {
	try {
		return await git(["rev-parse", "--show-toplevel"], cwd);
	} catch {
		return null;
	}
}

export async function createWorktree(cwd, label = "agent") {
	const root = await repoRoot(cwd);
	if (!root) throw new Error("isolation:'worktree' requires a git repository");
	const safe = label.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "agent";
	const dir = path.join(
		os.tmpdir(),
		`aw-wt-${safe}-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
	);
	await git(["worktree", "add", "--detach", dir, "HEAD"], root);
	return {
		dir,
		async cleanup() {
			let dirty = "";
			try {
				dirty = await git(["status", "--porcelain"], dir);
			} catch {
				dirty = "unknown";
			}
			if (!dirty) {
				try {
					await git(["worktree", "remove", "--force", dir], root);
					return { kept: false, removed: true, dir };
				} catch (e: any) {
					// The worktree is clean but `git worktree remove` failed — it has leaked on disk.
					// Report it (removed:false) instead of silently swallowing the error.
					return {
						kept: false,
						removed: false,
						dir,
						error: String(e?.message || e),
					};
				}
			}
			return { kept: true, removed: false, dir };
		},
	};
}
