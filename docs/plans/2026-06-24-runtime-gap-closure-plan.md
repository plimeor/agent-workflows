---
date: 2026-06-24
status: completed
---

# Runtime Gap Closure Plan

来源需求：docs/requirements/2026-06-24-agent-workflows-port-requirement.md。
上游决策：docs/decisions/001-workflow-dsl-fidelity-contract.md、
docs/decisions/002-run-runtime-contract.md。

## Goal

Close the only currently documented host-layer gap: inline child `workflow()` progress is not
rendered as its own nested group, even though token budget and execution semantics already share
the parent run context.

## Recommended Path

1. Extend the progress model with a stable grouping field for child workflows, or an equivalent
   `workflowPath` value on agent progress records.
2. Set that grouping value when `src/engine/engine.ts` runs a child workflow.
3. Render grouped child workflow progress in `src/cli/cli.ts` without changing the
   existing phase, narration, or agent-state semantics.
4. Keep the public DSL unchanged. The fix is presentation and observability only.

## Ownership Boundaries

- `src/engine/engine.ts` owns child workflow execution context.
- `src/engine/progress.ts` owns persisted progress shape and compatibility behavior.
- `src/cli/cli.ts` owns terminal rendering for `watch`.
- docs/decisions/001-workflow-dsl-fidelity-contract.md remains the authority for DSL behavior;
  this plan must not redefine `workflow()` semantics.

## Risks

- Changing `status.json` without compatibility handling could break existing watch or MCP readers.
- Grouping by phase alone is insufficient because child workflows can reuse parent phase names.
- Treating the gap as a DSL change would create an unnecessary migration for workflow authors.

## Verification

- Add or update runtime tests that prove nested `workflow()` agents retain budget sharing and carry
  enough progress metadata to group them.
- Run `bun run lint`.
- Run `bun run check`.
- Run `bun test`.
- Smoke-check `bun src/cli/cli.ts list` and a small workflow with `workflow()` if a fixture
  exists or is added.

## Stop Condition

The plan is complete when child workflow progress is inspectable as a nested group or equivalent
clear hierarchy, existing DSL tests still pass, and no public workflow script syntax changes.
