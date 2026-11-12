/**
 * Model router: picks the best model per task.
 *
 *   1. explicit model (user `/model`, request, agent spec) wins
 *   2. config rules (regex on task text and/or task tags)
 *   3. capability filter (tools / vision / audio / context size) + RBAC model policy
 *   4. weighted score: quality·wq − normCost·wc − normLatency·wl
 *   5. optional Jev choice among the top-k candidates
 *   6. remaining candidates + config fallback chain are returned as fallbacks
 */
import type { MercuryConfig, ModelProfile } from '../config/schema.js';
import type { Judgment } from '../decision/judgment.js';
import type { ProviderRegistry } from '../llm/registry.js';
import { MercuryError } from '../types/common.js';

export interface RouteRequest {
  task: string;
  explicitModel?: string;
  tags?: string[];
  needs?: { tools?: boolean; vision?: boolean; audio?: boolean; minContext?: number };
  /** Filter for models the principal may use (RBAC/ABAC). */
  allowed?: (modelId: string) => boolean;
  runId?: string;
}

export interface RouteDecision {
  model: string;
  reason: string;
  fallbacks: string[];
  scores?: Array<{ model: string; score: number }>;
}

/** Infer coarse task tags from text so rules and scoring can use them. */
export function inferTags(task: string): string[] {
  const t = task.toLowerCase();
  const tags: string[] = [];
  if (/\b(code|function|bug|typescript|python|refactor|compile|stack trace|regex|sql)\b/.test(t)) tags.push('code');
  if (/\b(prove|reason|plan|analy[sz]e|math|logic|strategy|why)\b/.test(t)) tags.push('reasoning');
  if (/\b(write|essay|story|poem|email|blog|rewrite)\b/.test(t)) tags.push('writing');
  if (/\b(private|confidential|offline|local only)\b/.test(t)) tags.push('private');
  if (t.length < 80 && !tags.length) tags.push('fast');
  return tags;
}

export class ModelRouter {
  constructor(
    private config: MercuryConfig,
    private registry: ProviderRegistry,
    private judgment?: Judgment,
  ) {}

  candidates(req: RouteRequest): ModelProfile[] {
    const needs = req.needs ?? {};
    return this.registry.profilesList().filter((p) => {
      if (!p.enabled) return false;
      if (!this.registry.get(p.id.split('/')[0]!)) return false;
      if (needs.vision && !p.vision) return false;
      if (needs.audio && !p.audio) return false;
      if (needs.minContext && p.contextWindow < needs.minContext) return false;
      // Models without native tools still work via the text-ReAct fallback, but rank lower.
      return req.allowed ? req.allowed(p.id) : true;
    });
  }

  score(p: ModelProfile, tags: string[], needsTools: boolean, pool: ModelProfile[]): number {
    const w = this.config.router.weights;
    const maxCost = Math.max(1e-9, ...pool.map((c) => c.costPer1MInput + c.costPer1MOutput));
    const maxLat = Math.max(1, ...pool.map((c) => c.latencyMs));
    const cost = (p.costPer1MInput + p.costPer1MOutput) / maxCost;
    const lat = p.latencyMs / maxLat;
    const tagBonus = tags.filter((t) => p.tags.includes(t)).length * 0.1;
    const toolPenalty = needsTools && !p.tools ? 0.3 : 0;
    const mockPenalty = p.tags.includes('mock') && pool.some((c) => !c.tags.includes('mock')) ? 1 : 0;
    return w.quality * p.quality - w.cost * cost - w.latency * lat + tagBonus - toolPenalty - mockPenalty;
  }

  async route(req: RouteRequest): Promise<RouteDecision> {
    const fallbackChain = this.config.router.fallback.filter((m) => this.isUsable(m, req));
    if (req.explicitModel && req.explicitModel !== 'auto') {
      return { model: req.explicitModel, reason: 'explicit', fallbacks: fallbackChain.filter((m) => m !== req.explicitModel) };
    }
    const configured = this.config.llm.defaultModel;
    if (!this.config.router.enabled && configured !== 'auto') {
      return { model: configured, reason: 'default (router disabled)', fallbacks: fallbackChain };
    }
    const tags = [...new Set([...(req.tags ?? []), ...inferTags(req.task)])];
    for (const rule of this.config.router.rules) {
      const textOk = !rule.match || new RegExp(rule.match, 'i').test(req.task);
      const tagsOk = !rule.tags?.length || rule.tags.every((t) => tags.includes(t));
      if (textOk && tagsOk && this.isUsable(rule.model, req)) return { model: rule.model, reason: `rule ${rule.match ?? rule.tags?.join('+')}`, fallbacks: fallbackChain };
    }
    if (configured !== 'auto' && this.isUsable(configured, req)) {
      return { model: configured, reason: 'default model', fallbacks: fallbackChain.filter((m) => m !== configured) };
    }
    const pool = this.candidates(req);
    if (!pool.length) {
      if (fallbackChain.length) return { model: fallbackChain[0]!, reason: 'no candidate matched; fallback', fallbacks: fallbackChain.slice(1) };
      throw new MercuryError(
        'No LLM model is available. Configure a provider (chatllm, openrouter, ollama, lmstudio, an openai-compatible API, or anthropic) and set llm.defaultModel — see docs/PROVIDERS.md or run `mercury setup`.',
        'no_model_configured',
        'models',
      );
    }
    const scored = pool.map((p) => ({ model: p.id, score: this.score(p, tags, !!req.needs?.tools, pool) })).sort((a, b) => b.score - a.score);
    let chosen = scored[0]!.model;
    let reason = 'highest weighted score';
    const top = scored.slice(0, this.config.router.topK).map((s) => pool.find((p) => p.id === s.model)!);
    if (this.config.router.useDecisions && this.judgment && top.length > 1 && !top.every((p) => p.tags.includes('mock'))) {
      const pick = await this.judgment.selectModel(req.task, top, req.runId);
      if (pick && top.some((p) => p.id === pick.model) && (pick.confidence ?? 0) >= 0.4) {
        chosen = pick.model;
        reason = `decision engine (confidence ${pick.confidence?.toFixed(2)})`;
      }
    }
    const fallbacks = [...scored.map((s) => s.model).filter((m) => m !== chosen), ...fallbackChain.filter((m) => m !== chosen)];
    return { model: chosen, reason, fallbacks: [...new Set(fallbacks)], scores: scored };
  }

  private isUsable(modelId: string, req: RouteRequest): boolean {
    try {
      this.registry.resolve(modelId);
    } catch {
      return false;
    }
    return req.allowed ? req.allowed(modelId) : true;
  }
}
