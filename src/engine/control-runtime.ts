import { readdir } from "node:fs/promises";
import path from "node:path";

import { readJson } from "./run-store";

export function createControlRuntime({
	runDir,
	rootController,
}: {
	runDir: string;
	rootController: AbortController;
}) {
	const active = new Map<string, any>();
	const stoppedAgents = new Set<string>();
	let paused = false;
	const seen = new Set<string>();
	let timer: Timer | null = null;

	async function refresh() {
		const dir = path.join(runDir, "control");
		const files = (await readdir(dir).catch(() => []))
			.filter((file) => file.endsWith(".json"))
			.sort();
		for (const file of files) {
			if (seen.has(file)) continue;
			seen.add(file);
			const command = await readJson(path.join(dir, file));
			if (command?.command) applyCommand(command);
		}
	}

	function applyCommand(command: any) {
		if (command.command === "stop-run") {
			rootController.abort(command.reason || "stop-run");
			return;
		}
		if (command.command === "pause-admission") {
			paused = true;
			return;
		}
		if (command.command === "resume-admission") {
			paused = false;
			return;
		}
		if (command.command === "stop-agent" && command.agentId) {
			stoppedAgents.add(command.agentId);
			const a = active.get(command.agentId);
			if (a) {
				a.stop = true;
				a.controller.abort(command.reason || "stop-agent");
			}
			return;
		}
		if (command.command === "restart-agent" && command.agentId) {
			const a = active.get(command.agentId);
			if (a) {
				a.restart = true;
				a.controller.abort(command.reason || "restart-agent");
			}
		}
	}

	function start() {
		if (timer) return;
		timer = setInterval(() => {
			refresh().catch(() => {});
		}, 500);
	}

	function stop() {
		if (timer) clearInterval(timer);
		timer = null;
	}

	async function beforeAdmission(agentId: string) {
		while (true) {
			const state = await checkAdmission(agentId);
			if (!state.paused) return state;
			await sleep(250);
		}
	}

	async function checkAdmission(agentId: string) {
		await refresh().catch(() => {});
		if (rootController.signal.aborted) return { ok: false, reason: "stop-run" };
		if (stoppedAgents.has(agentId)) return { ok: false, reason: "stop-agent" };
		if (paused) return { ok: false, paused: true, reason: "paused" };
		return { ok: true };
	}

	function registerAgent(agentId: string) {
		const controller = new AbortController();
		const state = {
			controller,
			restart: false,
			stop: stoppedAgents.has(agentId),
		};
		active.set(agentId, state);

		const abortFromRoot = () => controller.abort("stop-run");
		if (rootController.signal.aborted) abortFromRoot();
		else
			rootController.signal.addEventListener("abort", abortFromRoot, {
				once: true,
			});

		return {
			signal: controller.signal,
			shouldRestart: () => state.restart,
			unregister: () => {
				rootController.signal.removeEventListener("abort", abortFromRoot);
				active.delete(agentId);
			},
			wasStopped: () =>
				state.stop ||
				stoppedAgents.has(agentId) ||
				rootController.signal.aborted,
		};
	}

	return {
		start,
		stop,
		beforeAdmission,
		checkAdmission,
		registerAgent,
		refresh,
	};
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
