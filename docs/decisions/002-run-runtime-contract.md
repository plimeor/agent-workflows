---
date: 2026-06-24
status: active
---

# Run Runtime Contract

来源需求：docs/requirements/2026-06-24-agent-workflows-port-requirement.md。
上游决策：docs/decisions/001-workflow-dsl-fidelity-contract.md。
后续计划：docs/plans/2026-06-24-runtime-gap-closure-plan.md。

## Decision

Agent Workflows uses a shared run runtime for CLI and MCP control: long-running workflows are
represented by detached run processes and durable run files, `RunControl` / `RunStore` are the
control and query boundary, builtin profiles are runtime-provided persona presets, per-agent MCP
policy narrows the inherited tool surface, and plugin hooks are advisory session guardrails rather
than the source of run truth.

## Rejected Alternatives

- Keep the MCP tool call alive *unboundedly* until the workflow finishes. That would make
  long-running workflow completion depend on a single request lifetime rather than durable state.
  A *bounded* wait is admitted: `agent_workflows_get_run` MAY block by re-reading durable state
  up to a fixed cap (`waitMs`, capped at 300s) and otherwise returns immediately, so completion
  still rests on durable files — only the unbounded keep-alive-until-finish form stays rejected.
- Treat `control.json` as the command queue. A single mutable file can lose intermediate control
  intent, so control commands use append-only files under `control/`.
- Accept raw Codex config, arbitrary shell callbacks, or user-defined profile registries in public
  MCP inputs. Those surfaces cross the runtime's bounded-policy boundary.
- Let plugin hooks own completion notification or run validity. Hooks can surface context, but the
  runtime's durable files are the authority.

## Non-Goals

- Changing the core DSL behavior defined by docs/decisions/001-workflow-dsl-fidelity-contract.md.
- Providing an unbounded MCP or sandbox passthrough through public workflow inputs.
- Making hooks a substitute for runtime state, control, or completion records.

---

## Architecture

```text
Codex MCP tool / Agent Workflows CLI
  -> RunControl / RunStore
    -> detached run process
      -> runWorkflow(...)
        -> agent(...) -> codex exec
```

- MCP server 使用官方 `@modelcontextprotocol/sdk` 和 stdio transport。
- MCP server 是 run 控制面: start / resume / get / list / control。
- 长时间 workflow 由 detached `run-process.ts` 承载;MCP tool call 只启动或查询进程。
- MCP server 不持有 workflow promise。durable run files 是进度和结果的事实来源。
- CLI 与 MCP 共用 `RunControl` / `RunStore`。
- DSL 核心契约仍是 `agent / parallel / pipeline / phase / log / workflow / args / budget`。

---

## Run State

每个 run 使用一个状态目录:

```text
.agent-workflows/runs/<runId>/
  launch.json
  process.json
  control/
    <command-id>.json
  control.json
  heartbeat.json
  script.mjs
  status.json
  result.json
  journal.json
  progress.log
```

`launch.json` 保存启动输入、脚本 hash、cwd、args、budget、model、effort、sandbox、
run-level MCP policy、concurrency、profile set version、resume source 和 schema version。

`process.json` 由 detached run process 启动后写入。父进程只负责 spawn 并返回 pid,不写
`process.json`。RunStore 使用 `launch.json.createdAt` 提供 boot grace,避免刚启动但尚未写
heartbeat 的进程被误判为 stale。

`control/` 是 append-only 命令队列。每个 control command 写一个独立 JSON 文件,后台
run process 按文件名顺序处理尚未见过的命令。`control.json` 是最近一次控制意图的查询快照,
不作为 runtime 唯一命令来源。

`heartbeat.json` 由 run process 定时写入。默认 heartbeat 间隔为 10 秒,stale 阈值为
30 秒,boot grace 为 5 秒。

`status.json` 是 live progress snapshot:

```json
{
  "runId": "wf_...",
  "name": "review-changes",
  "startedAt": 1760000000000,
  "updatedAt": 1760000001000,
  "currentPhase": "Review",
  "phases": ["Review", "Verify"],
  "narration": [{ "t": 1200, "message": "..." }],
  "agents": [
    {
      "id": "a1",
      "seq": 1,
      "label": "review:bugs",
      "phase": "Review",
      "state": "running",
      "detail": "$ bun run check"
    }
  ]
}
```

Agent states include `queued`, `paused`, `running`, `done`, `error`, `cached`, and `stopped`。

`result.json` is terminal output for `done`, `error`, or cooperative `stopped` runs. A missing
terminal result plus stale heartbeat is reported as inferred `stale` by RunStore; ordinary
read/list operations do not write terminal stale results and do not signal processes.

---

## MCP Surface

Tools:

- `agent_workflows_start_run`: start a detached run from inline DSL source text or a named/ref
  workflow, and return `runId`, pid, run dir, and resource URIs。Inline source is lint-gated
  (fail-closed) before launch。
- `agent_workflows_lint`: statically lint an inline DSL source (meta block + body compile)
  without running it; this is the same gate `start_run` applies to inline source。
- `agent_workflows_resume_run`: start a detached run from a prior run's saved script and journal。
- `agent_workflows_get_run`: read one run's durable status/result/log tail, optionally performing
  a bounded wait — re-reading durable state up to a fixed cap (`waitMs`, capped at 300s) until the
  run is terminal, otherwise a single-shot read。
- `agent_workflows_list_runs`: list recent runs from the selected cwd。
- `agent_workflows_control_run`: enqueue `stop-run`, `pause-admission`, `resume-admission`,
  `stop-agent`, or `restart-agent`。

Resources:

```text
agent-workflows://runs/{runId}/status
agent-workflows://runs/{runId}/result
agent-workflows://runs/{runId}/progress-log
agent-workflows://runs/{runId}/script
agent-workflows://runs/{runId}/journal
```

The MCP server accepts only bounded public inputs. Inline DSL source text is one such bounded
public input: it is gated by `agent_workflows_lint` (fail-closed) and constrained by the engine's
enforcement of a pure-literal `meta` block and per-agent sandbox policy, so it cannot widen the
runtime's policy boundary. Inline DSL source is DISTINCT from raw Codex config and does not relax
the following prohibitions, which remain in force: the server does not accept raw Codex config,
arbitrary shell completion commands, or user-defined profile registries.

---

## Control Runtime

- `stop-run` aborts the root run controller。
- `pause-admission` parks future cache-miss `agent()` calls before they acquire semaphore slots。
- `resume-admission` releases parked calls。
- `stop-agent` aborts one active agent controller, or marks a queued agent stopped before spawn。
- `restart-agent` aborts one active agent attempt and re-enters admission/semaphore for the same
  live `agent()` call。
- Restart is not resume. Resume creates a new run from `script.mjs` + `journal.json`; restart
  acts inside the live run graph。
- Control-induced stopped/restarted attempts do not write ordinary cache entries。

---

## Profiles

用户层 persona 入口是 builtin `profile`:

```ts
agent(prompt, {
  profile?: "reviewer" | "mutator" | "verifier" | "synthesizer"
})
```

Profiles are runtime builtins. Unknown profiles are hard errors. Builtins provide preamble and
default sandbox only; model selection comes from explicit `agent()` options, run options, or
Codex defaults. Profile fingerprint and builtin profile set version participate in journal keys
for profiled agents.

---

## MCP Policy

Target DSL:

```ts
type McpPolicy =
  | "inherit"
  | "none"
  | { allow: Record<string, true | string[]> };
```

- Run-level `mcpPolicy` is the upper bound。
- Agent-level `mcp` may narrow the run-level policy。
- `inherit` uses the run effective policy。
- `none` disables all discoverable effective MCP servers。
- `allow` keeps only the named server/tool subset。
- Raw `extraConfig` and raw `codex exec -c` are internal-only。
- Empty MCP discovery is valid for `none`; an allowlist naming a missing server is a hard error。
- Non-inherit policy compiles only when Codex reports the requested `enabled_tools` through
  `codex mcp get <server> --json` under the generated per-exec config. If the runtime cannot
  prove the bounded surface, the agent launch fails closed。

---

## Security Boundaries

- `cwd` is realpath-normalized and must stay inside authorized roots。
- Authorized roots come from explicit runtime/Codex workspace env vars; when none are present,
  the runtime seals `cwd` to the CLI/MCP server launch cwd。
- `scriptRef` and child `workflow(ref)` paths are realpath-normalized under selected workflow
  roots and cannot expand the allowed root set。
- Public MCP sandbox input accepts only `read-only | workspace-write`。
- `danger-full-access` is a local runtime-policy path guarded by
  `AGENT_WORKFLOWS_ALLOW_DANGER_FULL_ACCESS=1`; MCP input and inherited launch state cannot enable it
  by themselves。
- `concurrency` is clamped to `1..16` and rejected when non-finite。

> **NOTE (superseded by docs/decisions/003-harness-adoption.md):** the two sandbox bullets above no
> longer describe the implementation. Per 003 the host harness (`@plimeor/harness`) owns subagent
> sandboxing — agent-workflows passes no sandbox flag, so the public MCP surface no longer accepts a
> `sandbox` input and the in-repo `danger-full-access` guard was removed. The remaining boundaries
> here (cwd realpath seal under authorized roots, `scriptRef`/child-`workflow(ref)` path
> normalization, concurrency clamp) stand unchanged.

---

## Hooks

Plugin Hooks are session-level guardrails and context surfacing:

- `SessionStart`: reminds the agent that Agent Workflows workflows are available。
- `PostToolUse` for workflow file writes: lints `workflows/*.mjs` when a hook event exposes a
  written path。
- `PostToolUse` for Agent Workflows MCP run tools: surfaces run id and resource URIs。
- `Stop`: summarizes active runs in the current cwd。

Hooks do not keep a turn alive until a run completes, do not enforce MCP input validity, and do
not own durable completion notification.

---

## Sources

- [OpenAI Codex Build plugins](https://developers.openai.com/codex/plugins/build)
- [OpenAI Codex Hooks](https://developers.openai.com/codex/hooks)
- [OpenAI Codex MCP](https://developers.openai.com/codex/mcp)
- [packages/cli/src/cli.ts](../packages/cli/src/cli.ts)
- [packages/core/src/engine.ts](../packages/core/src/engine.ts)
- [packages/core/src/hooks.ts](../packages/core/src/hooks.ts)
- [packages/core/src/agent-run.ts](../packages/core/src/agent-run.ts) (the harness run seam that replaced the in-repo codex runner; see decision 003)
