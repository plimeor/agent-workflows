export const meta = {
	name: "review-changes",
	description:
		"Review a code change across dimensions, then adversarially verify every finding before reporting it",
	whenToUse:
		"before merging a branch/PR — review the diff vs a base across bugs/correctness/security/perf/tests, dropping findings that independent skeptics can refute",
	phases: [
		{
			title: "Scope",
			detail:
				"one read-only agent lists changed files + diff summary vs the base",
		},
		{
			title: "Review",
			detail:
				"one agent per dimension reviews the diff and returns structured findings",
		},
		{
			title: "Verify",
			detail:
				"independent skeptics try to REFUTE each finding; a majority must fail to refute",
		},
	],
};

// ── Inputs (args) ────────────────────────────────────────────────────────────
// args = {
//   base?: string,         // git ref to diff against (default "HEAD~1")
//   dimensions?: string[], // review lenses (default below); unknown names get a generic prompt
// }
// Example:
//   agent-workflows run review-changes --args '{"base":"main","dimensions":["bugs","security"]}'
//
// Returns: { base, reviewed: string[], confirmed: Finding[], droppedCount: number }
//   Finding = { dimension, file, line, title, detail, severity, refutedVotes, totalVotes }

const a = args || {};
const BASE =
	typeof a.base === "string" && a.base.trim() ? a.base.trim() : "HEAD~1";

// Known dimensions carry a focused brief; an unknown name still works via a generic brief.
const DIMENSION_BRIEFS = {
	bugs: "logic errors, off-by-one, null/undefined deref, unhandled errors/rejections, resource leaks, incorrect control flow, broken edge cases, and regressions introduced by this change.",
	correctness:
		"whether the change actually does what it intends: contract/spec violations, wrong return values, broken invariants, inconsistent state, API misuse, and behavioral differences from the pre-change code.",
	security:
		"injection (SQL/command/path), missing authn/authz checks, unsafe deserialization, secrets in code, SSRF, unvalidated input reaching sinks, weak crypto, and newly widened trust boundaries.",
	perf: "accidental O(n^2)/quadratic loops, work inside hot paths, N+1 queries, missing pagination/limits, redundant allocations or I/O, blocking calls on async paths, and unbounded growth.",
	tests:
		"changed behavior left uncovered, deleted/weakened assertions, tests that pass without exercising the new code, missing edge/error-path coverage, and flaky or non-deterministic constructs introduced.",
};
const DEFAULT_DIMENSIONS = ["bugs", "correctness", "security", "perf", "tests"];

const DIMENSIONS = (
	Array.isArray(a.dimensions) && a.dimensions.length
		? a.dimensions
		: DEFAULT_DIMENSIONS
)
	.map((d) => String(d).trim().toLowerCase())
	.filter(Boolean);

// How many independent skeptics challenge each finding, and the bar to keep it.
const VERIFIERS_PER_FINDING = 3;

// ── Schemas (force structured agent output) ──────────────────────────────────

const SCOPE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["files", "summary"],
	properties: {
		files: {
			type: "array",
			description: "one entry per file changed vs the base",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["path", "status", "churn"],
				properties: {
					path: { type: "string" },
					status: {
						type: "string",
						description: "added | modified | deleted | renamed",
					},
					churn: {
						type: "string",
						description: 'e.g. "+42 -3" (added/removed line counts)',
					},
				},
			},
		},
		summary: {
			type: "string",
			description: "one paragraph: what this change set appears to do overall",
		},
	},
};

const FINDINGS_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["findings"],
	properties: {
		findings: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["file", "line", "title", "detail", "severity"],
				properties: {
					file: { type: "string", description: "path relative to repo root" },
					line: {
						type: "integer",
						description:
							"best line number in the NEW file; 0 if not line-specific",
					},
					title: {
						type: "string",
						description: "one-line claim of the problem",
					},
					detail: {
						type: "string",
						description:
							"why it is a real problem and the concrete failure it causes",
					},
					severity: {
						type: "string",
						description: "critical | high | medium | low",
					},
				},
			},
		},
	},
};

const VERDICT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["refuted", "reason"],
	properties: {
		refuted: {
			type: "boolean",
			description:
				"true if you successfully REFUTED the finding (it is not a real problem in this diff)",
		},
		reason: {
			type: "string",
			description: "the specific code-grounded evidence for your verdict",
		},
	},
};

// ── Stage 1: scope the change (read-only) ────────────────────────────────────

phase("Scope");
const scope = await agent(
	`You are scoping a code change for review. The base ref is \`${BASE}\`.

Run git to discover exactly what changed vs the base (do not modify anything):
  git --no-pager diff --stat ${BASE}...HEAD
  git --no-pager diff --name-status ${BASE}...HEAD
(If '${BASE}...HEAD' fails — e.g. shallow clone or no merge-base — fall back to 'git --no-pager diff ${BASE}'.)

Return the changed files (path, status, per-file churn) and a one-paragraph summary of what
the change set does overall. Report only files that actually changed. Return ONLY the JSON.`,
	{ label: "scope-diff", phase: "Scope", schema: SCOPE_SCHEMA },
);

const files = scope?.files || [];
if (!files.length) {
	log(`No changes found vs ${BASE} — nothing to review.`);
	return { base: BASE, reviewed: [], confirmed: [], droppedCount: 0 }
}

const fileList = files
	.map((f) => `  ${f.status}  ${f.path} (${f.churn})`)
	.join("\n");
log(
	`Reviewing ${files.length} changed file(s) vs ${BASE} across: ${DIMENSIONS.join(", ")}`,
);

// Shared orientation handed to every reviewer/verifier so they read the same diff.
const DIFF_CONTEXT = `Base ref: \`${BASE}\`. Inspect the change with:
  git --no-pager diff ${BASE}...HEAD            (full diff)
  git --no-pager show HEAD:<path> / cat <path>  (read the post-change file around a line)

Change summary: ${scope.summary}
Changed files:
${fileList}`;

// ── Stages 2+3: per-dimension review, then adversarial verify each finding ───
// pipeline (not parallel): each dimension's findings flow straight into verification as soon
// as that dimension lands — no barrier, since verification never needs the other dimensions.

phase("Review");
const reviewed = await pipeline(
	DIMENSIONS,

	// Stage 2 — review one dimension and return structured findings.
	(dim) => {
		const brief =
			DIMENSION_BRIEFS[dim] ||
			`issues specific to the "${dim}" aspect of this change.`;
		return agent(
			`You are a senior reviewer auditing a code change for ONE dimension: ${dim.toUpperCase()}.

Focus exclusively on: ${brief}

${DIFF_CONTEXT}

Review only lines introduced or changed by this diff (you may read surrounding code for
context, but do not report pre-existing issues the diff did not touch or worsen). For each
real problem, give the file, the best NEW-file line number, a one-line title, a detail that
names the concrete failure it causes, and a severity (critical|high|medium|low). Be precise
and conservative — no speculation, no style nits. If you find nothing, return an empty list.
Return ONLY the JSON.`,
			{ label: `review:${dim}`, phase: "Review", schema: FINDINGS_SCHEMA },
		).then((r) => ({ dim, findings: r?.findings || [] }));
	},

	// Stage 3 — for each finding, spawn VERIFIERS_PER_FINDING independent skeptics, each told to
	// REFUTE it. Keep the finding only if a MAJORITY fail to refute. parallel() here is a barrier
	// over the skeptics of a SINGLE finding — we need every vote before tallying that finding.
	({ dim, findings }) =>
		parallel(
			findings.map(
				(f) => () =>
					parallel(
						Array.from(
							{ length: VERIFIERS_PER_FINDING },
							(_unused, i) => () =>
								agent(
									`You are skeptic #${i + 1} of ${VERIFIERS_PER_FINDING}, working INDEPENDENTLY. Your job is to REFUTE
the finding below — prove it is NOT a real problem in this specific change. Assume it is wrong
until the code forces you to agree.

${DIFF_CONTEXT}

Finding (dimension: ${dim}):
  file:     ${f.file}
  line:     ${f.line}
  severity: ${f.severity}
  title:    ${f.title}
  detail:   ${f.detail}

Read the actual post-change code at that location and the relevant diff. Try hard to refute it:
the line/file is wrong, the condition cannot occur, an existing guard/validation prevents it,
the behavior is intended, it is pre-existing and untouched, or the detail misreads the code.
Set "refuted": true ONLY if you can show with concrete code evidence that it is not a real
problem. If the problem genuinely holds, set "refuted": false. Return ONLY the JSON.`,
									{
										label: `refute:${dim}:${i + 1}`,
										phase: "Verify",
										schema: VERDICT_SCHEMA,
									},
								),
						),
					).then((verdicts) => {
						const votes = verdicts.filter(Boolean);
						const refutedVotes = votes.filter((v) => v.refuted === true).length;
						const totalVotes = votes.length;
						// Survives only if a MAJORITY did NOT refute it. No votes back (all skeptics died)
						// is treated as unverified → dropped, so we never report on zero evidence.
						const survives = totalVotes > 0 && refutedVotes * 2 < totalVotes;
						return { ...f, dimension: dim, refutedVotes, totalVotes, survives };
					}),
			),
		),
);

// ── Tally ─────────────────────────────────────────────────────────────────────

const verified = reviewed.flat().filter(Boolean); // drop dropped pipeline items + dead verify thunks
const confirmed = verified
	.filter((f) => f.survives)
	.map(({ survives, ...keep }) => keep);
const droppedCount = verified.length - confirmed.length;

const order = { critical: 0, high: 1, medium: 2, low: 3 };
confirmed.sort((x, y) => (order[x.severity] ?? 9) - (order[y.severity] ?? 9));

log(
	`Confirmed ${confirmed.length} finding(s); dropped ${droppedCount} that skeptics refuted.`,
);

return { base: BASE, reviewed: DIMENSIONS, confirmed, droppedCount }
