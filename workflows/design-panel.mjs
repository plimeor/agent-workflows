export const meta = {
	name: "design-panel",
	description:
		"Judge panel: independent design approaches scored on a rubric and synthesized into a winner",
	whenToUse:
		"when a design decision is worth exploring from several framings, scoring objectively, and merging the best ideas",
	phases: [
		{
			title: "Propose",
			detail: "N independent designs, each from a different framing",
		},
		{
			title: "Score",
			detail: "parallel judges rate every proposal on the rubric",
		},
		{
			title: "Synthesize",
			detail: "pick the winner and graft the best ideas from runners-up",
		},
	],
};

// ── args ────────────────────────────────────────────────────────────────────
// {
//   problem:     string   (required) — the design problem to solve, stated concretely
//   approaches?: number   (default 3, clamped 2..4) — how many independent framings to run
// }
// Returns: { winner, scores, synthesis }
//   winner    — { approach, design, tradeoffs, totalScore } the top-scoring proposal
//   scores    — [{ approach, scores:{correctness,simplicity,risk,fit}, total, rationale }]
//   synthesis — { winner, justification, graftedIdeas:[{from,idea,why}], finalDesign, risks }

const a = args && typeof args === "object" ? args : {};
const problem =
	typeof a.problem === "string" && a.problem.trim()
		? a.problem.trim()
		: "Design a rate limiter for a public HTTP API that must stay correct under bursty traffic.";

// The four framings, in priority order. We take the first `approaches` of them so each
// proposal attacks the problem from a genuinely different angle (no duplicate lenses).
const FRAMINGS = [
	{
		key: "mvp-first",
		title: "MVP-first",
		lens: "Optimize for the smallest design that ships value this week. Cut scope aggressively, prefer boring proven building blocks, defer anything not needed for a first useful release. Call out exactly what you are deliberately NOT building yet.",
	},
	{
		key: "risk-first",
		title: "Risk-first",
		lens: "Optimize for de-risking. Start from the failure modes, the irreversible decisions, and the unknowns that could sink the project; design so the scariest assumptions are validated earliest and the blast radius of any single mistake is contained.",
	},
	{
		key: "user-first",
		title: "User-first",
		lens: "Optimize for the end-user / consumer experience. Start from the jobs-to-be-done, the ergonomics of the interface or API, error messages, and the path of least surprise; let the implementation follow from what makes the experience excellent.",
	},
	{
		key: "performance-first",
		title: "Performance-first",
		lens: "Optimize for throughput, latency, and resource efficiency at the target scale. Reason from the data path and the hot loop; choose data structures, concurrency model, and storage so the system stays fast and predictable under load.",
	},
];

const rawN = Number(a.approaches);
const n = Number.isFinite(rawN)
	? Math.max(2, Math.min(4, Math.round(rawN)))
	: 3;
const framings = FRAMINGS.slice(0, n);
log(`Running ${framings.length} design framings for: ${problem}`);

// ── Schemas ─────────────────────────────────────────────────────────────────

const PROPOSAL_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["approach", "design", "tradeoffs"],
	properties: {
		approach: {
			type: "string",
			description:
				"One-line name of this design approach, prefixed with its framing.",
		},
		design: {
			type: "string",
			description:
				"The concrete design: components, data flow, key decisions, and how it solves the problem. 150-400 words, specific not generic.",
		},
		tradeoffs: {
			type: "array",
			description:
				"The honest tradeoffs this framing accepts — what it gives up to get its advantage.",
			minItems: 2,
			maxItems: 6,
			items: { type: "string" },
		},
	},
};

const SCORE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["scores", "rationale"],
	properties: {
		scores: {
			type: "object",
			additionalProperties: false,
			required: ["correctness", "simplicity", "risk", "fit"],
			properties: {
				correctness: {
					type: "integer",
					minimum: 0,
					maximum: 10,
					description:
						"Does the design actually solve the stated problem, edge cases included?",
				},
				simplicity: {
					type: "integer",
					minimum: 0,
					maximum: 10,
					description:
						"How easy to build, understand, and operate? Higher = simpler.",
				},
				risk: {
					type: "integer",
					minimum: 0,
					maximum: 10,
					description:
						"How well-contained are failure modes and irreversible bets? Higher = LOWER risk / safer.",
				},
				fit: {
					type: "integer",
					minimum: 0,
					maximum: 10,
					description:
						"How well does it fit the problem constraints and likely future needs?",
				},
			},
		},
		rationale: {
			type: "string",
			description:
				"Concise justification (2-5 sentences) for the four scores, naming concrete strengths and weaknesses.",
		},
	},
};

const SYNTHESIS_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["winner", "justification", "graftedIdeas", "finalDesign", "risks"],
	properties: {
		winner: {
			type: "string",
			description:
				"The approach name of the chosen winning proposal (must match one proposal exactly).",
		},
		justification: {
			type: "string",
			description:
				"Why this proposal wins on the rubric, referencing the scores and rationales. 2-5 sentences.",
		},
		graftedIdeas: {
			type: "array",
			description:
				"Specific ideas borrowed from the runner-up proposals to strengthen the winner.",
			minItems: 0,
			maxItems: 6,
			items: {
				type: "object",
				additionalProperties: false,
				required: ["from", "idea", "why"],
				properties: {
					from: {
						type: "string",
						description: "The approach name the idea is grafted from.",
					},
					idea: {
						type: "string",
						description: "The concrete idea being borrowed.",
					},
					why: {
						type: "string",
						description: "Why grafting it improves the winner.",
					},
				},
			},
		},
		finalDesign: {
			type: "string",
			description:
				"The merged final design: the winner plus grafted ideas, stated as a buildable plan. 200-450 words.",
		},
		risks: {
			type: "array",
			description:
				"Residual risks and open questions in the final design, with how to mitigate or validate each.",
			minItems: 1,
			maxItems: 6,
			items: { type: "string" },
		},
	},
};

// The judges — distinct evaluator personas so scoring is not one homogeneous opinion.
const JUDGES = [
	{
		key: "architect",
		persona:
			"a pragmatic staff engineer who has shipped and operated systems like this in production",
	},
	{
		key: "skeptic",
		persona:
			"an adversarial reviewer whose job is to find where this design breaks, hides cost, or under-delivers",
	},
	{
		key: "product",
		persona:
			"a product-minded reviewer who weighs problem-fit, time-to-value, and the experience of whoever consumes this design",
	},
];

// ── Stage 1+2 as a pipeline: each framing produces a proposal, then is scored ─
// No barrier between propose and score — a proposal can be under judgement while
// another is still being drafted. The synthesis stage DOES need every scored
// proposal at once, so it runs after the pipeline resolves (a genuine barrier).

phase("Propose");

const scored = await pipeline(
	framings,
	// Stage 1 — generate one independent proposal from this framing.
	(framing) =>
		agent(
			[
				`You are a senior systems designer producing ONE design proposal for the following problem.`,
				``,
				`PROBLEM:`,
				problem,
				``,
				`FRAMING — ${framing.title}:`,
				framing.lens,
				``,
				`Commit fully to this framing; do not hedge toward a balanced "best of all worlds" design — that is another agent's job. Produce a concrete, opinionated design that a team could start building from. Be specific about components, data/control flow, and the key decisions; avoid generic platitudes.`,
				``,
				`Your entire final message is consumed programmatically as JSON matching the schema. Return ONLY that JSON. The "approach" field MUST start with "${framing.title}: ".`,
			].join("\n"),
			{
				label: `propose:${framing.key}`,
				phase: "Propose",
				schema: PROPOSAL_SCHEMA,
			},
		),

	// Stage 2 — score this proposal on the rubric with a panel of judges (parallel
	// barrier here is correct: we need ALL judge votes for this one proposal before
	// we can average them). Each judge gets a distinct evaluator persona.
	(proposal, framing) => {
		if (!proposal) return null;
		phase("Score");
		return parallel(
			JUDGES.map(
				(judge) => () =>
					agent(
						[
							`You are ${judge.persona}. Score the design proposal below against a fixed rubric. Be calibrated and discriminating — use the full 0-10 range, do not cluster everything at 7-8.`,
							``,
							`PROBLEM:`,
							problem,
							``,
							`PROPOSAL (${proposal.approach}):`,
							proposal.design,
							``,
							`STATED TRADEOFFS:`,
							...proposal.tradeoffs.map((t) => `- ${t}`),
							``,
							`RUBRIC (score each 0-10 integer):`,
							`- correctness: does it actually solve the problem including edge cases?`,
							`- simplicity: how easy to build, understand, and operate (higher = simpler)?`,
							`- risk: how contained are failure modes and irreversible bets (higher = SAFER)?`,
							`- fit: how well does it fit the problem's constraints and likely future needs?`,
							``,
							`Judge the design on its merits, not on how confidently it is written. Your entire final message is consumed programmatically as JSON matching the schema — return ONLY that JSON.`,
						].join("\n"),
						{
							label: `score:${framing.key}:${judge.key}`,
							phase: "Score",
							schema: SCORE_SCHEMA,
						},
					),
			),
		).then((votes) => {
			// Average the panel's votes into a single rubric score for this proposal.
			const valid = votes.filter(Boolean);
			const dims = ["correctness", "simplicity", "risk", "fit"];
			const avg = {};
			for (const d of dims) {
				const xs = valid
					.map((v) => v.scores[d])
					.filter((x) => typeof x === "number");
				avg[d] = xs.length
					? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10
					: 0;
			}
			const total =
				Math.round(
					(avg.correctness + avg.simplicity + avg.risk + avg.fit) * 10,
				) / 10;
			log(
				`Scored ${proposal.approach} → ${total}/40 (${valid.length}/${JUDGES.length} judges)`,
			);
			return {
				proposal,
				approach: proposal.approach,
				scores: avg,
				total,
				rationale: valid
					.map((v) => v.rationale)
					.filter(Boolean)
					.join(" | "),
				judgeCount: valid.length,
			};
		});
	},
);

// Drop any framing whose proposal failed to generate, then rank by total score.
const ranked = scored
	.filter((s) => s && s.proposal)
	.sort((x, y) => y.total - x.total);

if (!ranked.length) {
	return { winner: null, scores: [], synthesis: null, error: 'no proposals could be generated or scored' }
}

const scoresOut = ranked.map((s) => ({
	approach: s.approach,
	scores: s.scores,
	total: s.total,
	rationale: s.rationale,
}));

const topByScore = ranked[0];
log(`Top by raw score: ${topByScore.approach} (${topByScore.total}/40)`);

// ── Stage 3: synthesis (barrier) — needs every scored proposal at once ────────
// One agent sees the full panel: all proposals, all scores, all rationales. It
// confirms the winner and grafts the strongest ideas from the runners-up.

phase("Synthesize");

const synthesis = await agent(
	[
		`You are the head judge synthesizing a design panel. You see every proposal and the panel's rubric scores. Pick the winner and produce a single merged final design that grafts the strongest ideas from the runners-up onto it.`,
		``,
		`PROBLEM:`,
		problem,
		``,
		`PROPOSALS AND SCORES (sorted best-first by total; rubric is correctness/simplicity/risk/fit, each 0-10, higher always better, total out of 40):`,
		``,
		...ranked.map((s, i) =>
			[
				`### #${i + 1} — ${s.approach}`,
				`Total: ${s.total}/40  (correctness ${s.scores.correctness}, simplicity ${s.scores.simplicity}, risk ${s.scores.risk}, fit ${s.scores.fit})`,
				`Design: ${s.proposal.design}`,
				`Tradeoffs: ${s.proposal.tradeoffs.join("; ")}`,
				`Panel rationale: ${s.rationale}`,
				``,
			].join("\n"),
		),
		`Instructions:`,
		`- Choose the winner. The highest total ("${topByScore.approach}") is the default, but you MAY override it if a lower-scored proposal is clearly the better foundation — if you override, justify it explicitly against the scores.`,
		`- The "winner" field MUST match one proposal's approach name exactly.`,
		`- Graft only ideas that genuinely strengthen the winner; for each, name the source proposal, the idea, and why it helps. Do not graft ideas that conflict with the winner's core bet.`,
		`- Produce a "finalDesign" that is buildable: the winner plus grafted ideas as one coherent plan.`,
		`- List residual risks/open questions with how to mitigate or validate each.`,
		``,
		`Your entire final message is consumed programmatically as JSON matching the schema — return ONLY that JSON.`,
	].join("\n"),
	{ label: "synthesize", phase: "Synthesize", schema: SYNTHESIS_SCHEMA },
);

// Resolve the declared winner back to its full proposal; fall back to top-by-score.
const winnerEntry =
	(synthesis && ranked.find((s) => s.approach === synthesis.winner)) ||
	topByScore;

const winner = {
	approach: winnerEntry.approach,
	design: winnerEntry.proposal.design,
	tradeoffs: winnerEntry.proposal.tradeoffs,
	totalScore: winnerEntry.total,
};

return {
  winner,
  scores: scoresOut,
  synthesis: synthesis || null,
}
