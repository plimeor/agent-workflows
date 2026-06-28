---
name: agent-workflows-authoring
description: Reference for authoring Agent Workflows workflow scripts — the full DSL (agent/parallel/pipeline/phase/log/workflow/args/budget), the meta block, the context pack (work-units/shared-risk/not-a-bug), structured output schemas, resume, worktree isolation, and copy-ready skeletons (deep-review, adversarial verify, judge panel, loop-until-dry, multi-modal sweep, completeness critic). Use when writing or debugging a `agent-workflows run` workflow script. Read alongside the `agent-workflows` skill, which covers when to orchestrate and the Scout→Bake→Structure→Launch lifecycle.
---

# Authoring Agent Workflows workflows

A workflow is a `.mjs` script: `export const meta = {…}` first, then a plain-JS async body.
Run it with `agent-workflows run <script>`. This skill is the API reference and recipe book.
Read it after the `agent-workflows` skill, which covers *when* to orchestrate and the
**Scout → Bake → Structure → Launch** lifecycle this skill gives you the building blocks for.

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

## The context pack (bake your scouting in)

Before a review/audit/migration fan-out, scout in the parent session and **bake** what you find into
three script constants. The quality bar: **an agent should never have to rediscover which files to
read or what the systemic risk is — if it does, the script under-specified the work.**

```js
const V4 = '/abs/source', WEB = '/abs/target'

// ① WORK_UNITS — the exact files each agent diffs, NOT vague areas. One entry ≈ one review agent.
const WORK_UNITS = [
  { key: 'create-order', focus: 'order placement + quote polling + 3DS',
    sources: [V4 + '/.../component.tsx'], targets: [WEB + '/.../component.tsx', WEB + '/.../service.ts'] },
  // … one entry per concrete area
]

// ② SHARED — the systemic risk / invariant that drives most findings, injected into EVERY prompt.
const SHARED = `Systemic risk: <the one or two facts>. Hunt for: <concrete failure modes>.`

// ③ NOT_A_BUG — authorized translations + known deferrals, so agents don't report non-issues.
const NOT_A_BUG = `Authorized translations (not findings): <list>. Known/accepted deferrals
(do not report as bugs): <list>.`

const reviewPrompt = u => [SHARED, `Area: ${u.focus}`,
  `source (read in full): ${u.sources.join(', ')}`, `target (read in full): ${u.targets.join(', ')}`,
  'Diff behavior line by line; report only real regressions with file:symbol evidence.',
  NOT_A_BUG].join('\n')
```

`WORK_UNITS` raises recall (agents go straight to the right files) and lets you size the fan-out;
`SHARED` raises recall on the highest-value bug class; `NOT_A_BUG` crushes false positives. Skipping
any of the three is the usual reason a one-shot review reads as shallow.

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
across the full set, early-exit on zero, "compare against the other findings", or a completeness
critic that must see every confirmed finding. It is NOT justified by "I need to flatten/filter
first" (do that inside a pipeline stage) or "it's cleaner". Smell test: `const a = await
parallel(...); const b = transform(a); const c = await parallel(b…)` — if `transform` has no
cross-item dependency, rewrite as one pipeline.

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
write a loop that relies on `remaining()` shrinking; it never does, so a ported native
`while (budget.remaining() > N)` loop would spin straight to the 1000-agent lifetime cap. Size a
static fan-out from `budget.total` instead.

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

These are **parts, not a ceiling** — compose novel harnesses (tournament brackets, self-repair
loops, staged escalation, whatever fits) when the task calls for it.

### The five single-phase shapes — chain them across turns

Each shape is one well-scoped fan-out. For larger work, run one, **read its result, bake what you
learned into the next** (see the lifecycle in the `agent-workflows` skill):

| Shape | The fan-out |
|---|---|
| **Understand** | `parallel` readers over subsystems → return a structured map |
| **Design** | `parallel` N approaches → judge panel → synthesize the winner |
| **Review** | `pipeline(WORK_UNITS, review, verify)` → completeness critic → report (below) |
| **Research** | multi-modal sweep → `pipeline(sources, read, refute-claims)` → cited synthesis |
| **Migrate** | discover sites → `parallel` transform under `isolation:'worktree'` → verify each |

### Deep-review skeleton (default for review/audit)
Bake the context pack (above), verify each finding adversarially — extra refuter on high-severity —
then return a finished report, not JSON:

```js
const verdictOf = (f, role) => agent(
  `${role} this finding (cite file:symbol; default to refuted if unsure):\n${JSON.stringify(f)}`,
  { schema: VERDICT, phase: 'Verify', label: `verify:${(f.title || '').slice(0, 24)}` }).then(v => v || null)

function verifyFinding(f) {                       // high-stakes findings get a 2nd, adversarial vote
  const high = f.severity === 'critical' || f.severity === 'high'
  const votes = high
    ? Promise.all([verdictOf(f, 'Independently re-verify'), verdictOf(f, 'Adversarially REFUTE')])
    : verdictOf(f, 'Independently re-verify').then(v => [v])
  return votes.then(vs => {
    const v = vs.filter(Boolean)
    const refuted = v.filter(x => x.refuted).length > v.length / 2
    return { ...f, verdicts: v, confirmed: v.length > 0 && !refuted }
  }).catch(() => ({ ...f, verdicts: [], confirmed: false }))
}

const reviewed = await pipeline(                  // each area verifies as soon as its review lands
  WORK_UNITS,
  u => agent(reviewPrompt(u), { schema: FINDINGS, phase: 'Review', label: `review:${u.key}` }),
  review => parallel(((review?.findings) ?? []).map(f => () => verifyFinding(f))),
)
const confirmed = reviewed.flat().filter(Boolean).filter(f => f.confirmed)

const gaps = await agent(                         // barrier: the critic needs ALL confirmed findings
  `You are the completeness critic. Given these confirmed findings, name what was NOT covered:
areas no agent audited, claims left unverified, deferrals that may be live paths.\n${JSON.stringify(confirmed)}`,
  { schema: GAPS, phase: 'Audit', label: 'completeness-critic' })

return await agent(                               // terminal stage returns the FINISHED report
  `Write the final review report in the user's language. Cite file:symbol for every claim, order
money/correctness issues first, and fold in the coverage gaps.
Confirmed: ${JSON.stringify(confirmed)}\nGaps: ${JSON.stringify(gaps)}`,
  { phase: 'Report', label: 'report' })
```

### Barrier when you must dedup across ALL findings before expensive verify
```js
const all = await parallel(WORK_UNITS.map(u => () => agent(reviewPrompt(u), { schema: FINDINGS })))
const deduped = dedupeByFileAndLine(all.filter(Boolean).flatMap(r => r.findings)) // needs all at once
const verified = await parallel(deduped.map(f => () => agent(verifyPrompt(f), { schema: VERDICT })))
```

### Loop-until-count
```js
const bugs = []
while (bugs.length < 10) {
  const r = await agent('Find bugs in this codebase.', { schema: BUGS })
  bugs.push(...r.bugs); log(`${bugs.length}/10 found`)
}
```

### Scale fan-out to `--budget` (read `budget.total`; usage is not metered, so don't loop on `remaining()`)
```js
// budget.total is the advisory --budget value (or null). Derive a static breadth from it up
// front, then fan out that many — do NOT loop on remaining(), which never shrinks.
const breadth = budget.total ? Math.min(8, Math.max(2, Math.floor(budget.total / 80_000))) : 4
const found = (await parallel(
  Array.from({ length: breadth }, (_, i) => () =>
    agent(`Find bugs in this codebase (angle ${i + 1}).`, { schema: BUGS })),
)).filter(Boolean).flatMap(r => r.bugs)
```

### Loop-until-dry + diverse-lens panel (dedup vs everything *seen*, not just confirmed)
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

### Worktree isolation for parallel mutators
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
