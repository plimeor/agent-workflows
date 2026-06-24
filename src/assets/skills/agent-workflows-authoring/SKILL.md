---
name: agent-workflows-authoring
description: Reference for authoring Agent Workflows workflow scripts — the full DSL (agent/parallel/pipeline/phase/log/workflow/args/budget), the meta block, structured output schemas, resume, worktree isolation, and copy-ready quality-pattern recipes (adversarial verify, judge panel, loop-until-dry, multi-modal sweep, completeness critic). Use when writing or debugging a `agent-workflows run` workflow script. Read alongside the `agent-workflows` skill, which covers when to orchestrate.
---

# Authoring Agent Workflows workflows

A workflow is a `.mjs` script: `export const meta = {…}` first, then a plain-JS async body.
Run it with `agent-workflows run <script>`. This skill is the API reference and recipe book.

## meta (required, pure literal, first statement)

```js
export const meta = {
  name: 'find-flaky-tests',            // required
  description: 'Find flaky tests and propose fixes',   // required, one line
  whenToUse: 'after CI shows intermittent failures',   // optional, shown in `agent-workflows list`
  phases: [                            // optional; titles match phase() calls
    { title: 'Scan',  detail: 'grep CI logs for retries' },
    { title: 'Fix',   detail: 'one agent per flaky test' },
  ],
}
```

`meta` MUST be a literal — no variables, calls, spreads, or template interpolation. It is
parsed before the body runs so phase groups exist up front.

## The body

Plain JS, async context. `await` directly. A top-level `return X` is the workflow's result
(printed by `agent-workflows run`, and the value `workflow()` returns to a parent). No `import`,
no `require`, no `fs`/`process` — only the injected DSL. Standard built-ins are available
**except** `Date.now()`, `Math.random()`, and argless `new Date()` (they throw — pass
timestamps via `args`, vary prompts by index for randomness).

## DSL reference

### `agent(prompt, opts?) → Promise<any>`
One harness subagent (a single host text run). The subagent is told its final message IS the
return value, so it returns raw data, not prose.
- No `schema` → returns the final **text** (string). A transient host-agent death is still
  retried once (up to 2 attempts) even without a schema.
- `schema` (JSON Schema) → the engine embeds the schema in the prompt, then parses and validates
  the reply host-side, retrying once (the retry prompt includes the prior failure), then returns
  the **object** (or `null` on persistent failure).
- Returns `null` if the agent dies after retries or the run is aborted.

`opts`:
| field | meaning |
|---|---|
| `label` | display name in the progress tree (default: prompt excerpt) |
| `phase` | progress group (default: current `phase()`) |
| `schema` | JSON Schema → structured, validated output |
| `isolation` | `'worktree'` → run this agent in its own detached git worktree checkout (for parallel mutators that edit files) |
| `profile` | builtin profile: `reviewer`·`mutator`·`verifier`·`synthesizer`; applies a prompt preamble |

The host harness owns model selection, reasoning effort, sandboxing, and MCP tool scope (see
decision 003) — they are **not** workflow opts. A subagent's filesystem access is governed by the
host's own sandbox configuration, so `isolation:'worktree'` gives a parallel mutator a private
checkout but write capability still depends on the host being configured to allow edits.

### `pipeline(items, ...stages) → Promise<any[]>`  ← default for multi-stage work
Each item runs through all stages **independently — no barrier**. Item A can be in stage 3
while B is in stage 1. Wall-clock = slowest single-item chain. Each stage cb receives
`(prevResult, originalItem, index)`. A throwing stage drops that item to `null` and skips its
rest.

### `parallel(thunks) → Promise<any[]>`  ← only when you need ALL results together
Runs thunks concurrently and **awaits all** (barrier). A throwing thunk (or a dead agent)
resolves to `null` — the call never rejects, so `.filter(Boolean)` before using results.

A barrier is correct ONLY when stage N needs cross-item context from all of N-1: dedup/merge
across the full set, early-exit on zero, or "compare against the other findings". It is NOT
justified by "I need to flatten/filter first" (do that inside a pipeline stage) or "it's
cleaner". Smell test: `const a = await parallel(...); const b = transform(a); const c = await
parallel(b…)` — if `transform` has no cross-item dependency, rewrite as one pipeline.

### `phase(title)` / `log(message)`
`phase` opens a progress group; later agents group under it. `log` writes a narrator line.

### `workflow(nameOrRef, args?) → Promise<any>`
Run another workflow inline; returns its result. Pass a name (resolved from local `workflows/`,
packaged workflows, or the parent workflow's lookup roots) or
`{ scriptPath }`. **One level only** — nested `workflow()` throws. Shares the run's
concurrency cap, agent counter, abort signal, and token budget.

### `args` / `budget`
`args` is the `--args`/`--args-file` value verbatim (`undefined` if unset). `budget` is
`{ total, spent(), remaining() }`. The host harness reports no token usage (decision 003), so
`spent()` stays `0` and `remaining()` equals `total` — `--budget` is an **advisory cap a script
can read** (e.g. to scale fan-out breadth by `budget.total`), not an enforced ceiling. Do **not**
write a loop that relies on `remaining()` shrinking; it never does. The runaway backstop is the
1000-agent/run lifetime cap.

## Limits
Concurrency `min(16, cores-2)`; 1000 agents/run lifetime; ≤4096 items per
`parallel()`/`pipeline()`. Exceeding the item cap is an explicit error; log anything you
intentionally drop (top-N, sampling) so coverage isn't silently overstated.

## Resume
`agent-workflows run` journals every `agent()` result keyed by `sha(prompt + result-affecting
opts)`. `agent-workflows resume <runId>` (or `run --resume-from <runId>`) replays identical calls
instantly and runs the first changed/new call onward live. Same script + same args ⇒ full
cache hit. Because time/random are blocked, the journal is stable.

## Recipes (copy-ready)

**Canonical multi-stage — pipeline, verify as soon as each review lands:**
```js
const DIMENSIONS = [{ key:'bugs', prompt:'…' }, { key:'perf', prompt:'…' }]
const results = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, { label:`review:${d.key}`, phase:'Review', schema: FINDINGS }),
  review => parallel(review.findings.map(f => () =>
    agent(`Adversarially verify: ${f.title}`, { phase:'Verify', schema: VERDICT })
      .then(v => ({ ...f, verdict: v })))),
)
return { confirmed: results.flat().filter(Boolean).filter(f => f.verdict?.isReal) }
```

**Barrier when you must dedup across ALL findings before expensive verify:**
```js
const all = await parallel(DIMENSIONS.map(d => () => agent(d.prompt, { schema: FINDINGS })))
const deduped = dedupeByFileAndLine(all.filter(Boolean).flatMap(r => r.findings)) // needs all at once
const verified = await parallel(deduped.map(f => () => agent(verifyPrompt(f), { schema: VERDICT })))
```

**Loop-until-count:**
```js
const bugs = []
while (bugs.length < 10) {
  const r = await agent('Find bugs in this codebase.', { schema: BUGS })
  bugs.push(...r.bugs); log(`${bugs.length}/10 found`)
}
```

**Scale fan-out to `--budget` (read `budget.total`; usage is not metered, so don't loop on `remaining()`):**
```js
// budget.total is the advisory --budget value (or null). Derive a static breadth from it up
// front, then fan out that many — do NOT loop on remaining(), which never shrinks.
const breadth = budget.total ? Math.min(8, Math.max(2, Math.floor(budget.total / 80_000))) : 4
const found = (await parallel(
  Array.from({ length: breadth }, (_, i) => () =>
    agent(`Find bugs in this codebase (angle ${i + 1}).`, { schema: BUGS })),
)).filter(Boolean).flatMap(r => r.bugs)
```

**Loop-until-dry + diverse-lens panel (dedup vs everything *seen*, not just confirmed):**
```js
const seen = new Set(), confirmed = []
let dry = 0
while (dry < 2) {
  const found = (await parallel(FINDERS.map(f => () =>
    agent(f.prompt, { phase:'Find', schema: BUGS })))).filter(Boolean).flatMap(r => r.bugs)
  const fresh = found.filter(b => !seen.has(key(b)))
  if (!fresh.length) { dry++; continue }
  dry = 0; fresh.forEach(b => seen.add(key(b)))
  const judged = await parallel(fresh.map(b => () =>
    parallel(['correctness','security','repro'].map(lens => () =>
      agent(`Judge "${b.desc}" via the ${lens} lens — real?`, { phase:'Verify', schema: VERDICT })))
      .then(vs => ({ b, real: vs.filter(Boolean).filter(v => v.real).length >= 2 }))))
  confirmed.push(...judged.filter(v => v.real).map(v => v.b))
}
return confirmed
```

**Worktree isolation for parallel mutators:**
```js
await parallel(sites.map(site => () =>
  agent(`Apply the codemod to ${site.file} and run its test.`,
        { isolation:'worktree', label:`migrate:${site.file}` })))
```

## Debugging
- `agent-workflows watch <runId> --follow` for the live tree; runs persist under
  `.agent-workflows/runs/<runId>/` (`status.json`, `result.json`, `journal.json`, `script.mjs`).
- `agent-workflows doctor` checks the configured harness host is reachable (`--harness <id>` to
  diagnose a specific one).
- A schema agent returning `null` means non-JSON/invalid output twice — tighten the prompt or
  loosen the schema; inspect with a non-schema agent first.
