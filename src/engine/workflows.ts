import crypto from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

export const PKG_ROOT = path.dirname(path.dirname(import.meta.dir));

export function workflowDirs(cwd: string): string[] {
	return [
		...new Set([path.join(cwd, "workflows"), path.join(PKG_ROOT, "workflows")]),
	];
}

export async function normalizeCwd(
	input: string | null | undefined = process.cwd(),
): Promise<string> {
	const cwd = await realpath(path.resolve(input || process.cwd()));
	const roots = await configuredAuthorizedRoots();
	if (!isInsideAny(cwd, roots)) {
		throw new Error(`cwd escapes authorized roots: ${cwd}`);
	}
	return cwd;
}

export async function fileExists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

export function sha256Text(text: string): string {
	return `sha256:${crypto.createHash("sha256").update(text).digest("hex")}`;
}

export async function resolveScript(ref: string, cwd: string): Promise<string> {
	if (ref.endsWith(".mjs") || ref.includes("/")) {
		const scriptPath = path.resolve(cwd, ref);
		return assertWorkflowPath(scriptPath, cwd, [
			path.join(PKG_ROOT, "workflows"),
			path.join(cwd, ".agent-workflows", "runs"),
		]);
	}
	for (const dir of workflowDirs(cwd)) {
		const candidate = path.join(dir, `${ref}.mjs`);
		if (await fileExists(candidate))
			return assertWorkflowPath(candidate, cwd, [
				path.join(PKG_ROOT, "workflows"),
			]);
	}
	throw new Error(`unknown workflow '${ref}'. Try: agent-workflows list`);
}

export async function resolveChildWorkflow(
	ref: unknown,
	cwd: string,
	dirs: string[],
	parentDir: string,
): Promise<string> {
	let raw: string;
	if (ref && typeof ref === "object" && "scriptPath" in ref) {
		raw = String((ref as any).scriptPath);
	} else if (typeof ref === "string") {
		raw = ref;
	} else {
		throw new Error("workflow(ref): ref must be a name or { scriptPath }");
	}

	if (!raw.endsWith(".mjs") && !raw.includes("/")) {
		for (const dir of dirs.length ? dirs : [parentDir]) {
			const candidate = path.join(dir, `${raw}.mjs`);
			if (await fileExists(candidate))
				return assertWorkflowPath(candidate, cwd, [
					...dirs,
					parentDir,
					path.join(PKG_ROOT, "workflows"),
				]);
		}
		throw new Error(
			`unknown workflow '${raw}' (looked in: ${(dirs.length ? dirs : [parentDir]).join(", ")})`,
		);
	}

	const scriptPath = path.resolve(parentDir || cwd, raw);
	return assertWorkflowPath(scriptPath, cwd, [
		...dirs,
		parentDir,
		path.join(PKG_ROOT, "workflows"),
	]);
}

export async function readWorkflowSource(scriptPath: string): Promise<string> {
	return readFile(scriptPath, "utf8");
}

export async function assertWorkflowPath(
	scriptPath: string,
	cwd: string,
	extraRoots: string[] = [],
) {
	const allowed = await Promise.all(
		[cwd, ...extraRoots].map((root) => realpathMaybe(root)),
	);
	const resolved = await realpath(scriptPath);
	if (!isInsideAny(resolved, allowed)) {
		throw new Error(
			`workflow script path escapes authorized roots: ${scriptPath}`,
		);
	}
	return resolved;
}

export async function configuredAuthorizedRoots() {
	const roots = [
		...splitRoots(process.env.AGENT_WORKFLOWS_AUTHORIZED_ROOTS),
		...splitRoots(process.env.WORKSPACE_ROOTS),
		...splitRoots(process.env.WORKSPACE_ROOT),
	];
	const out: string[] = [];
	for (const root of roots) {
		const resolved = await realpathMaybe(root);
		if (!out.includes(resolved)) out.push(resolved);
	}
	if (!out.length) out.push(await realpathMaybe(process.cwd()));
	return out;
}

function splitRoots(value: string | undefined) {
	if (!value) return [];
	return value
		.split(/[,\n:]/)
		.map((part) => part.trim())
		.filter(Boolean);
}

async function realpathMaybe(p: string) {
	const resolved = path.resolve(p);
	try {
		return await realpath(resolved);
	} catch {
		return resolved;
	}
}

function isInsideAny(candidate: string, roots: string[]) {
	return roots.some(
		(root) => candidate === root || candidate.startsWith(root + path.sep),
	);
}
