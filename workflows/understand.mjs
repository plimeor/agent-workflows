// understand.mjs — parallel readers over subsystems → a structured architecture map.
//
// Flow:
//   1. One read-only agent discovers the major subsystems/directories of the codebase
//      and returns a structured list (the work-list).
//   2. A read-only deep-read agent per subsystem reads its key files and returns a
//      structured profile: { name, purpose, keyFiles, entryPoints, dependencies, risks }.
//   3. One synthesis agent assembles all profiles into a coherent narrative map plus a
//      "what to read first" ordering for someone new to the codebase.
//
// Why a barrier (parallel) before synthesis: the synthesis stage needs ALL subsystem
// profiles at once to reason about cross-subsystem dependencies and pick a global reading
// order. That is a genuine merge-across-the-full-set step, so a parallel() barrier is
// correct here rather than a per-item pipeline.
//
// args (all optional):
//   {
//     root?:  string,    // repo root to analyze, relative to cwd (default ".")
//     paths?: string[],  // explicit subsystem dirs to read; when given, skips discovery
//   }
// Examples:
//   agent-workflows run understand
//   agent-workflows run understand --args '{"root":"packages"}'
//   agent-workflows run understand --args '{"paths":["packages","plugins","docs"]}'
//
// Returns: { subsystems: [ <profile>, … ], map: <synthesis object> }

export const meta = {
	name: "understand",
	description:
		"Map a codebase: discover subsystems, deep-read each in parallel, synthesize an architecture map + reading order",
	whenToUse:
		"onboarding to an unfamiliar codebase, or auditing how a large repo is structured before changing it",
	phases: [
		{
			title: "Discover",
			detail: "one read-only agent enumerates the major subsystems/dirs",
		},
		{ title: "Read", detail: "one read-only deep-read agent per subsystem" },
		{
			title: "Synthesize",
			detail: "assemble a coherent map + a what-to-read-first ordering",
		},
	],
};

// ── Inputs ──────────────────────────────────────────────────────────────────
const root =
	args && typeof args.root === "string" && args.root.trim()
		? args.root.trim()
		: ".";
const givenPaths =
	args && Array.isArray(args.paths)
		? args.paths
				.filter((p) => typeof p === "string" && p.trim())
				.map((p) => p.trim())
		: null;

// Keep the fan-out sane: read agents are not free, and parallel()/pipeline() cap at 4096.
const MAX_SUBSYSTEMS = 24;

// ── Schemas ─────────────────────────────────────────────────────────────────
const DISCOVERY = {
	type: "object",
	additionalProperties: false,
	required: ["subsystems"],
	properties: {
		subsystems: {
			type: "array",
			description: "The major subsystems / top-level units of the codebase.",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["name", "path", "why"],
				properties: {
					name: {
						type: "string",
						description: 'Short human label, e.g. "runtime engine".',
					},
					path: {
						type: "string",
						description:
							"Primary directory or file for this subsystem, relative to the repo root.",
					},
					why: {
						type: "string",
						description:
							"One line: why this is a distinct subsystem worth reading on its own.",
					},
				},
			},
		},
	},
};

const PROFILE = {
	type: "object",
	additionalProperties: false,
	required: [
		"name",
		"purpose",
		"keyFiles",
		"entryPoints",
		"dependencies",
		"risks",
	],
	properties: {
		name: {
			type: "string",
			description: "The subsystem name (echo the one you were given).",
		},
		purpose: {
			type: "string",
			description:
				"What this subsystem is responsible for and the role it plays in the whole, in 2–4 sentences.",
		},
		keyFiles: {
			type: "array",
			description:
				"The files most worth reading to understand this subsystem, most important first.",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["path", "role"],
				properties: {
					path: {
						type: "string",
						description: "File path relative to the repo root.",
					},
					role: {
						type: "string",
						description: "One line: what this file does / why it matters.",
					},
				},
			},
		},
		entryPoints: {
			type: "array",
			description:
				"Where execution or control enters this subsystem: exported functions, CLI commands, route handlers, main(), public API.",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["name", "location", "description"],
				properties: {
					name: {
						type: "string",
						description: "Symbol / command / route name.",
					},
					location: {
						type: "string",
						description: "file path (and symbol or line if useful).",
					},
					description: {
						type: "string",
						description: "One line: what calling this does.",
					},
				},
			},
		},
		dependencies: {
			type: "array",
			description:
				"What this subsystem depends on: other internal subsystems and notable external packages.",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["target", "kind", "note"],
				properties: {
					target: {
						type: "string",
						description:
							"Name of the depended-on subsystem or external package.",
					},
					kind: {
						type: "string",
						enum: ["internal", "external"],
						description:
							"internal = another subsystem of this repo; external = a third-party/runtime dependency.",
					},
					note: {
						type: "string",
						description: "One line: how/why it is depended upon.",
					},
				},
			},
		},
		risks: {
			type: "array",
			description:
				"Concrete gotchas a newcomer should know: fragile invariants, tight coupling, missing tests, foot-guns, surprising behavior. Empty array if genuinely none.",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["risk", "severity"],
				properties: {
					risk: {
						type: "string",
						description:
							"The specific concern, grounded in something you actually read.",
					},
					severity: {
						type: "string",
						enum: ["low", "medium", "high"],
						description: "How much it should worry someone changing this code.",
					},
				},
			},
		},
	},
};

const MAP = {
	type: "object",
	additionalProperties: false,
	required: [
		"overview",
		"architecture",
		"readingOrder",
		"crossCuttingConcerns",
	],
	properties: {
		overview: {
			type: "string",
			description:
				"A few paragraphs: what this codebase is, the shape of its architecture, and how the subsystems fit together.",
		},
		architecture: {
			type: "array",
			description:
				"The notable relationships between subsystems (who calls/depends on whom, data/control flow).",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["from", "to", "relationship"],
				properties: {
					from: { type: "string", description: "Source subsystem name." },
					to: { type: "string", description: "Target subsystem name." },
					relationship: {
						type: "string",
						description:
							"One line: the nature of the link (calls, configures, reads, spawns, …).",
					},
				},
			},
		},
		readingOrder: {
			type: "array",
			description:
				'The "what to read first" path: an ordered list a newcomer should follow to build understanding bottom-up, foundations before consumers.',
			items: {
				type: "object",
				additionalProperties: false,
				required: ["step", "subsystem", "startFile", "reason"],
				properties: {
					step: {
						type: "integer",
						description: "1-based position in the reading order.",
					},
					subsystem: {
						type: "string",
						description: "Which subsystem to read at this step.",
					},
					startFile: {
						type: "string",
						description: "The single best file to open first for this step.",
					},
					reason: {
						type: "string",
						description: "One line: why this comes here in the order.",
					},
				},
			},
		},
		crossCuttingConcerns: {
			type: "array",
			description:
				"Themes that span multiple subsystems (config, logging, error handling, auth, determinism, …). Empty array if none stand out.",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["concern", "where"],
				properties: {
					concern: { type: "string", description: "The cross-cutting theme." },
					where: {
						type: "string",
						description: "Which subsystems/files it touches.",
					},
				},
			},
		},
	},
};

// ── 1. Discover subsystems (read-only) ──────────────────────────────────────
phase("Discover");

let subsystemList;
if (givenPaths && givenPaths.length) {
	// Caller supplied the work-list explicitly; trust it and skip discovery.
	subsystemList = givenPaths.slice(0, MAX_SUBSYSTEMS).map((p) => ({
		name: p,
		path: p,
		why: "supplied via args.paths",
	}));
	log(
		`Using ${subsystemList.length} caller-supplied subsystem path(s); skipping discovery.`,
	);
} else {
	const discovery = await agent(
		[
			`You are mapping the codebase rooted at "${root}" (relative to the current working directory).`,
			"Goal: identify the MAJOR subsystems — the top-level structural units a newcomer would want to understand separately.",
			"",
			"How to work:",
			`- Inspect the directory tree under "${root}" (list dirs, skim package/build manifests, READMEs, and obvious entry files).`,
			"- Group by responsibility, not by every folder. Merge trivial/sibling dirs into one subsystem when they serve one purpose.",
			"- Ignore noise: node_modules, .git, dist/build output, vendored deps, lockfiles, generated code, test fixtures.",
			`- Aim for the natural number of real subsystems (typically 3–12); never return more than ${MAX_SUBSYSTEMS}.`,
			"- This is reconnaissance only: do not deep-read every file, just enough to name and locate each subsystem.",
			"",
			'Return ONLY the JSON object matching the schema: a "subsystems" array, each with { name, path, why }.',
			"Paths must be relative to the repo root and must actually exist.",
		].join("\n"),
		{ label: "discover-subsystems", phase: "Discover", schema: DISCOVERY },
	);

	const found =
		discovery && Array.isArray(discovery.subsystems)
			? discovery.subsystems
			: [];
	if (!found.length) {
		log("Discovery returned no subsystems; aborting with an empty map.");
		return { subsystems: [], map: null }
	}
	subsystemList = found.slice(0, MAX_SUBSYSTEMS);
	if (found.length > MAX_SUBSYSTEMS) {
		log(
			`Discovery found ${found.length} subsystems; capping deep-read to the first ${MAX_SUBSYSTEMS}.`,
		);
	}
	log(
		`Discovered ${subsystemList.length} subsystem(s): ${subsystemList.map((s) => s.name).join(", ")}`,
	);
}

// ── 2. Deep-read each subsystem (read-only, in parallel) ─────────────────────
// Barrier: the synthesis stage needs every profile at once to reason across subsystems
// and produce a global reading order, so we gather all results before stage 3.
phase("Read");

const profiles = (
	await parallel(
		subsystemList.map(
			(s) => () =>
				agent(
					[
						`You are doing a deep read of ONE subsystem of the codebase rooted at "${root}".`,
						`Subsystem name: ${s.name}`,
						`Primary location: ${s.path}`,
						s.why ? `Context for why it is a subsystem: ${s.why}` : "",
						"",
						"How to work:",
						`- Read the important files at and under "${s.path}" (and follow imports it owns). Read real code, not just names.`,
						"- Focus on understanding responsibility, public surface, and how it connects to the rest of the repo.",
						"- Ground every claim in something you actually read; do not speculate about files you did not open.",
						"- Keep lists tight and ranked by importance — keyFiles and entryPoints should be the ones that truly matter.",
						"",
						"Return ONLY the JSON object matching the schema, with these fields:",
						"- name: echo the subsystem name above.",
						"- purpose: what this subsystem is responsible for and its role in the whole (2–4 sentences).",
						"- keyFiles: the files most worth reading, most important first, each with a one-line role.",
						"- entryPoints: where control enters (exported fns, CLI commands, routes, main, public API), each with location + one line.",
						"- dependencies: internal subsystems and notable external packages it relies on, each tagged kind=internal|external.",
						"- risks: concrete newcomer gotchas grounded in what you read (fragile invariants, coupling, missing tests, foot-guns), each with severity; empty array if none.",
					]
						.filter(Boolean)
						.join("\n"),
					{ label: `read:${s.name}`, phase: "Read", schema: PROFILE },
				),
		),
	)
).filter(Boolean);

if (!profiles.length) {
	log("No subsystem profiles were produced; aborting before synthesis.");
	return { subsystems: [], map: null }
}
log(`Profiled ${profiles.length}/${subsystemList.length} subsystem(s).`);

// ── 3. Synthesize the architecture map (read-only) ───────────────────────────
phase("Synthesize");

const map = await agent(
	[
		`You are assembling a coherent architecture map of the codebase rooted at "${root}".`,
		"You are given the deep-read profiles of its subsystems as JSON. Treat them as your evidence base;",
		"you may open a few files to confirm cross-subsystem links, but rely primarily on the profiles below.",
		"",
		"Subsystem profiles (JSON array):",
		JSON.stringify(profiles),
		"",
		"Produce a map that helps a newcomer understand the whole system fast. Return ONLY the JSON object matching the schema:",
		"- overview: what this codebase is and how the subsystems fit together (a few paragraphs).",
		"- architecture: the notable from→to relationships between subsystems (calls, configures, reads, spawns, …).",
		'- readingOrder: an ordered "what to read first" path. Order bottom-up — foundational/leaf subsystems before the things that build on them — and for each step name the single best startFile and why it comes there.',
		"- crossCuttingConcerns: themes spanning multiple subsystems (config, logging, errors, determinism, auth, …); empty array if none stand out.",
		"Be concrete and consistent with the profiles; do not invent subsystems that are not in the evidence.",
	].join("\n"),
	{ label: "synthesize-map", phase: "Synthesize", schema: MAP },
);

return { subsystems: profiles, map }
