// Progress model + live status file. Phases are group boxes; log() lines are narrators;
// each agent shows a label and state. Mirrors the Workflow progress tree and `/workflows`
// live view via a status.json that `agent-workflows ps`/`watch` read.
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const ICON = {
	cached: "⤳",
	done: "✓",
	error: "✗",
	paused: "Ⅱ",
	queued: "·",
	running: "◐",
	stopped: "■",
};

export function createProgress({
	runDir,
	runId,
	name,
	quiet = false,
	phases: initialPhases = [],
} = {}) {
	let currentPhase = null;
	const phases = [...new Set(initialPhases.filter(Boolean))]; // preserves declaration order
	const agents = new Map(); // id -> { seq, label, phase, state, detail }
	const narration = [];
	let seqCounter = 0;
	const startedAt = Date.now();

	function ensurePhase(title) {
		if (title == null) return;
		if (!phases.includes(title)) phases.push(title);
	}

	function flush() {
		if (!runDir) return;
		try {
			mkdirSync(runDir, { recursive: true });
			const status = {
				runId,
				name,
				startedAt,
				updatedAt: Date.now(),
				currentPhase,
				phases,
				agents: [...agents.values()],
				narration: narration.slice(-50),
			};
			writeAtomicSync(
				path.join(runDir, "status.json"),
				JSON.stringify(status, null, 2),
			);
		} catch {
			/* status file is best-effort */
		}
	}

	function emit(line) {
		if (!quiet) process.stderr.write(`${line}\n`);
		// Persist a durable human-readable log alongside status.json (written even when quiet,
		// since the run dir is the record of the run). Best-effort.
		if (runDir) {
			try {
				appendFileSync(path.join(runDir, "progress.log"), `${line}\n`);
			} catch {
				/* progress.log is best-effort */
			}
		}
	}

	return {
		agentCached(idOrSeq, seqOrLabel, labelOrPhase, phaseMaybe) {
			const explicit = typeof idOrSeq === "string";
			const id = explicit ? idOrSeq : `a${++seqCounter}`;
			const seq = explicit ? seqOrLabel : idOrSeq;
			const label = explicit ? labelOrPhase : seqOrLabel;
			const phase = explicit ? phaseMaybe : labelOrPhase;
			ensurePhase(phase);
			agents.set(id, { id, seq, label, phase, state: "cached" });
			emit(`  ${ICON.cached} [${phase ?? "-"}] ${label} (cached)`);
			flush();
			return id;
		},
		agentEnd(id, state, detail) {
			const a = agents.get(id);
			if (!a) return;
			a.state = state;
			if (detail) a.detail = String(detail).slice(0, 120);
			emit(
				`  ${ICON[state] || "?"} [${a.phase ?? "-"}] ${a.label}${detail ? ` — ${String(detail).slice(0, 80)}` : ""}`,
			);
			flush();
		},
		agentQueued(id, seq, label, phase) {
			ensurePhase(phase);
			agents.set(id, { id, seq, label, phase, state: "queued" });
			emit(`  ${ICON.queued} [${phase ?? "-"}] ${label} (queued)`);
			flush();
			return id;
		},
		agentStart(idOrSeq, seqOrLabel, labelOrPhase, phaseMaybe) {
			const explicit = typeof idOrSeq === "string";
			const id = explicit ? idOrSeq : `a${++seqCounter}`;
			const seq = explicit ? seqOrLabel : idOrSeq;
			const label = explicit ? labelOrPhase : seqOrLabel;
			const phase = explicit ? phaseMaybe : labelOrPhase;
			ensurePhase(phase);
			agents.set(id, {
				...(agents.get(id) || {}),
				id,
				seq,
				label,
				phase,
				state: "running",
			});
			emit(`  ${ICON.running} [${phase ?? "-"}] ${label}`);
			flush();
			return id;
		},
		currentPhase: () => currentPhase,
		narrate(message) {
			narration.push({ t: Date.now() - startedAt, message });
			emit(`◆ ${message}`);
			flush();
		},
		nextSeq: () => ++seqCounter,
		setPhase(title) {
			currentPhase = title;
			ensurePhase(title);
			emit(`\n┌─ ${title}`);
			flush();
		},
		flush,
		summary() {
			const all = [...agents.values()];
			return {
				agents: all.length,
				cached: all.filter((a) => a.state === "cached").length,
				done: all.filter((a) => a.state === "done").length,
				elapsedMs: Date.now() - startedAt,
				errored: all.filter((a) => a.state === "error").length,
				stopped: all.filter((a) => a.state === "stopped").length,
			};
		},
	};
}

function writeAtomicSync(file, text) {
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	writeFileSync(tmp, text);
	renameSync(tmp, file);
}
