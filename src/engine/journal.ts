// Resume journal. Content-addressed cache of agent() results keyed by sha(prompt + opts).
// On resume, an identical agent() call (same prompt + result-affecting opts) replays its
// cached result instantly; the first changed/new call and everything after it runs live.
// Content addressing is order-independent, which is required because pipeline()/parallel()
// start agent() calls concurrently — it delivers the same guarantee as the Workflow tool's
// "longest unchanged prefix": same script + same args ⇒ full cache hit.
import crypto from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { writeJsonAtomic } from "./atomic";

// Opts that affect the produced result (and therefore the cache key). Display-only opts
// like `label` and `phase` are excluded so relabeling does not bust the cache. Model/effort/
// sandbox/mcpPolicy are gone — the harness owns host execution (decision 003).
const KEY_OPTS = [
	"schema",
	"profile",
	"profileFingerprint",
	"profileSetVersion",
	"isolation",
];

export function agentKey(prompt, opts = {}) {
	const sig = { prompt };
	for (const k of KEY_OPTS) if (opts[k] !== undefined) sig[k] = opts[k];
	return crypto
		.createHash("sha256")
		.update(JSON.stringify(sig))
		.digest("hex")
		.slice(0, 32);
}

export function createJournal(prior, file = null) {
	// prior: { entries: [[key, [result, ...]]] } from a previous run, or null.
	const oldMap = new Map((prior?.entries || []).map(([k, v]) => [k, v]));
	const useCount = new Map();
	const newMap = new Map();

	// Synchronous: returns the cached result for the n-th occurrence of `key`, if present.
	function next(key) {
		const idx = useCount.get(key) || 0;
		useCount.set(key, idx + 1);
		const arr = oldMap.get(key);
		if (arr && idx < arr.length) return { hit: true, result: arr[idx] };
		return { hit: false, occurrence: idx };
	}

	let flushQueue = Promise.resolve();
	let sinceCheckpoint = 0;
	// Coalesce disk writes: record() updates memory synchronously and only checkpoints to disk
	// every N records (and saveJournal()/flush() forces a final write). This avoids serializing
	// every agent completion behind a full-file write — which was O(n²) bytes and blocked each
	// completion on disk I/O. A crash loses at most the records since the last checkpoint; resume
	// just re-runs those (it already re-runs whatever was in flight).
	// code-lean: fixed 32-record checkpoint, upgrade when crash-loss of recent agents matters.
	const CHECKPOINT_EVERY = 32;

	function record(key, result) {
		if (!newMap.has(key)) newMap.set(key, []);
		newMap.get(key).push(result);
		if (file && ++sinceCheckpoint >= CHECKPOINT_EVERY) {
			sinceCheckpoint = 0;
			flushQueue = flushQueue.then(() => writeJsonAtomic(file, serialize()));
		}
	}

	function serialize() {
		return { entries: [...newMap.entries()] };
	}

	async function flush() {
		if (!file) return;
		await flushQueue;
		await writeJsonAtomic(file, serialize());
	}

	return { next, record, serialize, flush };
}

export async function loadJournal(file) {
	try {
		return JSON.parse(await readFile(file, "utf8"));
	} catch {
		return null;
	}
}

export async function saveJournal(file, journal) {
	await mkdir(path.dirname(file), { recursive: true });
	if (journal.flush) await journal.flush();
	else await writeJsonAtomic(file, journal.serialize());
}
