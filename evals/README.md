# Agent Workflows Comparative Evals

These evals compare how a host agent answers a case against Claude Code's built-in
Workflow/Ultra Code behavior. There are two distinct paths, and they are not interchangeable.
The recorded `2026-06-24-codex-natural` run used the **fixed 1-agent baseline runner**
(`evals/workflows/autonomous-eval-runner.mjs`): Codex is forced through a single `agent()`
call with a prescribed output schema, acting only as a constrained leaf worker, never the
decider — so that column is a baseline control, not a free-choice Codex run. The new
symmetric path is the **live-host run** (`evals/scripts/run-codex-host.sh`), where a real
`codex exec` host receives the same natural prompt as `claude -p`, with the installed
agent-workflows MCP attached, and is free to answer directly or to author and launch a
workflow inline via the `agent_workflows_start_run` MCP tool. The tested prompt is written
like a normal user request: it gives the context and asks for help with the task. The
grading criteria are stored separately under `rubrics/` and are not passed to the tested
model during the run.

## Inference Boundary

Results from one task family do not justify global agent-rule changes. A comparison run can
support a conclusion only inside the task families it covers. Broader Codex or Agent Workflows
rules should be changed only after the suite includes enough different task shapes to
separate general strategy from family-specific behavior.

The suite started with three analysis-and-synthesis cases:

- `scheduler-code-review`: code review and bug localization.
- `incident-reconciliation`: incident diagnosis and evidence reconciliation.
- `offline-approval-design`: product/system design tradeoff.

Those cases can support conclusions about multi-step analysis quality. They cannot by
themselves prove that implementation, migration, documentation, long-running execution, or
tool-heavy tasks should use the same strategy.

Current coverage now includes additional context-package cases:

- `config-path-implementation`: implementation fix strategy from a source snippet and bug report.
- `export-map-migration-plan`: public API boundary migration planning.
- `workflow-docs-port`: documentation/spec migration with semantic fidelity constraints.
- `detached-run-recovery`: long-running background run recovery and resume control.
- `publish-readiness-triage`: package publish readiness from local file and command-output evidence.

A tool-heavy case extends coverage beyond pure-text reasoning:

- `runtime-budget-cap-audit`: an audit that requires reading the real runtime source and
  running `bun test` / the workflow linter to confirm budget and agent-cap enforcement, rather
  than answering from a provided evidence packet.

The other added cases still evaluate final answers from a provided evidence packet. Fixture-backed
implementation tasks that require real source edits and broader command execution need a
fuller fixture harness and should not be treated as covered by the text-only cases.

## Target Coverage

Grow the suite across these task families before deriving stable rules:

- Code review and bug localization.
- Implementation tasks that require source edits and scope control.
- Refactor or migration planning with compatibility boundaries and sequencing.
- System design tradeoffs across product, data, security, and operations.
- Incident review and root-cause analysis with noisy or conflicting evidence.
- Documentation or spec migration where semantic fidelity and ecosystem adaptation matter.
- Long-running execution management: background work, progress checks, resume, and failure handling.
- Tool-heavy tasks that require files, commands, or external tools rather than pure text reasoning.

For each run, record the model's actual strategy after the fact: whether it delegated work,
how many workers it used, whether prompts were task-specific, whether it used planning or
critique steps, and how the parent answer reconciled partial results. Do not prescribe those
choices in the case prompt.

## Case Shape

Each `cases/*.json` file contains:

- `title`: case name.
- `task`: the final decision or answer required.
- `context`: the evidence packet given to the model.

Each `rubrics/*.json` file contains:

- `title`: matching case name.
- `gradingCriteria`: criteria used after the run for human comparison only.

## Codex Run

Symmetric to the Claude Code run below: render the case into a natural prompt and feed it to a
real `codex exec` host with the installed agent-workflows MCP attached, so Codex is free to
answer directly or to author and launch a workflow inline. This is the fair-comparison path.

```bash
evals/scripts/run-codex-host.sh evals/cases/<case>.json <run>
# writes evals/results/<run>/<case>.host.jsonl (full event stream)
#    and evals/results/<run>/<case>.codex.txt  (answer-only final message)
```

To record what strategy Codex actually chose (how many sub-agents it launched, with what
labels and phases), parse the event stream after the run:

```bash
bun evals/scripts/capture-strategy.ts evals/results/<run>/<case>.host.jsonl
```

The fixed 1-agent baseline runner is kept only as an explicit control — it forces Codex
through a single prescribed `agent()` call and is NOT a free-choice run:

```bash
agent-workflows run evals/workflows/autonomous-eval-runner.mjs \
  --args-file evals/cases/<case>.json \
  --json
```

## Claude Code Run

Render a natural user prompt from the case and save Claude's raw answer:

```bash
bun evals/scripts/render-claude-prompt.ts evals/cases/<case>.json > evals/results/<run>/<case>.prompt.md
claude -p < evals/results/<run>/<case>.prompt.md > evals/results/<run>/<case>.claude.txt
```

Then grade the raw answer with the hidden rubric. JSON belongs to this grader stage, not the
tested model prompt:

```bash
bun evals/scripts/render-grader-prompt.ts \
  evals/cases/<case>.json \
  evals/rubrics/<case>.json \
  evals/results/<run>/<case>.claude.txt \
  > evals/results/<run>/<case>.grade.prompt.md

claude -p < evals/results/<run>/<case>.grade.prompt.md > evals/results/<run>/<case>.grade.json
```

## Comparison

Compare outputs on:

- Whether all high-signal facts in `gradingCriteria` were found.
- Whether the recommendation is concrete enough to execute.
- Whether confidence and open questions are calibrated to the evidence.
