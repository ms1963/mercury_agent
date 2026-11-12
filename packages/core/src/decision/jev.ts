/**
 * Jev decision provider — OpenRouter Decisions API.
 *
 *   POST https://openrouter.ai/api/alpha/decisions
 *   { "model": "typesafe/jev-1.13", "state": <string|object>, "questions": { id: Question } }
 *   → { "model": "...", "answers": { id: Answer }, "usage": { input_tokens, output_tokens, cost }, "id": "...", "provider": "TypeSafe" }
 *
 * Retries 429, 5xx and the transient in-flight-budget 402 (honouring Retry-After);
 * other errors fail immediately so the engine can fall back to the LLM provider.
 */
import { sleep } from '../types/common.js';
import type { Answer, DecisionProvider, DecisionRequest, DecisionResult } from './types.js';
import { validateQuestions } from './types.js';

export interface JevOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

export class JevDecisionProvider implements DecisionProvider {
  readonly name = 'jev';
  private model: string;
  private baseUrl: string;
  private fetchImpl: typeof fetch;

  constructor(private opts: JevOptions) {
    this.model = opts.model ?? 'typesafe/jev-1.13';
    this.baseUrl = (opts.baseUrl ?? 'https://openrouter.ai/api/alpha').replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  available(): boolean {
    return !!this.opts.apiKey;
  }

  async decide(req: DecisionRequest): Promise<DecisionResult> {
    validateQuestions(req.questions);
    const started = Date.now();
    const body = JSON.stringify({ model: this.model, state: req.state, questions: req.questions });
    const attempts = this.opts.maxAttempts ?? 3;
    for (let attempt = 1; ; attempt++) {
      const res = await this.fetchImpl(`${this.baseUrl}/decisions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.opts.apiKey}`, 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
      });
      const text = await res.text();
      if (res.ok) return this.parse(text, started);
      const transient = res.status === 429 || res.status >= 500 || (res.status === 402 && text.includes('openrouter_in_flight_budget'));
      if (!transient || attempt >= attempts) throw new Error(`Jev decisions ${res.status}: ${text.slice(0, 300)}`);
      const retryAfter = Number(res.headers.get('retry-after')) * 1000;
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : Math.min(8000, 500 * 2 ** attempt));
    }
  }

  private parse(text: string, started: number): DecisionResult {
    const json = JSON.parse(text) as { model?: string; answers?: Record<string, Answer>; usage?: { cost?: number } };
    if (!json.answers || typeof json.answers !== 'object') throw new Error('Jev response missing answers');
    for (const [id, a] of Object.entries(json.answers)) {
      if (a.type === 'noul' && (typeof a.noul !== 'number' || a.noul < 0 || a.noul > 1)) throw new Error(`Jev answer ${id}: invalid noul`);
      if (a.type === 'choice' && typeof a.choice !== 'string') throw new Error(`Jev answer ${id}: invalid choice`);
      if (a.type === 'score' && typeof a.score !== 'number') throw new Error(`Jev answer ${id}: invalid score`);
    }
    return { answers: json.answers, provider: this.name, model: json.model ?? this.model, latencyMs: Date.now() - started, cost: json.usage?.cost };
  }
}
