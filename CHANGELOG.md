# Changelog

This changelog is reconstructed from `package.json` version changes and the commits between those
version boundaries.

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
