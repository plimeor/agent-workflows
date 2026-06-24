export const meta = {
	name: "deep-research",
	description:
		"Multi-source research with adversarial fact-checking and a cited synthesis",
	whenToUse:
		"when a question needs broad web research that must be fact-checked before you trust it",
	phases: [
		{
			title: "Gather",
			detail:
				"fan out one searcher per distinct angle (definitions, latest, criticisms, comparisons, primary sources)",
		},
		{
			title: "Dedup",
			detail:
				"merge overlapping claims into one canonical claim with a union of sources",
		},
		{
			title: "Verify",
			detail:
				"independent adversarial checkers rule each claim supported / refuted / unverified",
		},
		{
			title: "Synthesize",
			detail: "one writer composes a cited report from the verified claim set",
		},
	],
};

// ---------------------------------------------------------------------------
// args (verbatim --args / --args-file JSON):
//   {
//     question: string   // REQUIRED — the research question to investigate
//     breadth?: number   // optional — how many search angles to fan out (default 5,
//                        //            clamped 1..5; auto-narrowed when --budget is tight)
//   }
// Returns: { question, report: string, claims: [{ claim, sources: [{title,url}], verdict }] }
//   verdict ∈ "supported" | "refuted" | "unverified"
// ---------------------------------------------------------------------------

// ---- input normalization (sensible fallbacks, never trust args) -----------
const a = args && typeof args === "object" ? args : {};
const question =
	typeof a.question === "string" && a.question.trim()
		? a.question.trim()
		: "What are the current best practices, and the main open criticisms, in this field?";

// Five distinct research angles. Each searcher gets exactly ONE so coverage is
// orthogonal rather than five agents racing to the same top hits.
const ANGLES = [
	{
		key: "definitions",
		lens: "Definitions & fundamentals",
		brief:
			"Establish what the core terms, concepts, and scope actually mean. Capture authoritative, settled definitions and the foundational mechanics — the things an expert would treat as common ground.",
	},
	{
		key: "latest",
		lens: "Latest developments",
		brief:
			"Find the most recent developments, releases, data, and state-of-the-art results. Prefer sources from the last 12-18 months and ALWAYS record the publication date in the claim text so staleness is visible.",
	},
	{
		key: "criticisms",
		lens: "Criticisms, risks & failure modes",
		brief:
			"Hunt specifically for skeptical, dissenting, and negative coverage: documented failures, limitations, retractions, controversies, and credible counter-arguments. Do NOT report the consensus view here — report what challenges it.",
	},
	{
		key: "comparisons",
		lens: "Comparisons & alternatives",
		brief:
			"Find head-to-head comparisons, benchmarks, trade-off analyses, and competing approaches/alternatives. Each claim should make the comparison concrete (X beats Y on Z by some measure), not vague.",
	},
	{
		key: "primary",
		lens: "Primary & authoritative sources",
		brief:
			"Go to the source: peer-reviewed papers, official docs/specs, standards bodies, government/dataset releases, and first-party statements. Avoid blogs and aggregators summarizing those — cite the primary artifact itself.",
	},
];

// Budget-aware depth. With --budget set, narrow how many angles we fan out so the
// run fits; with no budget, remaining() is Infinity and we honor the request.
const askedBreadth = Number.isFinite(a.breadth)
	? Math.max(1, Math.min(5, Math.trunc(a.breadth)))
	: 5;
let breadth = askedBreadth;
if (budget.total) {
	// ~80k output tokens is a rough cost for one angle's full search+verify chain.
	const affordable = Math.max(
		1,
		Math.min(5, Math.floor(budget.total / 80_000)),
	);
	if (affordable < breadth) {
		breadth = affordable;
		log(
			`budget ${Math.round(budget.total / 1000)}k tokens → narrowing breadth ${askedBreadth} → ${breadth} angles`,
		);
	}
}
const selectedAngles = ANGLES.slice(0, breadth);
if (selectedAngles.length < ANGLES.length) {
	log(
		`covering ${selectedAngles.length}/${ANGLES.length} angles: ${selectedAngles.map((x) => x.key).join(", ")}`,
	);
}

// ---- schemas --------------------------------------------------------------
const SOURCE = {
	type: "object",
	additionalProperties: false,
	required: ["title", "url"],
	properties: {
		title: {
			type: "string",
			description: "Human-readable source title or publisher",
		},
		url: {
			type: "string",
			description: "Direct URL to the source backing the claim",
		},
	},
};

const CLAIMS_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["claims"],
	properties: {
		claims: {
			type: "array",
			description:
				"Discrete, falsifiable factual claims gathered for this angle",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["claim", "sources"],
				properties: {
					claim: {
						type: "string",
						description:
							"One self-contained factual statement (include dates/numbers inline). No opinions, no hedging.",
					},
					sources: {
						type: "array",
						description:
							"One or more sources that directly support this exact claim",
						minItems: 1,
						items: SOURCE,
					},
				},
			},
		},
	},
};

const DEDUP_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["claims"],
	properties: {
		claims: {
			type: "array",
			description:
				"Canonical, de-duplicated claim set; overlapping claims merged with a union of sources",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["claim", "sources"],
				properties: {
					claim: {
						type: "string",
						description: "The merged canonical wording of the claim",
					},
					sources: { type: "array", minItems: 1, items: SOURCE },
				},
			},
		},
	},
};

const VERDICT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["verdict", "rationale"],
	properties: {
		verdict: {
			type: "string",
			enum: ["supported", "refuted", "unverified"],
			description:
				"supported = independent evidence confirms it; refuted = independent evidence contradicts it; unverified = could not corroborate from independent sources",
		},
		rationale: {
			type: "string",
			description:
				"One or two sentences citing what independent evidence you found and why it leads to this verdict",
		},
		corroborating: {
			type: "array",
			description:
				"Independent sources (NOT the original ones) that support or contradict the claim, if any were found",
			items: SOURCE,
		},
	},
};

// ---- prompt builders ------------------------------------------------------
function searchPrompt(angle) {
	return [
		`You are a research analyst. Investigate this question through ONE specific lens.`,
		``,
		`QUESTION: ${question}`,
		`YOUR LENS: ${angle.lens}`,
		`WHAT TO DO: ${angle.brief}`,
		``,
		`Use your web search and fetch tools to find real, current sources. Do NOT rely on memory —`,
		`every claim must be backed by a source you actually retrieved, with its real URL.`,
		``,
		`Rules:`,
		`- Produce 4-8 discrete, falsifiable claims that are relevant to the QUESTION from YOUR lens.`,
		`- Each claim must be one self-contained sentence with concrete specifics (numbers, dates, names) inline.`,
		`- No opinions, no vague generalities, no "experts say". State the fact and cite who/what backs it.`,
		`- Every claim needs >=1 source with a real title and a real, fetchable URL. Prefer the original source.`,
		`- Stay in YOUR lens; do not drift into the others' territory.`,
		`- If a search returns nothing usable, return fewer claims rather than inventing any.`,
	].join("\n");
}

function dedupPrompt(rawClaims) {
	return [
		`You are merging research claims gathered by several analysts about one question.`,
		`Many claims overlap, restate, or partially duplicate each other.`,
		``,
		`QUESTION: ${question}`,
		``,
		`RAW CLAIMS (JSON):`,
		JSON.stringify(rawClaims, null, 2),
		``,
		`Task:`,
		`- Collapse claims that assert the same fact into ONE canonical claim, taking the clearest wording`,
		`  and the UNION of their sources (dedupe identical URLs).`,
		`- Keep genuinely distinct claims separate, even if related.`,
		`- Drop claims that are pure opinion, off-topic, or have no usable source.`,
		`- Do NOT invent new claims or new sources; only reorganize what is given.`,
		`- Preserve concrete specifics (dates, numbers) in the canonical wording.`,
	].join("\n");
}

function verifyPrompt(claim) {
	return [
		`You are an adversarial fact-checker. Your job is to TRY TO REFUTE the claim below using`,
		`INDEPENDENT evidence — sources OTHER than the ones already attached to it.`,
		``,
		`CLAIM: ${claim.claim}`,
		`ORIGINAL SOURCES (do not just re-read these — find your own):`,
		JSON.stringify(claim.sources || [], null, 2),
		``,
		`Use your web search and fetch tools. Then rule:`,
		`- "supported": independent sources corroborate the claim.`,
		`- "refuted": independent sources contradict the claim (it is false, outdated, or misstated).`,
		`- "unverified": you could not find independent corroboration either way.`,
		``,
		`Be skeptical: a claim that only its own original source supports is "unverified", not "supported".`,
		`Cite the independent corroborating/contradicting sources you actually retrieved.`,
	].join("\n");
}

function synthesisPrompt(verifiedClaims) {
	return [
		`You are writing a rigorous, cited research report answering the question below.`,
		`You are given a fact-checked claim set; each claim carries a verdict from an independent checker.`,
		``,
		`QUESTION: ${question}`,
		``,
		`FACT-CHECKED CLAIMS (JSON):`,
		JSON.stringify(verifiedClaims, null, 2),
		``,
		`Write a Markdown report that:`,
		`- Directly answers the question up front, then develops it in well-organized sections.`,
		`- Builds primarily on "supported" claims. You MAY mention "unverified" claims but must label them`,
		`  as unconfirmed. Treat "refuted" claims as false — only cite them to correct a misconception.`,
		`- Cites sources inline as [n] markers and ends with a numbered "Sources" list of the URLs used.`,
		`- Includes a short "Limitations & open questions" section noting weak evidence and disagreements.`,
		`- Is honest about uncertainty; never overstate confidence beyond what the verdicts support.`,
		``,
		`Output ONLY the report Markdown — it is consumed directly as the result, so no preamble or sign-off.`,
	].join("\n");
}

// ===========================================================================
// (1) GATHER — one searcher per distinct angle, in parallel.
//     A barrier is correct here: stage (2) dedup must see ALL angles' claims at
//     once to merge cross-angle duplicates.
// ===========================================================================
phase("Gather");
const perAngle = await parallel(
	selectedAngles.map(
		(angle) => () =>
			agent(searchPrompt(angle), {
				label: `search:${angle.key}`,
				phase: "Gather",
				schema: CLAIMS_SCHEMA,
			}),
	),
);

const rawClaims = perAngle
	.filter(Boolean)
	.flatMap((r) => (Array.isArray(r.claims) ? r.claims : []))
	.filter(
		(c) =>
			c &&
			typeof c.claim === "string" &&
			c.claim.trim() &&
			Array.isArray(c.sources) &&
			c.sources.length,
	);

log(
	`gathered ${rawClaims.length} raw claims across ${selectedAngles.length} angles`,
);
if (!rawClaims.length) {
	return { question, report: 'No sourced claims could be gathered for this question.', claims: [] }
}

// ===========================================================================
// (2) DEDUP — single merge pass over the full claim set (needs everything).
// ===========================================================================
phase("Dedup");
const dedup = await agent(dedupPrompt(rawClaims), {
	label: "dedup-claims",
	phase: "Dedup",
	schema: DEDUP_SCHEMA,
});

let claims = (
	dedup && Array.isArray(dedup.claims) ? dedup.claims : rawClaims
).filter(
	(c) =>
		c &&
		typeof c.claim === "string" &&
		c.claim.trim() &&
		Array.isArray(c.sources) &&
		c.sources.length,
);
if (!claims.length) claims = rawClaims;
log(`deduped to ${claims.length} canonical claims`);

// ===========================================================================
// (3) VERIFY — adversarially fact-check each claim with an INDEPENDENT agent.
//     No barrier needed across claims, so use pipeline: each claim flows
//     gather→verdict on its own, and verification starts as soon as it is ready.
// ===========================================================================
phase("Verify");
const verified = (
	await pipeline(claims, (claim) =>
		agent(verifyPrompt(claim), {
			label: `verify:${claim.claim.slice(0, 32)}`,
			phase: "Verify",
			schema: VERDICT_SCHEMA,
		}).then((v) => ({
			claim: claim.claim,
			sources: claim.sources,
			verdict: (v && v.verdict) || "unverified",
			rationale: (v && v.rationale) || "verification agent returned no result",
			corroborating: v && Array.isArray(v.corroborating) ? v.corroborating : [],
		})),
	)
).filter(Boolean);

const tally = verified.reduce(
	(m, c) => ((m[c.verdict] = (m[c.verdict] || 0) + 1), m),
	{},
);
log(
	`verified: ${verified.length} claims — ${Object.entries(tally)
		.map(([k, n]) => `${n} ${k}`)
		.join(", ")}`,
);

// ===========================================================================
// (4) SYNTHESIZE — one writer composes the cited report from verified claims.
// ===========================================================================
phase("Synthesize");
const report = await agent(synthesisPrompt(verified), {
	label: "write-report",
	phase: "Synthesize",
});

return {
  question,
  report: (typeof report === 'string' && report.trim())
    ? report
    : 'Report synthesis failed; see the verified claims for the underlying findings.',
  claims: verified.map((c) => ({ claim: c.claim, sources: c.sources, verdict: c.verdict })),
}
