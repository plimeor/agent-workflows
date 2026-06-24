#!/usr/bin/env bash
#
# run-codex-host.sh — live-host Codex launcher for the FAIR evals chain.
#
# This is the symmetric-to-`claude -p` Codex run: it renders a case into a
# natural user prompt and feeds it to `codex exec` running as a real host, with
# the installed agent-workflows MCP attached. Codex is free to answer directly
# OR to author+launch an Agent Workflows run inline (via the
# agent_workflows_start_run MCP tool — T008's inline `source`), exactly as it
# would in production. There is EXACTLY ONE launch path here: a real
# `codex exec` with the MCP attached. There is deliberately no runner fallback,
# no flag to opt into a second code path, and no "if MCP missing then ..."
# branch — if the MCP is not attached the script fails loudly with a non-zero
# exit, because a Codex run without the MCP is false parity, not a
# degraded-but-acceptable run.
#
# The MCP is sourced ONLY from `agent-workflows install codex`, which routes through
# @plimeor/harness and writes the MCP server (launch command = the portable
# `agent-workflows mcp`) into the scratch home's codex config, plus the bundled
# skills + hooks. We never hardcode a plugin path nor a repo-relative interpreter
# invocation of the MCP entry module, and we never hand-author that config.
#
# Usage:
#   evals/scripts/run-codex-host.sh <case.json> [run-id]
#
# Env overrides (all optional):
#   AGENT_WORKFLOWS_BIN   how to invoke the agent-workflows CLI for `install codex`
#                         (default: "agent-workflows"; e.g. "bun src/cli.ts")
#   AGENT_WORKFLOWS_CODEX_BIN / UC_CODEX_BIN
#                         the codex binary (default: "codex")
#
# Outputs (per case):
#   evals/results/<run>/<case>.host.jsonl   the full JSONL event stream
#   evals/results/<run>/<case>.codex.txt    the answer-only final message
set -euo pipefail

die() {
	printf 'run-codex-host: %s\n' "$1" >&2
	exit 1
}

case_file="${1:-}"
[ -n "$case_file" ] || die "usage: run-codex-host.sh <case.json> [run-id]"
[ -f "$case_file" ] || die "case file not found: $case_file"

run_id="${2:-host}"

# Resolve repo root from this script's location so renders/outputs are stable
# regardless of the caller's cwd, without hardcoding any absolute machine path.
script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"

codex_bin="${AGENT_WORKFLOWS_CODEX_BIN:-${UC_CODEX_BIN:-codex}}"
aw_bin="${AGENT_WORKFLOWS_BIN:-agent-workflows}"

# Case slug drives the per-case output filenames.
case_base="$(basename "$case_file")"
case_slug="${case_base%.json}"

out_dir="$repo_root/evals/results/$run_id"
mkdir -p "$out_dir"
host_jsonl="$out_dir/$case_slug.host.jsonl"
answer_txt="$out_dir/$case_slug.codex.txt"

# Scratch home so the installed MCP config is isolated from the user's real Codex
# home and torn down on exit. @plimeor/harness writes config under <home>/.codex and
# does NOT honor $CODEX_HOME, so we make the scratch dir the process HOME and point
# CODEX_HOME at the matching <home>/.codex that `codex exec` reads.
scratch_home="$(mktemp -d "${TMPDIR:-/tmp}/codex-host-XXXXXX")"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/codex-run-XXXXXX")"
cleanup() {
	rm -rf "$scratch_home" "$tmp_dir"
}
trap cleanup EXIT

# Capture the user's real Codex home BEFORE we repoint HOME, so we can copy auth in.
real_codex_home="${CODEX_HOME:-$HOME/.codex}"
scratch_codex_home="$scratch_home/.codex"
mkdir -p "$scratch_codex_home"
# A minimal config.toml so `codex exec` has a configured home to read.
: >"$scratch_codex_home/config.toml"
# Preserve the user's Codex auth so the isolated host can still authenticate.
[ -f "$real_codex_home/auth.json" ] && cp "$real_codex_home/auth.json" "$scratch_codex_home/auth.json"

export HOME="$scratch_home"
export CODEX_HOME="$scratch_codex_home"

# (a) Install agent-workflows into the scratch home via `agent-workflows install codex`
#     (routes through @plimeor/harness): it writes the MCP server with the portable
#     `agent-workflows mcp` launch command into <home>/.codex/config.toml, plus the
#     bundled skills + hooks. The CLI driver here is the cli.ts entry point.
# shellcheck disable=SC2086
$aw_bin install codex >"$tmp_dir/init.log" 2>&1 ||
	die "agent-workflows install codex failed:
$(cat "$tmp_dir/init.log")"

# Assert the MCP is actually attached for this host. We ask Codex itself what it
# sees (`codex mcp list --json`). If the agent-workflows server is not present,
# fail loudly — no fallback path.
if ! mcp_list="$("$codex_bin" mcp list --json 2>"$tmp_dir/mcp-list.err")"; then
	die "codex mcp list --json failed (cannot confirm MCP attachment):
$(cat "$tmp_dir/mcp-list.err")"
fi
case "$mcp_list" in
*'"agent-workflows"'*) : ;;
*) die "agent-workflows MCP is NOT attached to the Codex host (install codex did not take effect)" ;;
esac

# (b) Render the case into a natural prompt and (c) pipe it into a real `codex exec`.
#     --dangerously-bypass-approvals-and-sandbox is REQUIRED here: a headless `codex exec`
#     auto-cancels MCP tool calls when there is no approver ("user cancelled MCP tool call"),
#     so without it Codex can never reach agent_workflows_start_run and the host path is dead.
#     The bypass also drops the sandbox, so the CALLER MUST point $CODEX_HOST_CWD at a
#     throwaway/clean checkout (NOT a live working tree) — Codex may freely edit that cwd.
#     The rendered prompt is the final positional arg (read from a temp file to keep it intact).
last_file="$tmp_dir/last.txt"
prompt_file="$tmp_dir/prompt.txt"
host_cwd="${CODEX_HOST_CWD:-$repo_root}"

bun "$repo_root/evals/scripts/render-codex-prompt.ts" "$case_file" >"$prompt_file" ||
	die "render-codex-prompt failed for $case_file"

# Tee the JSONL event stream to <case>.host.jsonl while it streams.
prompt="$(cat "$prompt_file")"
"$codex_bin" exec \
	--json \
	--skip-git-repo-check \
	--dangerously-bypass-approvals-and-sandbox \
	-o "$last_file" \
	-C "$host_cwd" \
	"$prompt" |
	tee "$host_jsonl"

# (c) The answer-only final message goes to <case>.codex.txt.
if [ ! -f "$last_file" ]; then
	die "codex exec produced no final message file"
fi
cp "$last_file" "$answer_txt"

# (d) Hard non-zero exit if either output is empty — an empty stream or empty
#     answer is a failed run, never silently accepted.
[ -s "$host_jsonl" ] || die "host JSONL stream is empty: $host_jsonl"
[ -s "$answer_txt" ] || die "codex answer is empty: $answer_txt"

printf 'run-codex-host: ok\n  jsonl:  %s\n  answer: %s\n' "$host_jsonl" "$answer_txt" >&2
