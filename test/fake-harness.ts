// In-process fake of a @plimeor/harness handle's process.run, for engine tests. It never
// spawns a subprocess: it reads directives out of the prompt the engine built and returns a
// canned text result, so the runtime is exercised without a real host CLI or tokens.
//
// Directives understood inside the prompt:
//   RETURN:<text>   final text for a non-schema agent
//   FAIL            non-zero exit (a dead agent)
//   FAILONCE        non-zero exit on the first call for this prompt, then succeeds
//   BADJSON         emit invalid JSON (schema agents) to exercise parse-retry
//   SET <p>=<json>  override property <p> on the schema instance (schema agents)
// A schema agent (the engine embeds "JSON Schema:\n{…}") gets a conforming instance built
// from that schema, with SET overrides applied.

type FakeRunResult = { exitCode: number | null; finalText: string };

export function createFakeHarness() {
	const failOnceSeen = new Set<string>();

	function instanceFromSchema(s: any): unknown {
		if (!s || typeof s !== "object") return null;
		if (s.const !== undefined) return s.const;
		if (Array.isArray(s.enum)) return s.enum[0];
		const t = Array.isArray(s.type)
			? s.type.find((x: string) => x !== "null") || s.type[0]
			: s.type;
		switch (t) {
			case "object": {
				const o: Record<string, unknown> = {};
				const keys =
					s.required && s.required.length
						? s.required
						: Object.keys(s.properties || {});
				for (const k of keys)
					o[k] = instanceFromSchema(
						(s.properties || {})[k] || { type: "string" },
					);
				return o;
			}
			case "array":
				return s.items ? [instanceFromSchema(s.items)] : [];
			case "number":
			case "integer":
				return typeof s.minimum === "number" ? s.minimum : 1;
			case "boolean":
				return true;
			case "null":
				return null;
			default:
				return "mock";
		}
	}

	function finalTextFor(prompt: string): FakeRunResult {
		if (/(^|\s)FAIL(\s|$)/.test(prompt)) {
			return { exitCode: 1, finalText: "" };
		}
		// Anchored so it does NOT match inside "SCHEMAFAILONCE".
		if (/(^|\s)FAILONCE/.test(prompt)) {
			if (!failOnceSeen.has(prompt)) {
				failOnceSeen.add(prompt);
				return { exitCode: 1, finalText: "" };
			}
		}

		const schemaMatch = prompt.match(/JSON Schema:\n(.+)/);
		if (schemaMatch) {
			if (/BADJSON/.test(prompt)) {
				return { exitCode: 0, finalText: "{not valid json" };
			}
			// SCHEMAFAILONCE: on the FIRST attempt (no correction yet in the prompt) emit JSON that
			// parses but fails schema validation (empty object → missing required), so the engine's
			// retry path is exercised; on the retry (the correction text is present) it conforms.
			if (
				/SCHEMAFAILONCE/.test(prompt) &&
				!/did not match the output schema/.test(prompt)
			) {
				return { exitCode: 0, finalText: "{}" };
			}
			const schema = JSON.parse(schemaMatch[1]);
			const obj = instanceFromSchema(schema) as Record<string, unknown>;
			for (const m of prompt.matchAll(/SET\s+(\w+)=(\S+)/g)) {
				try {
					obj[m[1]] = JSON.parse(m[2]);
				} catch {
					obj[m[1]] = m[2];
				}
			}
			return { exitCode: 0, finalText: JSON.stringify(obj) };
		}

		const m = prompt.match(/RETURN:([^\n]*)/);
		const text = m
			? m[1].trim()
			: `ok:${prompt.replace(/\s+/g, " ").trim().slice(-40)}`;
		return { exitCode: 0, finalText: text };
	}

	return {
		process: {
			// biome-ignore lint/suspicious/noExplicitAny: structural stand-in for ProcessFacet.
			async run(request: any) {
				const outcome = finalTextFor(String(request.prompt));
				return {
					result: Promise.resolve({
						exitCode: outcome.exitCode,
						finalText: outcome.finalText,
						signal: undefined,
					}),
					kill() {
						/* no live process to signal */
					},
				};
			},
		},
		// biome-ignore lint/suspicious/noExplicitAny: only process.run is consumed by the engine.
	} as any;
}
