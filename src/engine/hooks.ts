// The workflow DSL: agent / parallel / pipeline / phase / log / workflow, plus args and
// budget. These are injected as globals into the workflow script. Semantics are a 1:1
// reproduction of Claude Code's Workflow tool — see docs/decisions/001-workflow-dsl-fidelity-contract.md.
import { buildAgentPrompt, extractJson, runHarnessAgent } from "./agent-run";
import { agentKey } from "./journal";
import { resolveProfile } from "./profiles";
import { validate } from "./schema";
import { createWorktree } from "./worktree";

export const MAX_AGENTS = 1000; // lifetime runaway backstop
export const MAX_ITEMS = 4096; // per parallel()/pipeline() call

function excerpt(s, n = 56) {
	const t = String(s).replace(/\s+/g, " ").trim();
	return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

// Build the DSL bound to a run context. `ctx` is shared (counters, budget, sem, signal …)
// across the root workflow and any inline child workflows.
export function buildDsl(ctx) {
	async function agent(prompt, opts = {}) {
		if (typeof prompt !== "string" || !prompt.trim()) {
			throw new Error(
				"agent(prompt, opts?): prompt must be a non-empty string",
			);
		}

		// Resolve the profile preamble ONCE. Its fingerprint is folded into the cache key so a
		// changed builtin-profile set busts resume (a real input change). Model/effort/sandbox
		// no longer exist here — the harness owns host execution (decision 003).
		const resolved = resolveProfile(opts, ctx);

		const seq = ++ctx.counters.calls; // display sequence over every call (cached or live)
		const id = `a${seq}`;
		const key = agentKey(prompt, {
			...opts,
			profile: resolved.name,
			profileFingerprint: resolved.profileFingerprint,
			profileSetVersion: resolved.profileSetVersion,
		});
		const label = opts.label || excerpt(prompt);
		const phase = opts.phase || ctx.progress.currentPhase();

		// Resume replay first: an identical call returns its cached result instantly and for
		// free — no host spawn, so it is exempt from the budget ceiling AND the agent cap.
		// (journal.next advances the per-key occurrence counter for every call, in order.)
		const cached = ctx.journal.next(key);
		if (cached.hit) {
			ctx.progress.agentCached(id, seq, label, phase);
			await ctx.journal.record(key, cached.result);
			return cached.result;
		}

		// Lifetime agent cap counts only LIVE spawns (cached replays above are free).
		if (++ctx.counters.launched > MAX_AGENTS) {
			throw new Error(`agent cap reached (${MAX_AGENTS} agents/run)`);
		}

		ctx.progress.agentQueued(id, seq, label, phase);

		let generation = 0;
		while (true) {
			const admission = await ctx.control?.beforeAdmission(id);
			if (admission && !admission.ok) {
				ctx.progress.agentEnd(id, "stopped", admission.reason);
				return null;
			}

			const outcome = await ctx.sem.run(async () => {
				const gate = await ctx.control?.checkAdmission(id);
				if (gate && !gate.ok) {
					return {
						kind: gate.paused ? "requeue" : "stopped",
						reason: gate.reason,
					};
				}

				// Abort consistently yields null (a skipped agent), matching the fan-out contract —
				// both a bare `await agent()` and one inside parallel/pipeline behave identically.
				if (ctx.signal?.aborted) return { kind: "stopped", reason: "stop-run" };

				// Hard budget ceiling. DORMANT under the harness: the host reports no token usage
				// (decision 003), so nothing calls budget.add(), spent() stays 0, and remaining()
				// never reaches 0 — this guard is a no-op today. It is kept (not deleted) so the
				// ceiling re-activates automatically if @plimeor/harness ever exposes run usage and
				// budget.add() is wired back in. We throw (not null) and do NOT journal it, so a
				// resume with more budget would re-run the refused agent.
				if (ctx.budget.total != null && ctx.budget.remaining() <= 0) {
					throw new Error(
						`budget exhausted (${ctx.budget.total} tokens): agent() refused`,
					);
				}

				ctx.progress.agentStart(id, seq, label, phase);

				let worktree = null;
				let cwd = ctx.cwd;
				try {
					if (opts.isolation === "worktree") {
						worktree = await createWorktree(ctx.cwd, label);
						cwd = worktree.dir;
					}

					// Up to 2 attempts for BOTH paths: a transient host-agent death is retried
					// whether or not a schema is set; schema agents additionally retry on
					// parse/validate misses, with the schema embedded in the prompt.
					const attempts = 2;
					let result = null;
					let correction = ""; // on a schema retry, tell the fresh agent why the last try failed

					const agentControl = ctx.control?.registerAgent(id);
					try {
						for (let attempt = 0; attempt < attempts; attempt++) {
							const res = await runHarnessAgent(ctx.harness, {
								prompt: buildAgentPrompt(
									prompt,
									resolved.preamble,
									opts.schema || null,
									correction,
								),
								cwd,
								signal: agentControl?.signal || ctx.signal,
							});

							if (agentControl?.shouldRestart()) {
								return { kind: "restart" };
							}

							if (agentControl?.wasStopped()) {
								return { kind: "stopped", reason: "stop-agent" };
							}

							if (!res.ok) {
								if (attempt === attempts - 1) {
									ctx.progress.agentEnd(id, "error", res.error);
									result = null;
								}
								continue; // retry
							}

							if (opts.schema) {
								let data: unknown;
								try {
									data = extractJson(res.text);
								} catch {
									if (attempt === attempts - 1) {
										ctx.progress.agentEnd(id, "error", "non-JSON output");
										result = null;
									}
									correction = `Your previous reply was NOT valid JSON. Return ONLY a single JSON value matching the output schema, with no prose. Previous reply began: ${res.text.slice(0, 200)}`;
									continue;
								}
								const v = validate(data, opts.schema);
								if (!v.ok) {
									if (attempt === attempts - 1) {
										ctx.progress.agentEnd(
											id,
											"error",
											`schema: ${v.errors[0] || "invalid"}`,
										);
										result = null;
									}
									correction = `Your previous reply did not match the output schema: ${v.errors.slice(0, 3).join("; ")}. Fix exactly these problems and return ONLY the corrected JSON.`;
									continue;
								}
								ctx.progress.agentEnd(id, "done");
								result = data;
								break;
							}

							ctx.progress.agentEnd(id, "done");
							result = res.text;
							break;
						}
					} finally {
						agentControl?.unregister();
					}
					return { kind: "done", result };
				} finally {
					if (worktree) {
						const r = await worktree.cleanup().catch(() => null);
						if (r?.kept)
							ctx.progress.narrate(`worktree kept (has changes): ${r.dir}`);
						else if (r && r.removed === false)
							ctx.progress.narrate(
								`worktree could not be removed (leaked on disk): ${r.dir}`,
							);
					}
				}
			});

			if (outcome.kind === "requeue") {
				ctx.progress.agentEnd(id, "paused", outcome.reason || "paused");
				continue;
			}
			if (outcome.kind === "stopped") {
				ctx.progress.agentEnd(id, "stopped", outcome.reason);
				return null;
			}
			if (outcome.kind === "restart") {
				if (++generation > 3) {
					ctx.progress.agentEnd(id, "error", "restart-agent limit reached");
					return null;
				}
				ctx.progress.agentEnd(id, "queued", "restart requested");
				continue;
			}
			if (!ctx.signal?.aborted) await ctx.journal.record(key, outcome.result);
			return outcome.result;
		}
	}

	function guardCount(items, who) {
		if (!Array.isArray(items))
			throw new Error(`${who}(items, …): items must be an array`);
		if (items.length > MAX_ITEMS) {
			throw new Error(
				`${who}() accepts at most ${MAX_ITEMS} items (got ${items.length})`,
			);
		}
	}

	// BARRIER: awaits all thunks. A throwing thunk resolves to null (never rejects).
	async function parallel(thunks) {
		guardCount(thunks, "parallel");
		// parallel() takes THUNKS (unlike pipeline(), which takes values). Passing the natural-but-
		// wrong `parallel(items.map(x => agent(...)))` (an array of Promises) would make every `t()`
		// throw "t is not a function" and silently resolve to null. Fail loudly with guidance instead.
		if (thunks.some((t) => typeof t !== "function")) {
			throw new Error(
				"parallel(thunks): each item must be a zero-arg function, e.g. () => agent(...) — not agent(...)",
			);
		}
		return Promise.all(
			thunks.map((t) =>
				Promise.resolve()
					.then(() => t())
					.catch(() => null),
			),
		);
	}

	// NO BARRIER: each item flows through all stages independently. A throwing stage drops
	// that item to null and skips its remaining stages.
	async function pipeline(items, ...stages) {
		guardCount(items, "pipeline");
		return Promise.all(
			items.map(async (item, index) => {
				let current = item;
				for (const stage of stages) {
					try {
						current = await stage(current, item, index);
					} catch {
						return null;
					}
				}
				return current;
			}),
		);
	}

	function phase(title) {
		ctx.progress.setPhase(String(title));
	}

	function log(message) {
		ctx.progress.narrate(
			typeof message === "string" ? message : JSON.stringify(message),
		);
	}

	async function workflow(ref, childArgs) {
		if (ctx.depth >= 1) throw new Error("workflow() nesting is one level only");
		return ctx.runChild(ref, childArgs);
	}

	const budget = {
		remaining() {
			return ctx.budget.remaining();
		},
		spent() {
			return ctx.budget.spent();
		},
		get total() {
			return ctx.budget.total;
		},
	};

	return {
		agent,
		parallel,
		pipeline,
		phase,
		log,
		workflow,
		args: ctx.args,
		budget,
	};
}
