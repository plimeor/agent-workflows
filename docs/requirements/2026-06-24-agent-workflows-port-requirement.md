---
date: 2026-06-24
status: completed
---

# Agent Workflows Port Requirement

来源材料：AGENTS.md、README.md、plugins/codex-agent-workflows/skills/agent-workflows/SKILL.md。

## Goal

Agent Workflows provides a Codex CLI implementation of Claude Code's `Workflow` mechanism while
keeping the script-author experience faithful: users write plain JavaScript workflow scripts and
run them with `agent-workflows run`, and the runtime owns fan-out, pipelines, budgets, resumable
journals, detached runs, progress files, and controlled MCP access.

## Scope

- Preserve the script-facing Workflow DSL contract: `agent`, `parallel`, `pipeline`, `phase`,
  `log`, `workflow`, `args`, and `budget`.
- Keep Codex-specific host behavior explicit at the adaptation layer: sandbox policy, builtin
  profiles, model/effort mapping, MCP policy, plugin hooks, and durable run files.
- Keep package and plugin documentation aligned with the current monorepo layout:
  `packages/core`, `packages/cli`, `packages/adapter-codex`, and
  `plugins/codex-agent-workflows`.
- Route durable collaboration knowledge through `docs/index.md` and typed workflow documents, so
  active requirements, decisions, plans, and the current cursor are discoverable without reading
  stale notes first.

## Non-Goals

- Recreate Claude Code's internal harness implementation.
- Treat completed host-layer work as an open gap after its boundary has become a decision.
- Keep obsolete root paths such as `runtime/`, `skills/`, `hooks/`, or `workflows/` as the primary
  documentation authority after the package/plugin split.
- Store source-code API contracts only in collaboration documents when they also need to live next
  to implementation.

## Acceptance Criteria

- The DSL fidelity contract is a durable decision record.
- The run runtime boundary is a durable decision record.
- Remaining execution work is isolated to a plan and cites its upstream requirement and decisions.
- The default documentation route starts at `docs/index.md` and `docs/agent/current.md`.
- Public and agent-facing documentation no longer points readers at deleted or obsolete doc paths.
