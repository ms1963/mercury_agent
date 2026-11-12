/**
 * Utility tools (toolset "utility"): calculator, time/date, unit conversion, text
 * helpers (regex, diff, stats, hash, base64, uuid) and a per-session todo list.
 */
import { createHash, randomUUID } from 'node:crypto';
import { defineTool, type AnyTool } from '@mercury/core';
import { arr, num, params, str, strEnum } from '../util.js';

/** Safe arithmetic evaluator (recursive descent; no eval). Supports + - * / % ^, parens, functions, pi/e. */
export function evaluate(expr: string): number {
  const src = expr.replace(/\s+/g, '').replace(/\*\*/g, '^');
  let i = 0;
  const FUNCS: Record<string, (x: number) => number> = {
    sqrt: Math.sqrt, abs: Math.abs, sin: Math.sin, cos: Math.cos, tan: Math.tan, log: Math.log10, ln: Math.log,
    exp: Math.exp, floor: Math.floor, ceil: Math.ceil, round: Math.round,
  };
  const peek = () => src[i];
  const expect = (c: string) => {
    if (src[i] !== c) throw new Error(`expected "${c}" at position ${i}`);
    i++;
  };
  function primary(): number {
    if (peek() === '(') {
      i++;
      const v = additive();
      expect(')');
      return v;
    }
    if (peek() === '-') {
      i++;
      return -power();
    }
    if (peek() === '+') {
      i++;
      return power();
    }
    const num = /^\d*\.?\d+(e[+-]?\d+)?/i.exec(src.slice(i));
    if (num) {
      i += num[0].length;
      return Number(num[0]);
    }
    const id = /^[a-z]+/i.exec(src.slice(i));
    if (id) {
      i += id[0].length;
      const name = id[0].toLowerCase();
      if (name === 'pi') return Math.PI;
      if (name === 'e') return Math.E;
      const f = FUNCS[name];
      if (!f) throw new Error(`unknown function ${name}`);
      expect('(');
      const v = additive();
      expect(')');
      return f(v);
    }
    throw new Error(`unexpected "${peek() ?? 'end'}" at position ${i}`);
  }
  function power(): number {
    const base = primary();
    if (peek() === '^') {
      i++;
      return base ** power();
    }
    return base;
  }
  function multiplicative(): number {
    let v = power();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = src[i++];
      const r = power();
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  }
  function additive(): number {
    let v = multiplicative();
    while (peek() === '+' || peek() === '-') v = src[i++] === '+' ? v + multiplicative() : v - multiplicative();
    return v;
  }
  const v = additive();
  if (i < src.length) throw new Error(`unexpected "${src[i]}" at position ${i}`);
  return v;
}

export const calculator = defineTool<{ expression: string }>({
  name: 'calculator',
  description: 'Evaluate an arithmetic expression exactly, e.g. "(3+4)*2^3", "sqrt(2)", "17 % 5".',
  toolset: 'utility',
  risk: 'safe',
  parameters: params({ expression: str('Expression') }, ['expression']),
  async execute(a) {
    return String(evaluate(a.expression));
  },
});

export const currentTime = defineTool<{ timezone?: string }>({
  name: 'current_time',
  description: 'Current date and time, optionally in an IANA time zone (e.g. Europe/Berlin).',
  toolset: 'utility',
  risk: 'safe',
  parameters: params({ timezone: str('IANA time zone') }),
  async execute(a) {
    const now = new Date();
    const local = now.toLocaleString('en-GB', { timeZone: a.timezone, dateStyle: 'full', timeStyle: 'long' });
    return `${local} (ISO ${now.toISOString()})`;
  },
});

export const dateCalc = defineTool<{ date?: string; add?: number; unit?: string; until?: string }>({
  name: 'date_calc',
  description: 'Date arithmetic: add N days/weeks/months/years to a date, or compute days between date and until.',
  toolset: 'utility',
  risk: 'safe',
  parameters: params({ date: str('Start date (ISO, default today)'), add: num('Amount to add (negative to subtract)'), unit: strEnum(['days', 'weeks', 'months', 'years'], 'Unit'), until: str('Second date for a difference') }),
  async execute(a) {
    const d = a.date ? new Date(a.date) : new Date();
    if (Number.isNaN(d.getTime())) throw new Error(`invalid date ${a.date}`);
    if (a.until) {
      const days = Math.round((new Date(a.until).getTime() - d.getTime()) / 86_400_000);
      return `${days} days`;
    }
    const n = a.add ?? 0;
    if (a.unit === 'months') d.setMonth(d.getMonth() + n);
    else if (a.unit === 'years') d.setFullYear(d.getFullYear() + n);
    else d.setDate(d.getDate() + n * (a.unit === 'weeks' ? 7 : 1));
    return `${d.toISOString().slice(0, 10)} (${d.toLocaleDateString('en-GB', { weekday: 'long' })})`;
  },
});

const UNITS: Record<string, [string, number]> = {
  m: ['length', 1], km: ['length', 1000], cm: ['length', 0.01], mm: ['length', 0.001], mi: ['length', 1609.344], ft: ['length', 0.3048], in: ['length', 0.0254], yd: ['length', 0.9144],
  kg: ['mass', 1], g: ['mass', 0.001], lb: ['mass', 0.45359237], oz: ['mass', 0.028349523],
  l: ['volume', 1], ml: ['volume', 0.001], gal: ['volume', 3.785411784],
  s: ['time', 1], min: ['time', 60], h: ['time', 3600], day: ['time', 86400],
  b: ['data', 1], kb: ['data', 1024], mb: ['data', 1024 ** 2], gb: ['data', 1024 ** 3], tb: ['data', 1024 ** 4],
};

export function convertUnit(value: number, from: string, to: string): number {
  const f = from.toLowerCase();
  const t = to.toLowerCase();
  const temps: Record<string, (v: number) => number> = { 'c>f': (v) => v * 1.8 + 32, 'f>c': (v) => (v - 32) / 1.8, 'c>k': (v) => v + 273.15, 'k>c': (v) => v - 273.15 };
  if (temps[`${f}>${t}`]) return temps[`${f}>${t}`]!(value);
  const a = UNITS[f];
  const b = UNITS[t];
  if (!a || !b || a[0] !== b[0]) throw new Error(`cannot convert ${from} to ${to}`);
  return (value * a[1]) / b[1];
}

export const unitConvert = defineTool<{ value: number; from: string; to: string }>({
  name: 'unit_convert',
  description: 'Convert between units (length, mass, volume, time, data, temperature C/F/K).',
  toolset: 'utility',
  risk: 'safe',
  parameters: params({ value: num('Value'), from: str('From unit, e.g. km'), to: str('To unit, e.g. mi') }, ['value', 'from', 'to']),
  async execute(a) {
    return `${a.value} ${a.from} = ${Number(convertUnit(a.value, a.from, a.to).toPrecision(10))} ${a.to}`;
  },
});

export const regexExtract = defineTool<{ text: string; pattern: string; flags?: string }>({
  name: 'regex_extract',
  description: 'Extract all regex matches (with capture groups) from text.',
  toolset: 'utility',
  risk: 'safe',
  parameters: params({ text: str('Input text'), pattern: str('Regular expression'), flags: str('Flags, e.g. "i"') }, ['text', 'pattern']),
  async execute(a) {
    const re = new RegExp(a.pattern, (a.flags ?? '').replace('g', '') + 'g');
    const matches = [...a.text.matchAll(re)].slice(0, 200).map((m) => (m.length > 1 ? m.slice(1) : m[0]));
    return JSON.stringify(matches);
  },
});

/** Line-based diff (LCS) in unified-ish format. */
export function lineDiff(a: string, b: string): string {
  const x = a.split('\n');
  const y = b.split('\n');
  const dp = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { out.push(`  ${x[i]}`); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push(`- ${x[i++]}`);
    else out.push(`+ ${y[j++]}`);
  }
  while (i < x.length) out.push(`- ${x[i++]}`);
  while (j < y.length) out.push(`+ ${y[j++]}`);
  return out.join('\n');
}

export const textDiff = defineTool<{ a: string; b: string }>({
  name: 'text_diff',
  description: 'Line-by-line diff of two texts (- removed, + added).',
  toolset: 'utility',
  risk: 'safe',
  parameters: params({ a: str('Original text'), b: str('New text') }, ['a', 'b']),
  async execute(a) {
    if (a.a.length + a.b.length > 400_000) throw new Error('texts too large to diff');
    return lineDiff(a.a, a.b);
  },
});

export const textStats = defineTool<{ text: string }>({
  name: 'text_stats',
  description: 'Count characters, words, lines and estimated tokens of a text.',
  toolset: 'utility',
  risk: 'safe',
  parameters: params({ text: str('Text') }, ['text']),
  async execute(a) {
    const words = a.text.trim() ? a.text.trim().split(/\s+/).length : 0;
    return JSON.stringify({ chars: a.text.length, words, lines: a.text.split('\n').length, tokens: Math.ceil(a.text.length / 4) });
  },
});

export const hashText = defineTool<{ text: string; algorithm?: string }>({
  name: 'hash_text',
  description: 'Hash text with sha256 (default), sha1, sha512 or md5.',
  toolset: 'utility',
  risk: 'safe',
  parameters: params({ text: str('Text'), algorithm: strEnum(['sha256', 'sha1', 'sha512', 'md5'], 'Algorithm') }, ['text']),
  async execute(a) {
    return createHash(a.algorithm ?? 'sha256').update(a.text).digest('hex');
  },
});

export const base64Tool = defineTool<{ text: string; mode: 'encode' | 'decode' }>({
  name: 'base64',
  description: 'Base64 encode or decode text.',
  toolset: 'utility',
  risk: 'safe',
  parameters: params({ text: str('Input'), mode: strEnum(['encode', 'decode'], 'Mode') }, ['text', 'mode']),
  async execute(a) {
    return a.mode === 'encode' ? Buffer.from(a.text).toString('base64') : Buffer.from(a.text, 'base64').toString('utf8');
  },
});

export const uuidTool = defineTool<{ count?: number }>({
  name: 'uuid',
  description: 'Generate random UUIDs.',
  toolset: 'utility',
  risk: 'safe',
  parameters: params({ count: num('How many (default 1)') }),
  async execute(a) {
    return Array.from({ length: Math.min(a.count ?? 1, 50) }, () => randomUUID()).join('\n');
  },
});

/** Per-session todo list kept in memory (Hermes `todo`). */
const todos = new Map<string, Array<{ text: string; done: boolean }>>();

export const todoTool = defineTool<{ action: 'add' | 'done' | 'list' | 'clear'; items?: string[]; index?: number }>({
  name: 'todo',
  description: 'Manage a task list for the current session: add items, mark one done (1-based index), list or clear.',
  toolset: 'utility',
  risk: 'safe',
  parameters: params({ action: strEnum(['add', 'done', 'list', 'clear'], 'Action'), items: arr(str('item'), 'Items to add'), index: num('Item number for done') }, ['action']),
  async execute(a, ctx) {
    const key = ctx.sessionId ?? ctx.principal.userId;
    const list = todos.get(key) ?? [];
    if (a.action === 'add') list.push(...(a.items ?? []).map((text) => ({ text, done: false })));
    if (a.action === 'done' && a.index && list[a.index - 1]) list[a.index - 1]!.done = true;
    if (a.action === 'clear') list.length = 0;
    todos.set(key, list);
    return list.map((t, i) => `${i + 1}. [${t.done ? 'x' : ' '}] ${t.text}`).join('\n') || '(empty)';
  },
});

export const utilityTools: AnyTool[] = [calculator, currentTime, dateCalc, unitConvert, regexExtract, textDiff, textStats, hashText, base64Tool, uuidTool, todoTool];
