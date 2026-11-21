/**
 * Pure (offline, deterministic) helpers for distilling and matching skills. No LLM, no DB:
 * these functions turn a concrete run trace into a parameterized step sequence and compute the
 * token-overlap similarity used for intent matching and dedup. Kept pure so they are trivially
 * testable and never break a run.
 */
import type { RecordedToolCall } from '../reliability/regression.js';
import type { SkillParam, SkillStep } from './ports.js';

/** Lower-cased alphanumeric token set (>=3 chars), capped — cheap similarity (mirrors learning). */
export function tokens(text: string): Set<string> {
  return new Set(
    (text || '')
      .toLowerCase()
      .split(/[^\p{L}\p{N}_]+/u)
      .filter((w) => w.length >= 3)
      .slice(0, 200),
  );
}

/** Jaccard overlap of two token sets (0..1). */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Similarity between two free-text intents (0..1). */
export function triggerSimilarity(a: string, b: string): number {
  return Math.round(jaccard(tokens(a), tokens(b)) * 1e4) / 1e4;
}

/** Derive a stable kebab-case skill name from a task description + the tools it used. */
export function deriveSkillName(trigger: string, toolNames: string[]): string {
  const base = (trigger || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    .slice(0, 4)
    .join('-');
  const tool = (toolNames[0] ?? 'skill').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const name = base || tool;
  return `auto-${name}`.slice(0, 60);
}

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'please', 'can', 'you', 'then', 'into', 'what', 'how']);

/** Infer a parameter slot's type from an observed concrete value. */
function paramType(v: unknown): SkillParam['type'] {
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (v && typeof v === 'object') return 'object';
  return 'string';
}

export interface Generalized {
  steps: SkillStep[];
  params: SkillParam[];
}

/**
 * Generalize a concrete tool-call sequence into a parameterized step sequence: each distinct
 * scalar argument value becomes a `{slot}` parameter, so the same proven path can be re-run with
 * new inputs. Identical values across calls collapse to the same slot. Deterministic.
 */
export function generalizeToolCalls(calls: RecordedToolCall[]): Generalized {
  const params: SkillParam[] = [];
  const slotFor = new Map<string, string>(); // stringified value → slot name
  const steps: SkillStep[] = [];

  for (const call of calls) {
    const srcArgs = (call.args && typeof call.args === 'object' ? call.args : {}) as Record<string, unknown>;
    const args: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(srcArgs)) {
      // Only generalize scalar values; keep structured/empty values literal.
      if ((typeof value === 'string' && value.trim() !== '') || typeof value === 'number' || typeof value === 'boolean') {
        const vkey = `${typeof value}:${String(value)}`;
        let slot = slotFor.get(vkey);
        if (!slot) {
          slot = uniqueSlot(key, params);
          slotFor.set(vkey, slot);
          params.push({ name: slot, type: paramType(value), example: String(value).slice(0, 120) });
        }
        args[key] = `{${slot}}`;
      } else {
        args[key] = value;
      }
    }
    steps.push({ tool: String(call.name || ''), args });
  }
  return { steps, params };
}

function uniqueSlot(key: string, params: SkillParam[]): string {
  const base = (key || 'arg').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'arg';
  if (!params.some((p) => p.name === base)) return base;
  let i = 2;
  while (params.some((p) => p.name === `${base}_${i}`)) i++;
  return `${base}_${i}`;
}

/** Fill a step's `{slot}` templates from a params map (used when reusing a proven path). */
export function fillStep(step: SkillStep, values: Record<string, unknown>): SkillStep {
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(step.args)) {
    if (typeof v === 'string') {
      args[k] = v.replace(/\{(\w+)\}/g, (_, slot: string) => (slot in values ? String(values[slot]) : `{${slot}}`));
    } else {
      args[k] = v;
    }
  }
  return { tool: step.tool, args };
}
