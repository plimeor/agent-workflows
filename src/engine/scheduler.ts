// Concurrency semaphore. Mirrors the Workflow cap of min(16, cores - 2) concurrent
// agents; excess agent() calls queue and run as slots free.
import os from "node:os";

export const HARD_CONCURRENCY_CAP = 16;

export function defaultConcurrency() {
	const cores = os.cpus()?.length || 4;
	return Math.max(1, Math.min(HARD_CONCURRENCY_CAP, cores - 2));
}

export function clampConcurrency(
	value: unknown,
	fallback = defaultConcurrency(),
) {
	if (value == null || value === "") return fallback;
	const n = Number(value);
	if (!Number.isFinite(n)) {
		throw new Error(
			`concurrency must be a finite number (got ${String(value)})`,
		);
	}
	return Math.min(HARD_CONCURRENCY_CAP, Math.max(1, Math.floor(n)));
}

export function createSemaphore(limit: unknown) {
	const max = clampConcurrency(limit);
	let active = 0;
	const waiters: Array<() => void> = [];

	function acquire() {
		if (active < max) {
			active++;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => waiters.push(resolve));
	}

	function release() {
		const next = waiters.shift();
		if (next) {
			// Slot transferred directly to the next waiter; active count unchanged.
			next();
		} else {
			active--;
		}
	}

	async function run(fn: () => Promise<unknown>) {
		await acquire();
		try {
			return await fn();
		} finally {
			release();
		}
	}

	return {
		run,
		limit: max,
		get active() {
			return active;
		},
		get queued() {
			return waiters.length;
		},
	};
}
