// FIXED 1-AGENT BASELINE CONTROL — not the symmetric/natural Codex run of a fair
// comparison. The run body is a single agent() call forced through the 'synthesizer'
// profile with a prescribed FINAL_SCHEMA output shape: Codex acts only as a fixed
// single-agent leaf worker, never the decider. Kept as the explicit baseline control.
export const meta = {
  name: 'fixed-1-agent-baseline',
  description: 'FIXED 1-agent baseline control: one agent() call forced through the synthesizer profile with a prescribed FINAL_SCHEMA output shape — not the symmetric/natural Codex run of a fair comparison',
  phases: [{ title: 'Solve', detail: 'answer the case from the raw evidence packet' }],
}

const input = args && typeof args === 'object' ? args : {}
const title = String(input.title || 'Untitled eval')
const task = String(input.task || 'Analyze the case and produce a recommendation.')
const context = String(input.context || '')

const FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['claim', 'evidence', 'impact', 'recommendation', 'confidence'],
  properties: {
    claim: { type: 'string' },
    evidence: { type: 'string' },
    impact: { type: 'string' },
    recommendation: { type: 'string' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
}

const FINAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answer', 'topFindings', 'recommendedActions', 'confidence', 'openQuestions'],
  properties: {
    answer: { type: 'string' },
    topFindings: { type: 'array', minItems: 3, maxItems: 7, items: FINDING_SCHEMA },
    recommendedActions: { type: 'array', minItems: 3, maxItems: 8, items: { type: 'string' } },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    openQuestions: { type: 'array', maxItems: 6, items: { type: 'string' } },
  },
}

phase('Solve')
const final = await agent(
  [
    `You are evaluating a case.`,
    ``,
    `CASE: ${title}`,
    ``,
    `TASK:`,
    task,
    ``,
    `CASE CONTEXT:`,
    context,
    ``,
    `Rules:`,
    `- Use only the case context; do not browse or assume unstated facts.`,
    `- Do not edit files.`,
    `- Ground each top finding in concrete evidence from the case context.`,
    `- Convert the answer into executable next actions.`,
    `- Include calibrated confidence and the most important unanswered questions.`,
  ].join('\n'),
  {
    label: 'eval:solve',
    phase: 'Solve',
    profile: 'synthesizer',
    schema: FINAL_SCHEMA,
  }
)

return {
  title,
  final,
}
