/**
 * Layered guardrails around the agent:
 *
 *  1. Input layer  — heuristic injection scan on every inbound message; content from
 *     untrusted sources (mail, webhooks, unknown chat users) or heuristically suspicious
 *     text is additionally classified by the decision engine (Jev/LLM/mock).
 *  2. Context layer — untrusted content is spotlighted (see security/injection.ts) and
 *     the instruction hierarchy is stated in the system prompt.
 *  3. Action layer — ToolExecutor gates sensitive tool calls derived from untrusted input.
 *  4. Output layer — secret redaction, optional PII redaction, system-prompt canary leak check.
 */
import { randomBytes } from 'node:crypto';
import type { MercuryConfig } from '../config/schema.js';
import type { Judgment } from '../decision/judgment.js';
import type { EventBus } from '../events/bus.js';
import { redactPii, redactSecrets } from '../security/redact.js';
import { scanForInjection } from '../security/injection.js';
import type { TrustLevel } from '../types/messages.js';

export interface InputVerdict {
  blocked: boolean;
  suspicious: boolean;
  heuristicScore: number;
  classifierScore?: number;
  reasons: string[];
}

export class Guardrails {
  /** Random marker placed in the system prompt; if it shows up in output, the prompt leaked. */
  readonly canary = `MRC-CANARY-${randomBytes(6).toString('hex')}`;

  constructor(
    private config: MercuryConfig,
    private judgment: Judgment | undefined,
    private bus: EventBus,
  ) {}

  async checkInput(text: string, trust: TrustLevel, runId?: string): Promise<InputVerdict> {
    const cfg = this.config.security.injection;
    if (!cfg.enabled || !text.trim()) return { blocked: false, suspicious: false, heuristicScore: 0, reasons: [] };
    const scan = scanForInjection(text);
    const verdict: InputVerdict = { blocked: false, suspicious: scan.suspicious, heuristicScore: scan.score, reasons: scan.matches };
    if (trust === 'untrusted' || scan.suspicious) {
      const p = await this.judgment?.classifyInjection(text, runId);
      if (p !== undefined) {
        verdict.classifierScore = p;
        verdict.suspicious = verdict.suspicious || p >= this.config.decision.thresholds.injection;
      }
    }
    // Only untrusted content (or explicit config) is blocked; the authenticated user is warned, not censored.
    verdict.blocked = verdict.suspicious && (trust === 'untrusted' ? true : cfg.blockInput);
    if (verdict.suspicious) this.bus.emit({ type: 'guardrail', runId, data: { layer: 'input', trust, ...verdict } });
    return verdict;
  }

  checkOutput(text: string, runId?: string): { text: string; redactions: number; leaked: boolean } {
    let out = text;
    let redactions = 0;
    const leaked = out.includes(this.canary);
    if (leaked) out = out.split(this.canary).join('[redacted]');
    if (this.config.security.redactSecrets) {
      const r = redactSecrets(out);
      out = r.text;
      redactions += r.found.length;
    }
    if (this.config.security.redactPiiInOutput) {
      const r = redactPii(out);
      out = r.text;
      redactions += r.found.length;
    }
    if (redactions || leaked) this.bus.emit({ type: 'guardrail', runId, data: { layer: 'output', redactions, leaked } });
    return { text: out, redactions, leaked };
  }
}
