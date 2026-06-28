// In-process fake of a @plimeor/harness handle's process.run, for engine tests. It never
// spawns a subprocess: it reads directives out of the prompt the engine built and returns a
// canned text result, so the runtime is exercised without a real host CLI or tokens.
//
// Directives understood inside the prompt:
//   RETURN:<text>   final text for a non-schema agent
//   FAIL            non-zero exit (a dead agent)
//   FAILONCE        non-zero exit on the first call for this prompt, then succeeds
//   BADJSON         emit invalid JSON (schema agents) — unrepairable, exercises null-after-retry
//   TYPEFAIL        emit content with number fields stringified (a TYPE error a repair pass fixes)
//   SET <p>=<json>  override property <p> on the schema instance (schema agents)
// A schema agent (the engine embeds "JSON Schema:\n{…}") gets a conforming instance built
// from that schema, with SET overrides applied. A schema RETRY feeds buildRepairPrompt (marked
// "Reshape ONLY…"); the fake then reshapes the prior reply (extract + coerce existing keys to the
// schema's types, NO fabrication of missing fields) instead of re-running the original task.
import { extractJson } from "../src/engine";

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

	function coerce(v: unknown, t: unknown): unknown {
		if (
			(t === "number" || t === "integer") &&
			typeof v === "string" &&
			v.trim() !== "" &&
			!Number.isNaN(Number(v))
		)
			return Number(v);
		if (t === "boolean" && (v === "true" || v === "false")) return v === "true";
		return v;
	}

	// Model the repair pass: pull the prior reply out of the repair prompt, extract whatever JSON
	// it held, and return its existing keys coerced to the schema's types — WITHOUT inventing any
	// missing required field. So an envelope/type error recovers; an unparseable reply or one that
	// genuinely dropped a required field stays invalid and the engine returns null after attempts.
	function repairReply(prompt: string, schemaJson: string): FakeRunResult {
		const m = prompt.match(/Your previous reply:\n([\s\S]*?)\n\nReturn ONLY/);
		const prior = m ? m[1] : "";
		let data: unknown;
		try {
			data = extractJson(prior);
		} catch {
			return { exitCode: 0, finalText: prior }; // unrepairable → engine re-fails → null
		}
		if (!data || typeof data !== "object" || Array.isArray(data)) {
			return { exitCode: 0, finalText: JSON.stringify(data) };
		}
		const schema = JSON.parse(schemaJson);
		const props = (schema.properties || {}) as Record<string, any>;
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
			const t = Array.isArray(props[k]?.type)
				? props[k].type.find((x: string) => x !== "null")
				: props[k]?.type;
			out[k] = coerce(v, t);
		}
		return { exitCode: 0, finalText: JSON.stringify(out) };
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
			// A schema retry: buildRepairPrompt asks to reshape the prior reply, not redo the task.
			if (/Reshape ONLY the content/.test(prompt)) {
				return repairReply(prompt, schemaMatch[1]);
			}
			if (/BADJSON/.test(prompt)) {
				return { exitCode: 0, finalText: "{not valid json" };
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
			// TYPEFAIL: emit otherwise-correct content with number/integer fields stringified, so the
			// first reply fails validation on a TYPE error that a repair pass can coerce back.
			if (/TYPEFAIL/.test(prompt)) {
				const props = (schema.properties || {}) as Record<string, any>;
				for (const k of Object.keys(obj)) {
					const t = props[k]?.type;
					if ((t === "number" || t === "integer") && typeof obj[k] === "number")
						obj[k] = String(obj[k]);
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
