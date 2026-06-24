export interface EvalCase {
	context: string;
	task: string;
}

export function renderNaturalPrompt(c: EvalCase): string {
	return `I need help with this:

${c.context}

Can you help me with this specific task?

${c.task}
`;
}

// A user-voice "trigger the workflow skill" prompt: it asks, in plain user language, to use a
// multi-agent workflow and orchestrate the task across subagents — using the agent-workflows
// skill's own trigger vocabulary ("use a workflow", "fan out", "orchestrate with subagents").
// It deliberately does NOT spell out the MCP protocol (lint/start_run/poll); the host agent
// drives that from the installed skill, exactly as a real user invoking the skill would.
export function renderForcedPrompt(c: EvalCase): string {
	return `Please use the agent-workflows workflow skill for this — I'd like you to orchestrate it
as a multi-agent workflow instead of answering in a single pass. Fan the work out across several
independent subagents, each covering a different aspect of the task, then have them adversarially
verify the findings before you synthesize the final answer for me.

Here's what I need help with:

${c.context}

The specific task:

${c.task}
`;
}
