export const meta = {
	name: "migrate",
	description:
		"Discover sites needing a change, transform each in worktree isolation, then verify and summarize",
	whenToUse:
		"a mechanical code migration / codemod across many files where each edit must be applied AND its tests/build re-run in an isolated git worktree so parallel mutators never collide",
	phases: [
		{
			title: "Discover",
			detail: "one read-only agent finds every site needing the change",
		},
		{
			title: "Transform",
			detail: "per-site worktree mutator applies the change and verifies it",
		},
		{
			title: "Summarize",
			detail:
				"report applied vs failed and worktrees kept for conflict resolution",
		},
	],
};

// ─────────────────────────────────────────────────────────────────────────────
// args (the --args / --args-file JSON value, verbatim):
//   {
//     instruction: string   // REQUIRED. The migration to perform, e.g.
//                           //   "replace all uses of the deprecated `request` HTTP
//                           //    client with `undici.fetch`, keeping behavior identical".
//     glob?: string         // OPTIONAL. Restrict discovery to matching paths, e.g.
//                           //   "src/**/*.ts". Defaults to the whole repo.
//   }
// Returns: { applied: [{file, notes}], failed: [{file, applied, verified, notes}], summary }
//   summary — the human-readable rollup written by the Summarize agent (null if it failed)
// ─────────────────────────────────────────────────────────────────────────────

const a = args && typeof args === "object" ? args : {};
const instruction =
	typeof a.instruction === "string" && a.instruction.trim()
		? a.instruction.trim()
		: "Apply the requested migration consistently across the codebase.";
const glob = typeof a.glob === "string" && a.glob.trim() ? a.glob.trim() : null;
const scope = glob
	? `Restrict your search to files matching the glob: ${glob}`
	: "Search the entire repository.";

// Structured output of the discovery agent: every site that must change.
const SITES = {
	type: "object",
	additionalProperties: false,
	required: ["sites"],
	properties: {
		sites: {
			type: "array",
			maxItems: 4096,
			items: {
				type: "object",
				additionalProperties: false,
				required: ["file", "reason"],
				properties: {
					file: { type: "string", minLength: 1 }, // repo-relative path that needs the change
					reason: { type: "string", minLength: 1 }, // concrete evidence: what in this file matches the migration
				},
			},
		},
	},
};

// Structured output of each per-site transform agent.
const TRANSFORM = {
	type: "object",
	additionalProperties: false,
	required: ["file", "applied", "verified", "notes"],
	properties: {
		file: { type: "string", minLength: 1 },
		applied: { type: "boolean" }, // were the intended edits written to this file?
		verified: { type: "boolean" }, // did this file's tests/build pass AFTER the edit?
		notes: { type: "string" }, // command(s) run, pass/fail detail, or why it could not be applied/verified
	},
};

// ── Phase 1: discover (read-only scout) ─────────────────────────────────────
phase("Discover");
log(
	glob
		? `Discovering migration sites under ${glob}`
		: "Discovering migration sites across the repo",
);

const discovered = await agent(
	`You are a code-migration scout working in a read-only checkout. Do NOT edit any files.

MIGRATION TO PERFORM (verbatim):
${instruction}

TASK
${scope}
Find EVERY file that needs to change for this migration to be complete. Use ripgrep/grep
and read the actual code — match on real usage, not just names. Include a file only if you
can point to a concrete construct in it that this migration must touch. Exclude generated
output, vendored/third-party code, lockfiles, and build artifacts. Do not include a file
merely because it imports something tangential.

For each site, give the repo-relative path and a one-line reason citing the concrete thing
in that file the migration must change (symbol, call, pattern, or line).

Return ONLY the JSON object required by the schema — no prose, no markdown, no commentary.
If nothing needs to change, return { "sites": [] }.`,
	{ label: "discover-sites", phase: "Discover", schema: SITES },
);

const sites =
	discovered && Array.isArray(discovered.sites) ? discovered.sites : [];
if (!sites.length) {
	log("No sites need the change — nothing to migrate.");
	return { applied: [], failed: [] }
}
log(`Found ${sites.length} site(s) to migrate.`);

// ── Phase 2: transform each site in its OWN worktree, then verify ────────────
// CRITICAL: these mutators run IN PARALLEL across sites. Each MUST use
// isolation:'worktree' so it edits files in a private git worktree checkout. Without
// per-agent worktree isolation, concurrent writers would race on the shared checkout and
// clobber each other. (Write capability itself comes from the host harness's own sandbox
// config — agent-workflows no longer sets one.) A worktree with leftover changes is KEPT and
// its path reported (e.g. a verification failure or conflict), so a human can inspect or
// resolve it; clean worktrees are auto-removed.
phase("Transform");

const transformed = await pipeline(sites, (site) =>
	agent(
		`You are applying ONE step of a code migration inside an isolated git worktree that is
yours alone. You may edit and run commands here freely; nothing you do touches other agents.

MIGRATION TO PERFORM (verbatim):
${instruction}

TARGET FILE (repo-relative): ${site.file}
WHY THIS FILE WAS FLAGGED: ${site.reason}

STEPS
1. Open ${site.file} and apply the migration to it. Make the smallest change that fully and
   correctly performs the migration for this file; preserve behavior and existing style.
   Update only what this migration requires (including imports it forces in THIS file).
2. VERIFY the result. Run the most specific check available for this file, preferring the
   narrowest scope: this file's unit test(s) if they exist, otherwise a type-check/build of
   the module, otherwise a lint/compile of the file. Discover the project's tooling from its
   config (package.json scripts, Makefile, etc.); do not assume a command exists — if you run
   one, use the real one. Capture whether it passed.
3. If you cannot apply the change (ambiguous, out of scope, or the file does not actually need
   it after inspection), make NO edits and report applied=false with the reason.

Report exactly:
  file     = "${site.file}"
  applied  = true only if you wrote the intended edits to this file
  verified = true only if a real check RAN and PASSED after the edit (false if no check exists,
             it failed, or you applied nothing)
  notes    = the exact command(s) you ran and their outcome, or the precise reason you did not
             apply/verify. Keep it to a few lines.

Return ONLY the JSON object required by the schema — no prose, no markdown.`,
		{
			label: `migrate:${site.file}`,
			phase: "Transform",
			schema: TRANSFORM,
			isolation: "worktree", // parallel mutator → private worktree checkout
		},
	),
);

// pipeline() already awaited every item (Promise.all under the hood); a dropped item is null.
const results = transformed.filter(Boolean);
const dropped = transformed.length - results.length;
if (dropped)
	log(`${dropped} site(s) errored out during transform and were dropped.`);

const applied = results.filter((r) => r.applied && r.verified);
const failed = results.filter((r) => !(r.applied && r.verified));
log(`${applied.length} applied+verified, ${failed.length} need attention.`);

// ── Phase 3: summarize (read-only; reasons over the COLLECTED results) ───────
// No parallel() barrier is needed: the pipeline above is already a join point, so the
// full result set is in hand. We hand it to one summarizer as JSON for a human-readable
// rollup that calls out kept worktrees worth resolving by hand.
phase("Summarize");

const summary = await agent(
	`You are writing the final report for a code migration that ran one transform agent per file,
each in its own git worktree. A worktree whose verification failed or that still has
uncommitted/conflicting changes was KEPT on disk for a human to resolve; clean ones were
auto-removed.

MIGRATION (verbatim):
${instruction}

PER-FILE RESULTS (JSON):
${JSON.stringify(results, null, 2)}

Write a concise plain-text summary for an engineer:
- Counts: total sites, applied+verified, and not-fully-done (applied but unverified, or not
  applied at all).
- List the files that succeeded (applied AND verified).
- List the files that need attention, each with a one-line reason drawn from its notes, and
  flag the ones most likely to have a KEPT worktree to resolve by hand (those that were
  applied but failed verification, which signal a real conflict or regression).
- End with the single most useful next action.

Return your report as plain text only — it is consumed directly as the message, so no JSON
and no markdown fences.`,
	{ label: "summarize", phase: "Summarize" },
);

return {
  applied: applied.map((r) => ({ file: r.file, notes: r.notes })),
  failed: failed.map((r) => ({ file: r.file, applied: r.applied, verified: r.verified, notes: r.notes })),
  summary: typeof summary === "string" && summary.trim() ? summary : null,
}
