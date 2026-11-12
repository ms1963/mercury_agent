/**
 * Deterministic offline decision provider (default when no API key is configured).
 * Uses keyword overlap plus Mercury's security heuristics so that routing, gating,
 * injection classification and triage behave sensibly in tests and demos.
 */
import { assessCommand } from '../security/commands.js';
import { scanForInjection } from '../security/injection.js';
import type { Answer, DecisionProvider, DecisionRequest, DecisionResult } from './types.js';
import { validateQuestions } from './types.js';

const words = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}

export class MockDecisionProvider implements DecisionProvider {
  readonly name = 'mock';
  available(): boolean {
    return true;
  }

  async decide(req: DecisionRequest): Promise<DecisionResult> {
    validateQuestions(req.questions);
    const stateText = typeof req.state === 'string' ? req.state : JSON.stringify(req.state);
    const stateWords = words(stateText);
    const answers: Record<string, Answer> = {};
    for (const [id, q] of Object.entries(req.questions)) {
      const instr = q.instructions.toLowerCase();
      if (q.type === 'noul') {
        let p = 0.5;
        if (/inject|manipulat|override/.test(instr)) p = Math.max(0.05, scanForInjection(stateText).score);
        else if (/dangerous|destructive|harm/.test(instr)) p = assessCommand(stateText).level === 'dangerous' ? 0.95 : 0.1;
        else if (/safe|intended|legitimate|approve/.test(instr)) {
          const injected = scanForInjection(stateText).score;
          const risk = assessCommand(stateText).level;
          p = risk === 'dangerous' ? 0.1 : injected > 0.4 ? 0.2 : risk === 'moderate' ? 0.75 : 0.92;
        } else if (/retry|escalate|insufficient|wrong/.test(instr)) p = /error|fail|unable|cannot|sorry/i.test(stateText) ? 0.8 : 0.2;
        else if (/skill|reusable/.test(instr)) p = /tool_calls["']?\s*:\s*([4-9]|\d{2,})/.test(stateText) ? 0.8 : 0.3;
        else p = Math.min(0.95, 0.3 + 0.1 * overlap(words(q.instructions), stateWords));
        answers[id] = { type: 'noul', noul: round(p) };
      } else if (q.type === 'choice') {
        const keys = Object.keys(q.criteria);
        const scores = keys.map((k) => 1 + overlap(words(`${k} ${q.criteria[k]}`), stateWords) * 2);
        const total = scores.reduce((a, b) => a + b, 0);
        const probabilities = Object.fromEntries(keys.map((k, i) => [k, round(scores[i]! / total)]));
        const best = keys[scores.indexOf(Math.max(...scores))]!;
        answers[id] = { type: 'choice', choice: best, confidence: probabilities[best], probabilities };
      } else {
        const n = q.criteria.length;
        const negative = /error|fail|unable|cannot|sorry|unknown/i.test(stateText);
        const level = negative ? Math.floor((n - 1) / 3) : Math.ceil(((n - 1) * 2) / 3);
        answers[id] = {
          type: 'score',
          score: level,
          confidence: 0.6,
          probabilities: Object.fromEntries(q.criteria.map((_, i) => [String(i), i === level ? 1 : 0])),
          legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), c])),
        };
      }
    }
    return { answers, provider: this.name, model: 'mock-decider', latencyMs: 0 };
  }
}

const round = (n: number) => Math.round(n * 1000) / 1000;
