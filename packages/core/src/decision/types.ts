/**
 * Typed decision primitives modelled on Jev ("System One" decision model by TypeSafe AI):
 *   choice — pick one of up to 255 options, with confidence and probabilities
 *   noul   — Bernoulli yes/no, probability of "yes" in [0,1]
 *   score  — ordinal rubric of 2..10 levels, probability-weighted position
 */

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  /** option key → description of when to choose it */
  criteria: Record<string, string>;
}

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true?: string; false?: string };
}

export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  /** Level descriptions ordered lowest (index 0) → highest. 2..10 entries. */
  criteria: string[];
}

export type Question = ChoiceQuestion | NoulQuestion | ScoreQuestion;

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

export interface NoulAnswer {
  type: 'noul';
  noul: number;
}

export interface ScoreAnswer {
  type: 'score';
  score: number;
  probabilities?: Record<string, number>;
  legend?: Record<string, string>;
  confidence?: number;
}

export type Answer = ChoiceAnswer | NoulAnswer | ScoreAnswer;

export interface DecisionRequest {
  /** What the questions are about (text or JSON object). */
  state: unknown;
  questions: Record<string, Question>;
  /** Why we ask (routing, tool_gate, injection, triage, reflection...) — for logging/calibration. */
  purpose?: string;
  runId?: string;
}

export interface DecisionResult {
  answers: Record<string, Answer>;
  provider: string;
  model?: string;
  latencyMs: number;
  cost?: number;
  /** Id of the logged decision (for calibration via recordOutcome). */
  id?: string;
}

export interface DecisionProvider {
  readonly name: string;
  available(): boolean;
  decide(req: DecisionRequest): Promise<DecisionResult>;
}

/** Validate question shapes against Jev limits. Throws on invalid input. */
export function validateQuestions(questions: Record<string, Question>): void {
  for (const [id, q] of Object.entries(questions)) {
    if (!q.instructions) throw new Error(`question ${id}: instructions required`);
    if (q.type === 'choice') {
      const n = Object.keys(q.criteria ?? {}).length;
      if (n < 2 || n > 255) throw new Error(`question ${id}: choice needs 2..255 options (got ${n})`);
    }
    if (q.type === 'score' && (q.criteria.length < 2 || q.criteria.length > 10)) {
      throw new Error(`question ${id}: score needs 2..10 levels (got ${q.criteria.length})`);
    }
  }
}

/** Normalised 0..1 position of a score answer on its scale. */
export function scoreFraction(a: ScoreAnswer, levels: number): number {
  return levels > 1 ? Math.max(0, Math.min(1, a.score / (levels - 1))) : 0;
}
