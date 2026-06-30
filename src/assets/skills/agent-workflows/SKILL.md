---
name: agent-workflows
description: Deterministic multi-agent workflow orchestration for CLI coding agents. Use when one task is large enough to be worth decomposing across many subagents — to be comprehensive (fan out and cover in parallel), to be confident (independent perspectives + adversarial verification before committing), or to take on scale a single context can't hold (migrations, audits, broad sweeps). Author a JS workflow script and run it with `agent-workflows run`. Triggers include "use a workflow", "fan out agents", "orchestrate with subagents", exhaustive review/audit/research, and large mechanical migrations. Not for a single atomic task or a quick one-file lookup.
---

# Agent Workflows — multi-agent workflows on your CLI coding agent

Agent Workflows is a 1:1 port of Claude Code's `Workflow` mechanism onto CLI coding agents. You
author a **plain-JS orchestration script** and run it with `agent-workflows run <script>`; the
runtime spawns subagents deterministically — fan-out, pipelines, adversarial verification, and
resumable journals. Subagents run on a host harness via `@plimeor/harness` (Codex by default),
so the engine is host-agnostic.

A workflow is where you encode structure that a single agent pass cannot give you:
- **Comprehensive** — decompose the work and cover every piece in parallel.
- **Confident** — generate independent perspectives and adversarially check findings before committing.
- **Scale** — take on migrations, audits, and sweeps too large for one context.

## When to use it

Reach for a workflow when the task is substantial AND benefits from decomposition or
independent verification:
- Exhaustive review/audit ("review everything", "find any bug", "security audit").
- Multi-source research that must be fact-checked.
- A migration or sweep over many files/sites.
- A design decision worth exploring from several angles before choosing.
- Any "be thorough / be comprehensive" request over a wide surface.

## When NOT to use it

- A single atomic task, a one-file edit, or a quick fact lookup — just do it directly.
- A task where you already know the one file/symbol/value — search directly.
- Trivial mechanical edits. Workflows spawn many host runs and consume real tokens;
  the scale should match the request.

## The operating model: you stay in the loop

A workflow is **one well-scoped fan-out, not the whole job.** You stay in the orchestration loop
across turns: scout → run a fan-out → read its result → decide and run the next. You don't need to
know the shape before the *task* — only before the *orchestration step*.

The single-phase shapes you chain:

| Shape | One fan-out that… |
|---|---|
| **Understand** | parallel readers over subsystems → a structured map |
| **Design** | N independent approaches → judged → synthesis |
| **Review** | dimensions → find → adversarially verify each finding |
| **Research** | multi-modal source sweep → deep-read → cited synthesis |
| **Migrate** | discover sites → transform each (worktree) → verify |

For larger work, run several in sequence — **read each result before deciding the next fan-out.**
"understand → design → implement → review" is usually several workflows, one per phase, so you stay
in the loop between them.

**Scouting in the parent session is required before a fan-out, and is not "duplicate evidence."**
Listing the exact files, scoping the diff, finding the systemic risk — that is how you discover the
work-list. What you learn gets **baked into the script** you hand the agents.

### The authoring lifecycle: Scout → Bake → Structure → Launch

For any comprehensive / review / audit / migration fan-out:

1. **Scout** (parent session) — discover three things: the **work-list** (the exact files/symbols
   each agent must read, not vague areas), the **domain invariants / systemic risk** (the one or two
   facts that drive most of the findings), and the **not-a-bug list** (authorized translations and
   known/accepted deferrals).
2. **Bake** — fix those three into script constants — the **context pack**: `WORK_UNITS` (concrete
   file/symbol pairs per agent), `SHARED` (the systemic risk + what to hunt, injected into every
   prompt), `NOT_A_BUG` (what must not be reported). The quality bar: **an agent should never have to
   rediscover which files to read or what the systemic risk is. If it does, the script
   under-specified the work** — that belongs in the context pack, not in each agent's budget.
3. **Structure** — pick the skeleton. For review/audit the default is `pipeline(review → verify) →
   completeness critic → report`. See `agent-workflows-authoring` for copy-ready skeletons.
4. **Launch & relay** — start the run; now the wait discipline below applies.

## How to run one

The primary route writes **no file** — author the script as a string and launch it through the
agent-workflows MCP tools:

1. **Lint** the script text with `agent_workflows_lint` (`{ source }`). It compiles `meta` +
   body without running; fix any error before launching.
2. **Launch** with `agent_workflows_start_run`, passing the script text as the inline `source`
   plus a `name`. It lints again (fail-closed), starts a detached run, and returns a `runId`
   immediately. (`source` is the literal script; no path, no temp file.) **Then tell the user it
   started** — surface the `runId` and that they can run `agent-workflows watch <runId> --follow`
   for a live progress tree in a terminal.
3. **Observe sparsely — relay progress, don't narrate every poll.** A detached run has no GUI here, so
   the user sees only what you report. Poll `agent_workflows_get_run` as a **long-poll**: pass a
   `waitMs` near **180s**; the call blocks and returns the instant the run goes terminal (with the
   final `result`) or when `waitMs` elapses. The default is a **compact summary** (`state`,
   `currentPhase`, per-phase counts, recent narration); use `view:'full'` only to inspect one stalled
   or errored agent. **Report only on a real state change** — a phase advanced, an agent errored, or
   the run finished — as a one-line status from the per-phase counts, e.g. `Review ✓2/2 · Verify ◐3 ✗1`;
   never paste raw JSON. Otherwise stay silent and re-issue the long-poll; report the final `result`
   once terminal.
   A single agent may legitimately run for 30-60 minutes, and a full workflow may take 1-2 hours; the
   `waitMs` is only a read deadline, not a workflow timeout. Live progress is the **user's** job, via
   `agent-workflows watch <runId> --follow` in their terminal — don't call `watch` yourself (it never
   returns the `result`, and `--follow` blocks until the run ends).

Or, from a shell, the equivalent CLI:

```
agent-workflows run <script.mjs | name> [--args JSON] [--budget N] [--resume-from RUNID] \
                                   [--harness ID] [--concurrency N] [--json]
agent-workflows list                 # named workflows from ./workflows and packaged examples
agent-workflows ps                   # recent runs
agent-workflows watch <runId> --follow
agent-workflows resume <runId>       # re-run, replaying the journal (unchanged agents are free)
```

The CLI route writes the script to a file (e.g. `.agent-workflows/tmp/<task>.mjs` or a
`workflows/` entry), then runs it. Either way the runtime prints the final `return` value and a
`runId`. To iterate, edit the script and `agent-workflows resume <runId>` — unchanged `agent()`
calls replay instantly.

## Wait discipline — for a running run only

Once a run is active, treat **that run** as the source of its own investigation. The parent
session's active responsibilities are narrow: long-poll the run, relay concise progress on real
state changes, and handle explicit user requests to pause, stop, resume, restart, or inspect
workflow state.

Do not bypass a running run with duplicate searching, reading, or cross-checking in the parent — that
work is already happening inside the agents, and duplicating it fills the main context with evidence
you'll get back anyway.

This governs a **running** run. It does **not** forbid the parent loop itself: before you launch, and
between chained workflows, **scouting and reading prior results in the parent is expected** — that is
how you build the next fan-out's context pack. If you discover mid-run that the script is
under-specified, don't quietly start investigating in parallel; finish or stop the run, bake what's
missing into the script, and relaunch.

Do not stop a run or an agent just because it has been running a long time, because a bounded poll
returned before terminal completion, or because the host appears quiet. Long-running agents are normal.
Before issuing `stop-run` or `stop-agent`, ask the user for confirmation and wait for an explicit yes.

## The script in one screen

A review fan-out with its scouting **baked in** — the agents are handed the files, the systemic
risk, and the not-a-bug list; they never rediscover them:

```js
export const meta = {
  name: 'parity-review',
  description: 'Parity-review a migration per area, adversarially verify, then report',
  phases: [{ title: 'Review' }, { title: 'Verify' }, { title: 'Report' }],   // titles match phase()
}

// ── Context pack: baked from scouting, not rediscovered by agents ──
const SHARED = `Systemic risk: v4 call sites check {code} and never throw; the target THROWS on
error — so EVERY call site must be remapped to try/catch. Hunt: dropped else-branch (silent error),
swallowed catch, flipped control flow, lost showErrorMsg intent.`
const NOT_A_BUG = `Authorized translations (not findings): <list>. Known deferrals (do not report
as bugs): <list>.`
const UNITS = [                                   // concrete file pairs, one per agent — not "areas"
  { key: 'create-order', focus: 'order placement + 30s quote polling + 3DS',
    sources: ['/v4/.../component.tsx'], targets: ['/web/.../component.tsx', '/web/.../service.ts'] },
  // … one entry per area, each with the EXACT files to diff
]
const reviewPrompt = u => [SHARED, `Area: ${u.focus}`,
  `v4 source (read in full): ${u.sources.join(', ')}`,
  `target (read in full): ${u.targets.join(', ')}`,
  'Diff behavior line by line; report only real regressions, with file:symbol evidence.',
  NOT_A_BUG].join('\n')

const results = await pipeline(
  UNITS,
  u => agent(reviewPrompt(u), { label: `review:${u.key}`, phase: 'Review', schema: FINDINGS }),
  (review, u) => parallel((review?.findings ?? []).map(f => () =>
    agent(`Adversarially REFUTE this finding (default to refuted if unsure):\n${JSON.stringify(f)}`,
          { label: `verify:${u.key}`, phase: 'Verify', schema: VERDICT })
      .then(v => ({ ...f, verdict: v })))),
)
const confirmed = results.flat().filter(Boolean).filter(f => f.verdict && !f.verdict.refuted)

// Terminal stage returns the FINISHED report in the user's language — not JSON for the parent to render.
return await agent(`Write the final review report (user's language) from these confirmed findings.
Cite file:symbol for every claim; order money/correctness issues first:\n${JSON.stringify(confirmed)}`,
  { label: 'report', phase: 'Report' })
```

`meta` must be the first statement and a **pure literal** (no variables or calls). The body is
plain JS in an async context: `await` at top level, and a top-level `return` is the workflow's result.

## The DSL (injected globals)

- `agent(prompt, opts?)` → spawn one harness subagent (a single host text run). Without
  `schema` returns its final **text**; with `schema` (a JSON Schema) returns the **validated
  object**; returns `null` if it is skipped or dies after retries. `opts`: `{ label?, phase?,
  schema?, isolation?:'worktree', profile? }`. (Model, effort, sandbox, and MCP scope are
  host-owned by the harness — not workflow opts.)
- `pipeline(items, ...stages)` → each item flows through all stages **independently, no
  barrier**. Stage cb gets `(prev, originalItem, index)`. A throwing stage drops that item
  to `null`. **This is the default for multi-stage work.**
- `parallel(thunks)` → run concurrently, **barrier** (awaits all). A throwing thunk → `null`
  (never rejects); `.filter(Boolean)` the result.
- `phase(title)` / `log(msg)` → progress grouping + narrator lines.
- `workflow(nameOrRef, args?)` → run another workflow inline (one level deep only).
- `args` → the `--args` value, verbatim.
- `budget` → `{ total, spent(), remaining() }`. `--budget` is an advisory cap a script can
  read (token usage is not metered through the harness, so `spent()` stays `0`); use
  `budget.total` to size a static fan-out, never a loop on `remaining()`.

**Default to `pipeline()`.** Only use a barrier (`parallel` between stages) when stage N
genuinely needs ALL of stage N-1 at once (dedup/merge across the full set, early-exit on
zero, "compare against the other findings"). "I need to flatten/filter first" is NOT a
barrier — do it inside a pipeline stage.

## Structure: default skeletons, composed from patterns

Start each fan-out from its task-class skeleton, then adjust:

- **Review / audit** → `pipeline(WORK_UNITS, review, adversarial-verify) → completeness critic →
  report`. Verify **every** finding; spend more verification on the high-severity ones. The
  terminal stage returns the **finished report**, not JSON.
- **Research** → multi-modal source sweep → deep-read each source → cited synthesis, with a
  refute pass on load-bearing claims.
- **Migration** → discover sites → transform each under `isolation:'worktree'` → verify each →
  report what was skipped.

The patterns these skeletons compose from:
- **Adversarial verify** — N independent skeptics per finding, each prompted to REFUTE, defaulting
  to refuted when unsure; keep only if a majority fail to refute. Spend extra votes on high-severity.
- **Perspective-diverse verify** — give each verifier a distinct lens (correctness, security, repro)
  instead of N identical refuters.
- **Completeness critic** — a final agent that asks "what's missing — area not covered, claim
  unverified, deferral that's actually a live path?"; its answer is the next round of work.
- **Loop-until-dry** — keep spawning finders until K consecutive rounds find nothing new; dedup
  against everything *seen* (not just confirmed), or it never converges.
- **Multi-modal sweep** — parallel agents each searching a different way (by-container, by-content,
  by-entity, by-time).
- **Judge panel** — N independent attempts from different angles, scored by parallel judges,
  synthesized from the winner while grafting the best ideas from the runners-up.

These are **parts, not a ceiling.** Compose novel harnesses when the task calls for it — tournament
brackets, self-repair loops, staged escalation, whatever fits.

Scale to the request: "find any bugs" → a few finders + single-vote verify; "thoroughly audit" → a
larger finder pool + a 3–5 vote adversarial pass + a completeness critic + a report stage. **Log what
you drop** (top-N, no-retry, sampling) — silent truncation reads as "covered everything" when it didn't.

## Limits & determinism (know these)

- Concurrency cap `min(16, cores-2)`; excess `agent()` calls queue. Lifetime cap 1000
  agents/run. A single `parallel()`/`pipeline()` takes at most 4096 items.
- `Date.now()`, `Math.random()`, and argless `new Date()` **throw** inside scripts (they
  break resume). Pass timestamps/seeds via `args`; vary by index for pseudo-randomness.
- Scripts are **plain JS, not TS**. No filesystem/Node APIs inside the script — only the DSL.
- `budget` is **advisory, not metered**: `spent()` stays `0` and `remaining()` equals `total`,
  forever. Read `budget.total` once to size a static fan-out. **Do not** port a native
  `while (budget.remaining() > N)` loop — here it never shrinks, so it would spin straight to the
  1000-agent lifetime cap.
- The host harness owns each subagent's sandbox; agent-workflows does not set one. Use
  `isolation:'worktree'` for **parallel** mutators that would otherwise conflict on the shared
  checkout — write capability still depends on the host being configured to allow edits.

See `agent-workflows-authoring` for the full DSL reference and copy-ready skeletons, and
`DECISIONS.xml` decision 001 for the exact mapping to the original Workflow mechanism.
