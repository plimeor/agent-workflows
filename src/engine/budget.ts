// Token budget. Mirrors the Workflow `budget` global so scripts keep their shape. The
// configured `total` (from --budget) is honored as an advisory cap a script can read, but
// the harness reports no token usage (decision 003), so spent() stays 0 and the hard
// ceiling never fires; the per-run agent cap (MAX_AGENTS) is the runaway backstop.
// code-lean: budget enforcement is inert, upgrade when @plimeor/harness exposes run usage.
export function createBudget(total) {
	let spent = 0;
	const facadeTotal = typeof total === "number" && total > 0 ? total : null;
	return {
		get total() {
			return facadeTotal;
		},
		add(n) {
			spent += Number(n) || 0;
		},
		spent() {
			return spent;
		},
		remaining() {
			return facadeTotal == null ? Infinity : Math.max(0, facadeTotal - spent);
		},
	};
}
