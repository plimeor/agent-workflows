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

The right move is often **hybrid**: scout inline first (list the files, find the channels,
scope the diff) to discover the work-list, THEN author a workflow to pipeline over it. You
don't need the shape before the *task* — only before the *orchestration step*.

## When NOT to use it

- A single atomic task, a one-file edit, or a quick fact lookup — just do it directly.
- A task where you already know the one file/symbol/value — search directly.
- Trivial mechanical edits. Workflows spawn many host runs and consume real tokens;
  the scale should match the request.

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
3. **Observe, and keep the user informed — you are the progress relay.** A detached run has no GUI
   in this conversation, so the user only sees what you report. Poll `agent_workflows_get_run` with a
   bounded `waitMs` (e.g. a few seconds); after each poll, surface a **one-line human-readable status**
   derived from the returned `agents[]` / `phases` — e.g. `Review ✓2/2 · Verify ◐3 ✗1` — never raw
   JSON. Re-issue the bounded wait until the run is terminal (never poll forever), then report the
   final result. For a long run, remind the user they can follow it live with
   `agent-workflows watch <runId> --follow`.

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

## The script in one screen

```js
export const meta = {
  name: 'review-changes',
  description: 'Review changed files across dimensions, verify each finding',
  phases: [{ title: 'Review' }, { title: 'Verify' }],   // titles match phase() calls
}

const DIMENSIONS = [{ key: 'bugs', prompt: '…' }, { key: 'perf', prompt: '…' }]
const results = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, { label: `review:${d.key}`, phase: 'Review', schema: FINDINGS }),
  review => parallel(review.findings.map(f => () =>
    agent(`Adversarially verify: ${f.title}`, { phase: 'Verify', schema: VERDICT })
      .then(v => ({ ...f, verdict: v })))),
)
return { confirmed: results.flat().filter(Boolean).filter(f => f.verdict?.isReal) }
```

`meta` must be the first statement and a **pure literal** (no variables or calls). The body
is plain JS in an async context: `await` at top level, and a top-level `return` is the
workflow's result.

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

## Limits & determinism (know these)

- Concurrency cap `min(16, cores-2)`; excess `agent()` calls queue. Lifetime cap 1000
  agents/run. A single `parallel()`/`pipeline()` takes at most 4096 items.
- `Date.now()`, `Math.random()`, and argless `new Date()` **throw** inside scripts (they
  break resume). Pass timestamps/seeds via `args`; vary by index for pseudo-randomness.
- Scripts are **plain JS, not TS**. No filesystem/Node APIs inside the script — only the DSL.
- The host harness owns each subagent's sandbox; agent-workflows does not set one. Use
  `isolation:'worktree'` for **parallel** mutators that would otherwise conflict on the shared
  checkout — write capability still depends on the host being configured to allow edits.

## Quality patterns (compose freely)

- **Adversarial verify** — N independent skeptics per finding, each prompted to REFUTE; keep
  only if a majority fail to refute. Stops plausible-but-wrong findings.
- **Perspective-diverse verify** — give each verifier a distinct lens (correctness, security,
  perf, repro) instead of N identical refuters.
- **Judge panel** — generate N independent attempts from different angles, score with
  parallel judges, synthesize from the winner.
- **Loop-until-dry** — keep spawning finders until K consecutive rounds find nothing new;
  dedup against everything *seen* (not just confirmed), or it never converges.
- **Multi-modal sweep** — parallel agents each searching a different way (by-container,
  by-content, by-entity, by-time).
- **Completeness critic** — a final agent that asks "what's missing?"; its answer is the
  next round of work.
- **Budget-scaled fan-out** — read `budget.total` once and derive a static breadth
  (`const n = budget.total ? Math.floor(budget.total / 80_000) : 4`); do not loop on
  `remaining()`, which never shrinks (usage is not metered).

Scale to the request: "find any bugs" → a few finders + single-vote verify; "thoroughly
audit" → a larger finder pool + 3–5 vote adversarial pass + a synthesis stage. Log what you
drop (top-N, no-retry, sampling) — silent truncation reads as "covered everything" when it
didn't.

See `agent-workflows-authoring` for the full DSL reference and more recipes, and
`docs/decisions/001-workflow-dsl-fidelity-contract.md` for the exact mapping to the original
Workflow mechanism.
