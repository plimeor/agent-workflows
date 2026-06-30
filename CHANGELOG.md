# Changelog

This changelog is reconstructed from `package.json` version changes and the commits between those
version boundaries.

## 0.1.6 - 2026-06-29

### Changed

- Reworked the installed skill's progress-relay guidance to cut the per-run polling cost. The parent
  session now polls `agent_workflows_get_run` as a **long-poll** (a `waitMs` near 180s; the call
  blocks and returns the instant the run goes terminal — with the final `result` — or when `waitMs`
  elapses), and **reports only on a real state change** (a phase advanced, an agent errored, or the
  run finished) instead of emitting a line per poll. This turns a multi-hour run from one chatty turn
  a minute into a handful of mostly-silent long-polls.
- Framed `agent-workflows watch <runId> --follow` as the **user's** terminal channel for live
  progress, not a poll mechanism the parent session runs: `watch` bypasses the compact `get_run`
  projection (it renders the full per-agent tree), never returns the `result`, and `--follow` blocks
  until the run ends. The skill and the `summarize-active-runs` session hook now lead with
  `get_run` and point the user — not the agent — at `watch --follow`.

## 0.1.5 - 2026-06-28

### Changed

- Made `agent_workflows_get_run` return a **compact progress summary by default** instead of the full
  durable read: `state`, `currentPhase`, per-phase agent counts (non-zero states only), the last few
  narration lines, and the terminal `result`. The summary never reads or returns the `progress.log`
  tail and omits `launch` / `process` / `heartbeat` / `control` / the full `agents[]`, so each poll
  stays bounded regardless of agent count or run length. Pass `view: 'full'` to get the previous full
  payload (including the `progress.log` tail via `logTailBytes`) for drilling into one agent. The
  projection lives in the MCP layer only — `getRun` core and `status.json` are unchanged, so the CLI
  `watch` / `ps` live progress tree is unaffected. See `DECISIONS.xml` decision 005.
- Updated the installed Agent Workflows skill so the parent session derives its one-line status from
  the compact per-phase counts, reaches for `view: 'full'` only to inspect a stalled or errored agent,
  and polls with a 60-second-minimum `waitMs` (raised from 30s) to further cut accumulated poll cost.
- Changed the schema-bound `agent()` retry from a full re-run to a **repair pass**: when a reply
  parses or validates wrong, the retry now hands the agent only its prior reply, the schema, and the
  exact validation errors and asks it to reshape — skipping the original task's file reads and
  re-reasoning, which were the dominant retry cost. A transient host death still re-runs the full
  task (there is nothing to repair). The repair prompt forbids inventing or dropping content (an
  unsupported required field becomes null rather than a fabricated value), so a reply that genuinely
  dropped a required field stays invalid rather than being recovered by re-running. The DSL contract
  is unchanged: `agent(prompt, { schema })` still returns the validated object or `null`. See
  `DECISIONS.xml` decision 006.
- Tightened the authoring guidance: documented that `phase()` is a single global cursor so staged
  `agent()` calls must pass `opts.phase` explicitly under `parallel()`/`pipeline()`, that `workflow()`
  throws on an unknown name / unreadable `scriptPath` / child syntax error (wrap in `try/catch` to
  degrade gracefully), and that a judge panel synthesizes from the winner while grafting the best
  ideas from the runners-up.

## 0.1.4 - 2026-06-28

### Changed

- Reframed the installed Agent Workflows skills around the upstream Workflow operating model: a
  workflow is one well-scoped fan-out and the parent session stays in the orchestration loop across
  turns (scout → fan out → read the result → decide the next), with the five chainable single-phase
  shapes (Understand / Design / Review / Research / Migrate) named explicitly.
- Narrowed the parent-session wait discipline to govern only an actively running run; scouting and
  reading prior results in the parent before launching, and between chained workflows, is documented
  as expected rather than discouraged.
- Added a Scout → Bake → Structure → Launch authoring lifecycle and the "context pack" concept
  (`WORK_UNITS` exact file/symbol pairs · `SHARED` systemic risk · `NOT_A_BUG` authorized
  translations and known deferrals), so a review/audit fan-out hands each agent the files, the
  systemic risk, and the not-a-bug list instead of making agents rediscover them.
- Promoted the quality patterns from an optional menu to default per-task-class skeletons, including
  a copy-ready deep-review skeleton (pipeline review → severity-asymmetric adversarial verify →
  completeness critic → finished report) and an explicit "parts, not a ceiling" invitation to
  compose novel harnesses.
- Strengthened the `--budget` guidance: it is advisory and unmetered (`remaining()` never shrinks),
  so a ported native `while (budget.remaining() > N)` loop would spin to the 1000-agent lifetime cap.

## 0.1.3 - 2026-06-28

### Changed

- Updated `@plimeor/harness` from `^0.1.0` to `^0.1.2`.

## 0.1.2 - 2026-06-26

### Fixed

- Corrected README install examples to use the published scoped package name:
  `@plimeor/agent-workflows`.

### Changed

- Switched package licensing from MIT-only to dual `MIT OR Apache-2.0`.
- Added `LICENSE-MIT` and `LICENSE-APACHE`, documented the dual license in the README, and included
  both license files in the npm package `files` allowlist.
- Updated the Agent Workflows MCP server version from `0.1.0` to `0.1.1`.
- Documented the normal Agent Workflows invocation path as an explicit skill trigger in the prompt,
  for example `/agent-workflows Review this branch...`, instead of implying automatic keyword-based
  activation.
- Expanded installed workflow guidance for long-running detached runs: the parent session should
  relay progress and handle explicit run-control requests, while investigation and verification stay
  inside the workflow agents.
- Clarified that long workflow runs are expected: a single agent can run for 30-60 minutes and a full
  workflow can run for 1-2 hours.
- Clarified that `agent_workflows_get_run.waitMs` is only a read deadline and does not stop or time
  out the workflow run.
- Updated run-control guidance so `stop-run` and `stop-agent` are used only after explicit user
  confirmation.
- Added the same long-run and run-control guidance to installed hooks and the session-start message,
  so active workflow runs preserve the parent-session boundary consistently.

### Tests

- Added coverage that checks the installed skill, hooks, and extension spec preserve the long-run
  patience boundary and explicit-confirmation requirement.

## 0.1.0 - 2026-06-24

Source commit: `b7b749c`

### Added

- Initial Bun-native npm package for `@plimeor/agent-workflows`, exposing the `agent-workflows` CLI
  and the engine library entrypoint.
- Host-agnostic workflow engine built on `@plimeor/harness`, with Codex as the default host and no
  host-specific logic inside the engine.
- Workflow DSL globals for authoring orchestration scripts: `agent`, `parallel`, `pipeline`, `phase`,
  `log`, `workflow`, `args`, and `budget`.
- Deterministic script loading with a pure-literal `meta` contract and guards against nondeterministic
  `Date` and `Math.random` usage.
- Subagent execution through the harness seam, including structured-output prompting, JSON extraction,
  schema validation, and retry behavior for schema-bound agents.
- Concurrency scheduling, advisory budget tracking, maximum-agent safeguards, progress logging, run
  status/result persistence, atomic file writes, and worktree isolation support.
- Content-addressed resume journals so unchanged `agent()` calls can replay from prior results across
  workflow resumes.
- CLI commands and runtime surfaces for running, resuming, listing, watching, linting, controlling,
  installing, uninstalling, and diagnosing Agent Workflows.
- Stdio MCP run-control server for starting, resuming, reading, listing, and controlling detached
  workflow runs.
- Harness install extension with bundled skills, MCP configuration, and advisory hooks for workflow
  linting, run-start notices, and active-run summaries.
- Bundled workflow authoring guidance and recipes through the `agent-workflows` and
  `agent-workflows-authoring` skills.
- Example workflows for deep research, design panels, migrations, change review, and codebase
  understanding.
- Project documentation, including contributor guidance, agent-facing repo instructions, requirements,
  plans, and append-only design decisions.
- Evaluation harness, cases, rubrics, and scripts for comparing Codex and Claude workflow behavior.
- Test coverage using an in-process fake harness for runtime behavior, MCP run surfaces, harness
  installation, and evaluation-script helpers.
