# Agent Workflows — guide for an agent working on this repo

Agent Workflows is a 1:1 port of Claude Code's `Workflow` mechanism onto CLI coding agents,
shipped as a **single npm package** (`@plimeor/agent-workflows`). You author a plain-JS
orchestration script and run it with `agent-workflows run`; the engine fans out deterministic
subagents. Subagents run on a host via the external `@plimeor/harness` SDK (Codex by default) — the
engine itself never names a host.

This file orients an agent **developing this codebase**. To learn how to *use* workflows, read the
README and the bundled skills; for the current collaboration cursor read `.agentdocs/cursor.md`,
and for durable design rationale read `DECISIONS.xml`.

## Stack

- **Bun-native, no build step** — Bun runs the `.ts` source directly, and the package ships TS source.
- A single package; all source lives under `src/`. `@plimeor/harness` is an external published
  dependency — consume it, never vendor or modify it from here.

## Layout

- `src/` — all source, grouped into two namespaces:
  - `src/engine/` — the host-agnostic engine and DSL (`exports` → `src/engine/index.ts`):
    - `hooks.ts` — the DSL (`agent` / `parallel` / `pipeline` / `phase` / `log` / `workflow` / `args` / `budget`).
    - `engine.ts` — loads a script, runs the body in a VM, orchestrates the run (concurrency, journal, resume).
    - `agent-run.ts` — the harness seam: one `agent()` → one `harness.process.run` text run.
    - plus `scheduler`, `budget`, `journal`, `run-store`, `profiles`, `progress`, `schema`, `worktree`,
      `workflows` (path resolution), `control-runtime`, `atomic`; `index.ts` is the public library barrel.
  - `src/cli/` — the `agent-workflows` bin and run control (`bin` → `src/cli/cli.ts`):
    - `cli.ts` — the `agent-workflows` bin · `mcp.ts` — the stdio MCP run-control server ·
      `run-control.ts` / `run-process.ts` — prepare/execute/detach a run · `harness.ts` — host
      selection + the install extension (MCP + skills + hooks).
  - `src/assets/{skills,hooks}` — installed into a host by `install`.
- `workflows/` — bundled example workflows.
- `test/` — engine/CLI/eval tests, driven by an in-process fake harness (no host CLI, no tokens).
- `evals/` — the fair Codex-vs-Claude eval harness.
- `.agentdocs/` — the current collaboration working tree. `DECISIONS.xml` — the durable decision ledger.

## Commands

- `bun run check` (tsc) · `bun run lint` (biome) · `bun run test` — keep all three green before finishing.
- Run the CLI in dev: `bun src/cli/cli.ts <cmd>` (or `bun link` once for a global `agent-workflows`).
- See `CONTRIBUTING.md` for more.

## Invariants when changing the code

- **The engine stays host-agnostic.** It programs against `@plimeor/harness`'s `process.run` only
  (the `agent-run.ts` seam) and must never name or import a specific host (`codex` / `claude` / …).
  Host specifics live in `@plimeor/harness`. (`DECISIONS.xml` decision 003)
- The script-facing **DSL contract** is stable authority (`DECISIONS.xml` decision 001) — don't change the
  meaning of the injected globals; the in-script determinism guards (no `Date.now` / `Math.random`)
  and the resume journal depend on it.
- The **MCP run-control surface** and security boundaries — cwd realpath-sealing under authorized
  roots, fail-closed inline-source lint — are governed by `DECISIONS.xml` decision 002.

## Documents

- To orient, read `.agentdocs/cursor.md` first, then the active docs it links.
- Active Requirements live under `.agentdocs/requirements/`. Plans and Tasking are temporary and are
  deleted after consolidation when completed.
- Decisions live only in `DECISIONS.xml`. Filter `status="active"` for current authority.
- **Decisions are append-only, point-in-time records.** Never edit an old decision to "correct"
  drift. Record new reality in a new decision, and supersede older records with lifecycle attributes
  when they answer the same durable question.
