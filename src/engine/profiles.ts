import crypto from "node:crypto";

export const PROFILE_SET_VERSION = "builtin-v1";

// Builtin personas. A profile contributes only a prompt preamble now: the host (harness)
// owns sandboxing and model selection, so a profile no longer carries a sandbox mode
// (decision 003).
export const BUILTIN_PROFILES = {
	mutator: {
		preamble:
			"Implement the requested code change with the smallest correct edit and report verification evidence.",
	},
	reviewer: {
		preamble: "Review code for correctness and regression risk.",
	},
	synthesizer: {
		preamble:
			"Synthesize findings into a concise decision, plan, or final report grounded in observed evidence.",
	},
	verifier: {
		preamble:
			"Verify behavior, commands, and regression evidence without making source edits.",
	},
} as const;

export function resolveProfile(
	opts: Record<string, any>,
	_ctx: Record<string, any>,
) {
	if (opts.agentType) {
		throw new Error(
			"agentType is not supported; use a builtin profile instead",
		);
	}

	const profileName = opts.profile || null;
	const profile = profileName
		? (BUILTIN_PROFILES as Record<string, any>)[profileName]
		: null;
	if (profileName && !profile) {
		throw new Error(
			`unknown profile '${profileName}' (builtin profiles: ${Object.keys(BUILTIN_PROFILES).join(", ")})`,
		);
	}

	const profileFingerprint = profileName
		? crypto
				.createHash("sha256")
				.update(
					JSON.stringify({
						name: profileName,
						version: PROFILE_SET_VERSION,
						profile,
					}),
				)
				.digest("hex")
				.slice(0, 16)
		: null;

	return {
		name: profileName,
		profile,
		preamble: profile?.preamble || "",
		profileFingerprint,
		profileSetVersion: PROFILE_SET_VERSION,
	};
}
