# Agent Workflows

**Turn one CLI coding agent into a team of them — fan out, cross-check, and synthesize, deterministically.**

Agent Workflows ports Claude Code's `Workflow` mechanism onto any CLI coding agent (Codex by default, via [`@plimeor/harness`](https://www.npmjs.com/package/@plimeor/harness)). After a one-time install, your agent can — mid-conversation — break a big task into many subagents that run in parallel, verify each other, and roll up into one answer.

## Quick start

**1. Prerequisites** — [Bun](https://bun.sh), and a supported host CLI on your `PATH` (Codex by default; `claude` / `kiro` / `pi` also work).

**2. Install the command:**

```bash
bun add -g @plimeor/agent-workflows      # global `agent-workflows`
# or run without installing:  bunx @plimeor/agent-workflows <command>

agent-workflows doctor          # verify Bun + your host are reachable
```

**3. Install it into your agent** so you can invoke the workflow skill from a normal session:

```bash
agent-workflows install         # writes the skills + MCP server + hooks into your host (codex)
```

Start a fresh host session afterward so they load. (`agent-workflows uninstall` removes them.)

**4. Use it — the main way is to manually invoke the skill in a normal session.** Put the skill trigger directly in your prompt for work that is worth decomposing:

> "/agent-workflows Review this branch across correctness, security, and performance — and verify each finding before reporting it."

> "/agent-workflows Fan out subagents to map this codebase, then synthesize an architecture overview."

The skill guides the agent to author a small workflow script, launch it, fan out the subagents, and summarize the result. This is an explicit skill invocation path, not a keyword-triggered automatic mode. (On a small task it may still answer directly — that's intended.)

**Or drive one yourself from the CLI:**

```bash
agent-workflows list                     # bundled + local named workflows
agent-workflows run review-changes        # run one by name
agent-workflows run ./my-workflow.mjs     # or a script file
agent-workflows watch <runId> --follow    # follow progress; `resume <runId>` replays unchanged work for free
```

---

## What is a "workflow"?

A workflow is a tiny JavaScript script that orchestrates many subagent calls. One `agent(prompt)` call spawns **one subagent** — a fresh host run with its own clean context — and returns what it produced. Around it you fan out, pipeline, and combine:

```js
// review a diff from three angles in parallel, then return every finding
const reviews = await parallel([
  () => agent("Find correctness bugs in the changed files.", { schema: FINDINGS }),
  () => agent("Find security issues in the changed files.",  { schema: FINDINGS }),
  () => agent("Find performance regressions in the changed files.", { schema: FINDINGS }),
])
return reviews.filter(Boolean)
```

**Why "dynamic"?** You declare the *phases*, but not how many subagents each one spawns — that's decided at runtime from the previous phase's real results. The control flow *is* the plan:

```js
phase("Review")
const reviews  = await parallel(REVIEWERS.map(r => () => agent(r.prompt, { schema: REVIEW })))
const findings = reviews.filter(Boolean).flatMap(r => r.findings)   // size unknown until now

phase("Verify")                                                     // one verifier per finding —
const verified = await parallel(findings.map(f => () =>            // count = whatever Review produced
  agent(`Verify: ${f.title}`, { schema: VERDICT })))
```

**What a single prompt can't do** that this can: cover a surface too big for one context window (fan out N subagents), verify findings with *independent* skeptics before you trust them, size later phases to earlier results, and detach / watch / **resume** long runs (re-running replays unchanged subagents for free; clocks and RNG are blocked so a resume reproduces the same shape).

Reach for a workflow for exhaustive review/audit, large migrations, multi-source research, or multi-angle design decisions. Skip it for a single edit or a quick lookup.

## Authoring your own

A workflow is a `.mjs` file: a pure-literal `meta` first, then a plain-JS async body with the DSL injected and a top-level `return`. The globals are `agent`, `parallel` (barrier), `pipeline` (no barrier — the default for multi-stage work), `phase`, `log`, `workflow`, `args`, and `budget`. Put `schema` (a JSON Schema) on the agents whose results the script branches or fans out on; leaf and synthesis agents can return plain text. `agent-workflows lint <script>` static-checks a script without running it.

For the full reference — schemas, resume, worktree isolation, and copy-ready recipes (adversarial verify, judge panel, loop-until-dry) — read the bundled **`agent-workflows-authoring`** skill.

## Host-agnostic by design

Every subagent is one text run through `@plimeor/harness`, and the "structured output" contract (the JSON Schema is embedded in the prompt and validated/retried in-engine) is layered on top — so it works on any text-producing host. The CLI is the only layer that picks a concrete harness (`--harness`, default `codex`).

## More

- [`AGENTS.md`](AGENTS.md) — project layout and the contributor guide.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — dev setup and the lint/check/test commands.
- [`docs/decisions/`](docs/decisions/) — the durable design decisions.

## License

Dual-licensed, at your option, under either of:

- [MIT](LICENSE-MIT)
- [Apache License 2.0](LICENSE-APACHE)

© Plimeor
