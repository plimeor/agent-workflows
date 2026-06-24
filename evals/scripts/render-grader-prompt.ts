#!/usr/bin/env bun
import { readFileSync } from "node:fs";

const [caseFile, rubricFile, answerFile] = process.argv.slice(2);
if (!caseFile || !rubricFile || !answerFile) {
	throw new Error(
		"usage: bun evals/scripts/render-grader-prompt.ts <case.json> <rubric.json> <answer.txt>",
	);
}

const c = JSON.parse(readFileSync(caseFile, "utf8"));
const rubric = JSON.parse(readFileSync(rubricFile, "utf8"));
const answer = readFileSync(answerFile, "utf8");

process.stdout.write(`# Eval Grader: ${c.title}

You are grading one model answer against a hidden rubric. The answer was produced from the
case task and context only. Grade the answer, not the prompt style.

Return exactly one JSON object with this shape:

\`\`\`json
{
  "title": "case title",
  "rubricResults": [
    {
      "criterion": "rubric item",
      "status": "met|partial|missed",
      "evidence": "short quote or paraphrase from the answer",
      "notes": "why this status was assigned"
    }
  ],
  "quality": {
    "evidenceGrounding": "1-5",
    "actionability": "1-5",
    "scopeControl": "1-5",
    "assumptionDiscipline": "1-5",
    "uncertaintyCalibration": "1-5"
  },
  "overall": {
    "met": 0,
    "partial": 0,
    "missed": 0,
    "summary": "concise grading summary",
    "mainGaps": ["gap"]
  }
}
\`\`\`

Rules:
- Use only the case, rubric, and answer below.
- Do not reward claims that are not supported by the provided answer.
- Treat a criterion as "met" only when the answer covers the core requirement clearly enough to act on.
- Treat a criterion as "partial" when the answer gestures at the issue but misses an important condition, boundary, or execution detail.
- Treat a criterion as "missed" when the answer does not cover the requirement.
- Quality scores are strings from "1" to "5", where "5" is best.

## Case Task

${c.task}

## Case Context

${c.context}

## Hidden Rubric

${rubric.gradingCriteria.map((item: string) => `- ${item}`).join("\n")}

## Answer To Grade

${answer}
`);
