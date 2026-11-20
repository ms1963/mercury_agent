/** Small shared types and helpers used across the code base. */
import { randomUUID } from 'node:crypto';

export type UserRole = 'admin' | 'user';

/** The authenticated actor on whose behalf something runs. */
export interface Principal {
  userId: string;
  username: string;
  role: UserRole;
  /** 'api_client' when authenticated by an API token. */
  kind: 'user' | 'api_client' | 'system';
  /** Token scopes (API tokens). `['*']` for interactive users. */
  scopes: string[];
}

export const SYSTEM_PRINCIPAL: Principal = {
  userId: 'system',
  username: 'system',
  role: 'admin',
  kind: 'system',
  scopes: ['*'],
};

export function newId(prefix = ''): string {
  const id = randomUUID().replace(/-/g, '').slice(0, 20);
  return prefix ? `${prefix}_${id}` : id;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Base error type with an optional help topic for user-facing messages. */
export class MercuryError extends Error {
  constructor(
    message: string,
    readonly code: string = 'error',
    readonly helpTopic?: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'MercuryError';
  }
}

export class PermissionDeniedError extends MercuryError {
  constructor(message: string) {
    super(message, 'permission_denied', 'security', 403);
  }
}

export class BudgetExceededError extends MercuryError {
  constructor(message: string) {
    super(message, 'budget_exceeded', 'budgets', 429);
  }
}

export class NotFoundError extends MercuryError {
  constructor(message: string, helpTopic?: string) {
    super(message, 'not_found', helpTopic, 404);
  }
}

/**
 * A per-task hard budget (cost and/or tokens) was exceeded. Unlike
 * {@link BudgetExceededError} (per user/model/period), this halts/escalates the
 * specific running task rather than a recurring quota. Carries the offending task id.
 */
export class TaskBudgetExceededError extends BudgetExceededError {
  constructor(message: string, readonly taskId: string) {
    super(message);
    this.name = 'TaskBudgetExceededError';
  }
}

/**
 * A sensitive action needed a capability grant that was absent, expired or revoked,
 * or was blocked by policy-as-code. Distinct from {@link PermissionDeniedError}
 * (static RBAC/ABAC): this is a dynamic, time-limited/least-privilege denial.
 */
export class GrantDeniedError extends MercuryError {
  constructor(message: string) {
    super(message, 'grant_denied', 'security', 403);
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Rough token estimate (~4 chars/token) used for budgets and compression thresholds. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    });
  });
}

/** Run promises with bounded concurrency, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Simple counting semaphore. */
export class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;
  constructor(readonly max: number) {}
  async acquire(): Promise<() => void> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    return () => {
      this.active--;
      this.queue.shift()?.();
    };
  }
  get inUse(): number {
    return this.active;
  }
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

export function safeJsonParse<T = unknown>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** Extract the first JSON object/array from text (LLMs often wrap JSON in prose or fences). */
export function extractJson<T = unknown>(text: string): T | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const direct = safeJsonParse<T>(c.trim());
    if (direct !== undefined) return direct;
    const start = c.search(/[[{]/);
    if (start < 0) continue;
    const open = c[start];
    const close = open === '{' ? '}' : ']';
    const end = c.lastIndexOf(close);
    if (end > start) {
      const parsed = safeJsonParse<T>(c.slice(start, end + 1));
      if (parsed !== undefined) return parsed;
    }
  }
  return undefined;
}
