---
date: 2026-06-24
status: active
---

# Workflow DSL Fidelity Contract

来源需求：docs/requirements/2026-06-24-agent-workflows-port-requirement.md。

## Decision

Agent Workflows preserves Claude Code `Workflow` script-facing semantics on top of the Codex CLI:
the plain-JS script shape, injected DSL globals, scheduling behavior, deterministic resume,
subagent return contract, progress surface, and worktree isolation are the stable authority.
Codex-specific host fields such as sandbox, builtin `profile`, model effort mapping, and MCP policy
belong to the adaptation layer and must not change the meaning of `agent`, `parallel`,
`pipeline`, `phase`, `log`, `workflow`, `args`, or `budget`.

## Rejected Alternatives

- Treat Codex as a native clone of the Claude Code harness. That would hide substrate differences
  that affect process isolation, sandboxing, schema retries, and progress integration.
- Expose substrate differences as changes to the workflow DSL. That would make scripts harder to
  port and would weaken the 1:1 script-author contract.
- Keep fidelity facts in implementation plans. Stable behavior rows are durable authority and
  belong in this decision record; execution work cites this decision rather than restating it.

## Non-Goals

- Byte-for-byte parity with Claude Code's internal harness implementation.
- Native Claude Code UI behavior when Codex has only CLI, MCP, and durable run-file surfaces.
- Removing Codex-required safety and execution controls such as sandbox policy.

## Fidelity Map

This document is the contract for the port. The left column is the **source** behavior
of Claude Code's built-in `Workflow` tool (the mechanism being replicated). The right
column is how Agent Workflows reproduces it on top of the **Codex CLI**. Every row is a
behavior that must hold; the verification pass checks them one by one.

The guiding rule: **workflow orchestration semantics are identical**. Agent Workflows preserves
the `agent / parallel / pipeline / phase / log / workflow / args / budget` behavior on top
of Codex, while Codex-specific host fields such as sandbox, builtin `profile`, and MCP policy
belong to the adaptation layer.

---

## 1. The script shape

| Source (`Workflow`) | Agent Workflows (Codex) |
|---|---|
| Script begins with `export const meta = {...}` (pure literal). Required `name`, `description`; optional `whenToUse`, `phases:[{title,detail?,model?}]`, `model`. | Identical. `meta` is extracted from the script text as a pure literal before the body runs (so phase groups exist up front). Non-literal `meta` is a hard error. |
| Script body is plain JS in an async context; `await` at top level; top-level `return X` is the workflow's return value. | Identical. Body runs inside an async function in a `vm` sandbox; its `return` resolves the run. |
| Scripts are **plain JS, not TS** — type annotations, interfaces, generics fail to parse. | Identical — the sandbox is plain JS. |
| Standard JS built-ins available **except** `Date.now()`, `Math.random()`, argless `new Date()` — these **throw** (they would break resume). | Identical. The sandbox shadows `Math.random`, `Date.now`, and argless `new Date()` to throw with a message pointing at `args` for timestamps. |
| No filesystem / Node API access inside scripts. | Identical. The sandbox global has no `require`, `import`, `process`, `fs`, etc. Only the documented hooks. |

## 2. Globals injected into the script

| Global | Source semantics | Agent Workflows implementation |
|---|---|---|
| `agent(prompt, opts?)` | Spawn one subagent. Without `schema` → returns final **text string**. With `schema` (JSON Schema) → returns the validated **object**. Returns `null` if the agent is skipped or dies on a terminal error after retries. Source opts include labels, schema, model/effort, isolation, and `agentType`. | One `codex exec` invocation, up to **2 attempts**: a transient `codex exec` death is retried whether or not a schema is set; schema agents additionally retry on parse/validate misses, then yield `null`. `schema` → `--output-schema <file>` + parse+validate `-o` last-message. No schema → returns the `-o` text. `model`→`-m`, `effort`→`-c model_reasoning_effort=`, `isolation:'worktree'`→ git worktree + `-C`, `profile`→ runtime builtin preamble/default sandbox, `mcp`→ bounded per-agent MCP policy. |
| `pipeline(items, ...stages)` | Each item flows through all stages independently, **no barrier**. Item A may be in stage 3 while B is in stage 1. Stage cb gets `(prevResult, originalItem, index)`. A throwing stage drops that item to `null` and skips its remaining stages. Wall-clock = slowest single-item chain. | Identical scheduling: per-item async chains started concurrently, gated only by the global concurrency semaphore. No `Promise.all` barrier between stages. |
| `parallel(thunks)` | Run thunks concurrently; **barrier** — awaits all. A throwing thunk resolves to `null` (call never rejects). | Identical: `Promise.all` of semaphore-wrapped thunks, each wrapped to resolve `null` on throw. |
| `log(message)` | Emit a narrator line above the progress tree. | Writes a narrator line to the live status file + stderr. |
| `phase(title)` | Start a phase; later `agent()` calls group under it. | Sets current phase in progress state; agents inherit it unless `opts.phase` overrides. |
| `workflow(nameOrRef, args?)` | Run another workflow inline; returns its return value. **One level only** — nested `workflow()` throws. Shares concurrency cap, agent counter, abort signal, token budget. | Loads the named/scripted child, runs it in the same run context (shared semaphore, counter, budget). Depth>1 throws. |
| `args` | The value passed as the Workflow `args` input, verbatim (`undefined` if absent). | The `--args`/`--args-file` JSON value, verbatim. |
| `budget` | `{total:number|null, spent():number, remaining():number}`. `spent()` = output tokens this run across main loop + all agents (shared pool). `remaining()` = `max(0,total-spent())` or `Infinity` when `total` is null. Hard ceiling: `agent()` throws once `spent()≥total`. | `total` from `--budget`. `spent()` = Σ `turn.completed.usage.output_tokens` across all Codex agents this run. Same `remaining()` math. The ceiling is checked **after a slot is acquired from the concurrency semaphore**, so completed agents' spend is visible: at concurrency 1 it enforces the ceiling exactly, and in a fan-out it bounds overshoot to the in-flight set rather than admitting the whole batch up front. |

## 3. Limits & determinism

| Source | Agent Workflows |
|---|---|
| Concurrent `agent()` capped at `min(16, cpu_cores - 2)`; excess queues. | `min(16, os.cpus().length - 2)` (floored at 1) semaphore. Excess `agent()` calls queue. |
| Lifetime cap: 1000 agents per run (runaway backstop). | Identical counter, but it counts only **live spawns** — a cached/replayed `agent()` on resume is free and does not consume cap. The 1001st live spawn throws. |
| A single `parallel()`/`pipeline()` accepts at most 4096 items; more is an explicit error. | Identical guard. |
| Determinism: time/random blocked in scripts so resume replays identically. | Same (see §1). Runtime-side (not script) time/random is allowed. |

## 4. Resume / journal

| Source | Agent Workflows |
|---|---|
| Each invocation persists its script to a file; the path is returned. Re-invoke with `{scriptPath}` to iterate. | `agent-workflows run <script>` copies the script into the run dir; `runId` printed. Re-run with the same path. |
| Resume with `{scriptPath, resumeFromRunId}`: the **longest unchanged prefix** of `agent()` calls returns cached results instantly; the first edited/new call and everything after runs live. Same script + same args → 100% cache hit. | `agent-workflows run <script> --resume-from <runId>` and `agent-workflows resume <runId>` use a durable journal keyed by `sha(prompt + resolved model/effort/sandbox/schema/profile fingerprint/isolation/effective MCP policy intent)`. On resume, an identical call replays its cached result; a changed call (or one whose prompt now differs because an upstream result changed) misses and runs live. **This is content-addressed, not positional-prefix** — a deliberate divergence, because `pipeline()`/`parallel()` launch agents out of source order, which makes a strict "everything after position N" prefix ill-defined. The practical guarantees are stronger where it matters and explicit where it differs:<br>• **Same script + same args + same flags → 100% cache hit** (identical to source).<br>• **A data-dependent downstream call re-runs** when its upstream changes, because the upstream's new output changes the downstream prompt → new key (matches the prefix intent).<br>• **An *independent* unedited call still hits** even if an earlier *independent* call was edited — Agent Workflows keeps the unaffected expensive result instead of re-running it. (Strict positional prefix would re-run it.)<br>Resolved model/effort/sandbox/profile/MCP policy are folded into the key, so changing them busts the cache as a real input change. |
| Date/random unavailable so the key set is stable. | Same enforcement. |

## 5. The subagent contract

| Source | Agent Workflows |
|---|---|
| Subagents are told their **final text IS the return value** (raw data, not a human-facing message). With `schema`, the subagent is forced to emit a `StructuredOutput` tool call; validation happens **in-conversation** at the tool layer, so the same agent re-emits on a mismatch. | Each `codex exec` prompt is wrapped with a system preamble: "your final message is consumed programmatically as the return value; return only the requested content/JSON, no prose framing." With `schema`, `--output-schema` forces the final message to match; the runtime then parses+validates **host-side**. A miss **re-spawns a fresh `codex exec`** (Codex has no in-conversation tool-retry), but the retry prompt now includes the prior failure (bad JSON excerpt or the specific validation errors) so the second attempt is informed rather than a blind re-roll. This host-side validate-then-respawn is a substrate divergence (see §8), not an API-surface one. |
| Agents can reach all session-connected MCP tools via on-demand schema loading. | Codex agents inherit the user's `~/.codex` MCP servers and config by default. `agent(..., { mcp })` narrows that surface with `inherit`, `none`, or `{ allow: { server: true \| string[] } }`, compiled into bounded `codex exec -c` overrides after JSON discovery and config probing. Non-inherit policies fail closed when the runtime cannot prove the bounded surface. |

## 6. Progress & observability

| Source | Agent Workflows |
|---|---|
| Phases render as group boxes; `log()` lines are narrators above the tree; `/workflows` is a live view; each agent shows a label. | `agent-workflows` writes a live `status.json` + human `progress.log` under the run dir. `agent-workflows ps` lists active runs; `agent-workflows watch <runId>` tails the tree. Labels come from `opts.label` or a prompt excerpt. |
| Tool result returns a `runId`; `<task-notification>` on completion. | `agent-workflows run --detach` and the Agent Workflows MCP server return `runId` immediately, plus MCP resource URIs for status/result/log/script/journal. Completion is represented by durable `result.json`, `status.json`, `progress.log`, and optional runtime-owned notification channels. |

## 7. Worktree isolation

| Source | Agent Workflows |
|---|---|
| `isolation:'worktree'` gives the agent its own git worktree; auto-cleaned if unchanged. EXPENSIVE — only for parallel file-mutators that would otherwise conflict. | `git worktree add <tmp>` off `HEAD`; the agent runs with `-C <tmp> -s workspace-write`; on completion, if the worktree has no changes it is removed (`git worktree remove`), else it is kept and its path reported. |

## 8. What is intentionally adapted (not 1:1, by necessity of the substrate)

- **Sandbox dimension**: Codex requires an explicit sandbox per `exec`. Agent Workflows exposes
  `read-only` and `workspace-write` on normal public surfaces, defaulting to `read-only` for
  plain agents and `workspace-write` for `isolation:'worktree'`. `danger-full-access` is a
  local runtime-policy path guarded by `ULTRACODE_ALLOW_DANGER_FULL_ACCESS=1`.
- **Invocation surface**: Claude Code exposes `Workflow` as a built-in tool. Codex has no such
  tool, so Agent Workflows is invoked as the `agent-workflows` CLI, and a Skill teaches the Codex agent
  *when* and *how* to write+run a workflow — reproducing the tool's decision guidance.
- **Model tiers and builtin profiles**: `model` and `effort` map to Codex models
  (`gpt-5.x-codex`…) and `model_reasoning_effort`. `profile` is an Agent Workflows builtin catalog
  (`reviewer`, `mutator`, `verifier`, `synthesizer`) that contributes preamble and default
  sandbox while leaving model selection to explicit options or Codex defaults.
- **Schema retry**: structured-output validation is host-side (`--output-schema` + a JSON-Schema
  validator) with a fresh-but-informed re-spawn on a miss, instead of an in-conversation
  `StructuredOutput` retry (see §5). Same observable contract (`schema` → validated object, or
  `null` after retries); different substrate.
- **Budget validation**: `--budget` must be a positive integer; a non-positive value is rejected
  at the CLI rather than silently treated as "no ceiling".
- **Resume scope**: the source's resume is same-session-only; Agent Workflows's journal is persisted
  per `runId` under `.agent-workflows/runs/`, so `--resume-from` works across separate invocations — a
  deliberately *stronger* guarantee than the original.
