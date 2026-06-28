# Agentic Document Index

Default route: read docs/agent/current.md first, then open the specific document below.

- docs/requirements/2026-06-24-agent-workflows-port-requirement.md | requirement | Origin target: a faithful port of Claude Code's Workflow mechanism onto a CLI coding agent. | completed
- docs/decisions/001-workflow-dsl-fidelity-contract.md | decision | Stable Workflow DSL fidelity contract — the script-facing semantics the port must preserve. | active
- docs/decisions/002-run-runtime-contract.md | decision | The run runtime, the agent-workflows MCP control surface (start/resume/get/list/control), run state, and security boundaries. | active
- docs/decisions/003-harness-adoption.md | decision | Host layer (select/detect/health/install/uninstall + subagent run) delegated to the published @plimeor/harness; the engine is host-agnostic. | active
- docs/decisions/004-single-package.md | decision | The monorepo (core + cli) collapsed into a single npm package once @plimeor/harness became external; all source under src/. | active
- docs/decisions/005-get-run-compact-projection.md | decision | get_run returns a compact progress summary by default (state + per-phase agent counts + recent narration); view:'full' for the full read. | active
- docs/decisions/006-schema-retry-repair-pass.md | decision | Schema-bound agent() retry is a repair pass (reshape the prior reply, no task re-run); host death still re-runs the full prompt. | active
- docs/plans/2026-06-24-runtime-gap-closure-plan.md | plan | Implementation plan for the remaining child-workflow progress-grouping gap. | completed
- docs/index.md | index | Routing table for active agentic workflow documents. | current
- docs/agent/current.md | cursor | Current reading pointer for active project documentation state. | current

Project docs outside this workflow set keep their local ownership:
README.md is the user-facing entrypoint, AGENTS.md is the agent operating guide,
evals/README.md owns eval instructions, and the bundled skill files under
src/assets/skills own the host-facing workflow authoring guidance.
