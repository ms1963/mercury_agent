/**
 * Automatic provider/model fallback chain + criteria-based model selection.
 *
 * Translates the proven Hermes Agent pattern into Mercury's TypeScript (Hermes is a Python
 * reference design only — nothing is imported from it):
 *
 *  - {@link isFallbackError} — the ONE centralized place (Mercury's equivalent of Hermes's
 *    `error_classifier`) that decides whether a failure means the current (provider, model) is
 *    UNAVAILABLE and the service should advance to the next entry in the chain. Every call site
 *    consults this helper instead of re-doing ad-hoc string matching.
 *  - {@link getFallbackChain} — the effective ordered, identity-deduped list of
 *    "<provider>/<model>" ids from `llm.fallback` (Hermes's `get_fallback_chain`).
 *  - {@link selectModelByCriteria} — picks the most appropriate (provider, model) for a request
 *    from `llm.routing`, matching the request's criteria (profile tags) against each entry's
 *    criteria, with an empty-or-`['default']` catch-all.
 *
 * All of this is pure and offline-testable; the wiring lives in {@link LLMService}.
 */
import type { MercuryConfig } from '../config/schema.js';
import { MercuryError, errorMessage } from '../types/common.js';
import { ProviderError } from './provider.js';

/** Build the "<provider>/<model>" id for a chain/routing entry. */
export function entryModelId(entry: { provider: string; model: string }): string {
  return `${entry.provider}/${entry.model}`;
}

/**
 * The effective ordered fallback chain: a list of "<provider>/<model>" ids from `llm.fallback`,
 * deduplicated by identity (provider + model + baseUrl, lowercased) while preserving order.
 */
export function getFallbackChain(config: MercuryConfig): string[] {
  const seen = new Set<string>();
  const chain: string[] = [];
  for (const entry of config.llm.fallback) {
    const id = entryModelId(entry);
    const identity = `${id}|${entry.baseUrl ?? ''}`.toLowerCase();
    if (seen.has(identity)) continue;
    seen.add(identity);
    chain.push(id);
  }
  return chain;
}

/**
 * Centralized failover classifier. Returns `true` when `err` means the current (provider, model)
 * is UNAVAILABLE and the caller should fall back to the next entry in the chain; `false` when the
 * error is intrinsic to the request and would recur on any model (so it must propagate).
 *
 * Falls back on: model-not-found / unknown provider / misconfiguration, bad or missing API key
 * (401/403), connection refused / network errors, rate-limit / overload (429/503/529/5xx), and an
 * open circuit breaker (model temporarily unavailable).
 *
 * Does NOT fall back on: context-overflow, content-policy / moderation, and bad-request / format
 * errors (400/422) — retrying these on another model wastes calls and changes nothing.
 */
export function isFallbackError(err: unknown): boolean {
  const msg = errorMessage(err).toLowerCase();

  // 1. Request-intrinsic failures never fall back — a different model would fail identically.
  if (/context[ _]length|maximum context|context_length_exceeded|too many tokens|reduce the (length|size)/.test(msg)) return false;
  if (/content[ _-]?policy|content_filter|moderation|flagged|safety system/.test(msg)) return false;

  // 2. Mercury's own errors: an unresolvable/misconfigured model or provider is "unavailable";
  //    an open circuit breaker (code 'circuit_open', a MercuryError subclass) is too.
  if (err instanceof MercuryError) {
    return ['invalid_model', 'unknown_provider', 'no_model_configured', 'config_invalid', 'circuit_open'].includes(err.code);
  }

  // 3. Provider/transport errors: decide primarily on the HTTP status.
  if (err instanceof ProviderError) {
    const status = err.status;
    if (status === 400 || status === 422) return false; // bad request / unprocessable — caller's fault
    // Bad or missing API key (401/403) and model-not-found (404) → the pair is unusable; try the next.
    if (status === 401 || status === 403 || status === 404) return true;
    // Rate-limit / overload / upstream failures → temporarily unavailable; try the next.
    if (status === 429 || status === 503 || status === 529 || (status !== undefined && status >= 500)) return true;
    // Network-class errors carry no status but set retryable (connection refused, DNS, timeout).
    if (err.retryable) return true;
    return messageSignalsUnavailable(msg);
  }

  // 4. Unknown error shape: only the clearest "unavailable" signals in the message trigger fallback.
  return messageSignalsUnavailable(msg);
}

/** Message-level signals that a (provider, model) is unavailable (used only when status is absent). */
function messageSignalsUnavailable(msg: string): boolean {
  if (/model.*(not found|does not exist|unknown|unavailable|deprecated)|no such model|unknown model/.test(msg)) return true;
  if (/api key|unauthorized|invalid key|missing .*key|authentication fail/.test(msg)) return true;
  if (/connection refused|econnrefused|network error|fetch failed|socket hang ?up|etimedout|enotfound|ehostunreach/.test(msg)) return true;
  return false;
}

/** Request signals used to match against routing-entry criteria. */
export interface SelectionContext {
  /** Request tags (explicit + inferred), e.g. ['code', 'reasoning']. Matched against criteria. */
  tags?: string[];
  /** The request needs a vision-capable model (adds the 'vision' criterion). */
  needsVision?: boolean;
}

/**
 * Criteria-based model selection. Chooses the most appropriate "<provider>/<model>" from
 * `llm.routing` for a request:
 *
 *   - An entry matches only when ALL of its criteria are present in the request (AND semantics).
 *   - Among matching entries the MOST SPECIFIC one wins (most criteria matched); ties keep the
 *     earlier entry (configuration order).
 *   - An entry with empty criteria, or exactly `['default']`, is the general-purpose catch-all,
 *     used only when no specific entry matched.
 *
 * Returns `undefined` when routing is not configured or nothing matches (the caller then falls
 * back to the normal router / `llm.defaultModel`). The selected model still benefits from the
 * automatic fallback chain if it turns out to be unavailable.
 */
export function selectModelByCriteria(config: MercuryConfig, ctx: SelectionContext): string | undefined {
  const routing = config.llm.routing;
  if (!routing.length) return undefined;

  const requested = new Set((ctx.tags ?? []).map((t) => t.toLowerCase()));
  if (ctx.needsVision) requested.add('vision');

  let best: { id: string; score: number } | undefined;
  let catchAll: string | undefined;
  for (const entry of routing) {
    const id = entryModelId(entry);
    const criteria = entry.criteria.map((c) => c.toLowerCase()).filter(Boolean);
    const isCatchAll = criteria.length === 0 || (criteria.length === 1 && criteria[0] === 'default');
    if (isCatchAll) {
      if (!catchAll) catchAll = id; // first default entry wins the catch-all slot
      continue;
    }
    const allMatched = criteria.every((c) => requested.has(c));
    if (allMatched && (!best || criteria.length > best.score)) best = { id, score: criteria.length };
  }
  return best?.id ?? catchAll;
}
