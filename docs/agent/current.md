# Current Agent Cursor

Current goal: Agent Workflows is a single, host-agnostic package (`@plimeor/agent-workflows`) — a
faithful port of Claude Code's Workflow mechanism that runs subagents on any CLI coding agent via the
external `@plimeor/harness`. Keep the docs and structure coherent for outside readers.

Scope in:
- docs/index.md — the routing entry.
- docs/decisions/001-workflow-dsl-fidelity-contract.md — DSL fidelity authority (script-facing semantics).
- docs/decisions/002-run-runtime-contract.md — run runtime + the `agent-workflows mcp` control surface + security boundaries.
- docs/decisions/003-harness-adoption.md — host-layer authority: select/detect/health/install/uninstall + subagent run delegated to `@plimeor/harness`; the engine is host-agnostic.
- docs/decisions/004-single-package.md — structure authority: a single npm package with all source under `src/` (the monorepo collapsed once `@plimeor/harness` became external).
- docs/decisions/005-get-run-compact-projection.md — `get_run` read projection: a compact progress summary by default; `view:'full'` for the full `agents[]`/launch/log read. Refines the decision-002 MCP surface.
- docs/decisions/006-schema-retry-repair-pass.md — schema-retry substrate: a repair pass (reshape the prior reply, no task re-run) supersedes 001's full-respawn description; host death still re-runs.
- docs/requirements/2026-06-24-agent-workflows-port-requirement.md — the origin requirement (completed).

Scope out:
- README.md, AGENTS.md, evals/README.md, and src/assets/skills keep their local roles; they cite the workflow docs rather than duplicate them.
- Source-code contracts that live next to the implementation are not replaced by decisions.

Next step:
- No open implementation plan: the gap-closure plan is completed. New execution work starts from a new requirement/plan.
- Delivery actions (user-triggered): `bun publish` the single package; the full 8-case live eval comparison (billed; run on a clean checkout).
- Decisions are append-only, point-in-time records. The newest (003 host layer, 004 single package) reflect current reality; older ones (001, 002) are read as dated records and are NOT proofread or refreshed for drift — new reality goes into a new decision, never an edit to an old one.

Verification state:
- Single package: `bun run lint` 0, `bun run check` (tsc) 0, `bun test` 54 pass (`test/` + `evals/scripts`; in-process fake harness — no host CLI, no tokens). The global `agent-workflows` bin runs a real workflow end-to-end, and a single-package tarball installs clean.
- Decision 003 is implemented and adversarially reviewed. The codex extension is currently NOT installed (uninstalled during the single-package restructure; re-run `agent-workflows install` to use it).

Stop condition:
- A future agent can orient from this cursor and docs/index.md without reading removed or obsolete notes first.

Maintenance observation (2026-06-26):
- Operation: update + route. Repaired layout drift left by three refactors — `src/` grouped into `src/engine/`+`src/cli/` (commit 145e935), `init`→`install` rename + `assets/`→`src/assets/` move (64eaa70), single-package collapse (decision 004) — and marked the gap-closure plan completed at the user's direction.
- Touched: AGENTS.md (= CLAUDE.md symlink), docs/index.md, docs/plans/2026-06-24-runtime-gap-closure-plan.md (paths + status), this cursor.
- Observed set: docs/index.md, this cursor, all four decisions, the port requirement, the gap-closure plan, AGENTS.md, README.md, CONTRIBUTING.md, plus package.json and the real src/ tree (`src/engine/*`, `src/cli/*`, `src/assets/{skills,hooks}`).
- AGENTS.md / docs/index.md / cursor / gap-closure plan → reduce (stale path/verb pointers): flat `src/` → `src/engine`+`src/cli`, `assets/skills` → `src/assets/skills`, `init` → `install`. Action: applied. README.md, CONTRIBUTING.md → keep (already current).
- decisions/002 (Sources cite `packages/*`), decisions/003 (source plan `2026-06-24-productization-and-fairness-plan.md` deleted in commit 844b763; `packages/adapter-codex`), requirements/2026-06-24-agent-workflows-port-requirement.md (completed; describes the monorepo layout) → keep as dated point-in-time history; per the append-only invariant they are NOT edited for drift — current reality lives in decisions 003/004. Follow-up (deferred): if a future decision revisits the host/structure layer, note there that 003's source-plan link is git-only history. decisions/004 → keep (its `packages/*` mention correctly names the monorepo it collapsed from).
- Changed: doc bodies + this cursor; plan front matter `active`→`completed` with the matching index status flip in the same pass. No supersession, no archive (completed plan stays in plans/ as revisitable context, still cited by decision 002's 后续计划 line).
