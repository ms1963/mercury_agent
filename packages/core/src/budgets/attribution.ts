/**
 * Budget attribution for auxiliary (system-principal) LLM calls.
 *
 * Summaries, team synthesis, wiki synthesis etc. run as the system principal, which is not
 * covered by user or '*' budget rules. When such a call happens on behalf of a user (inside
 * that user's agent run or team run), the user's principal is carried in async context so the
 * call is checked against — and charged to — that user's budget instead of escaping it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Principal } from '../types/common.js';

const store = new AsyncLocalStorage<Principal>();

/** Run `fn` with `principal` as the budget owner of any auxiliary LLM calls it triggers. */
export function withBudgetOwner<T>(principal: Principal, fn: () => T): T {
  if (principal.kind === 'system') return fn();
  return store.run(principal, fn);
}

/** The user on whose behalf the current async context runs, if any. */
export function currentBudgetOwner(): Principal | undefined {
  return store.getStore();
}
