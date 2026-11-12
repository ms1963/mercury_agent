/**
 * Honcho-style user model: a per-user profile built from observations.
 * Observations ("prefers concise answers", "works in TypeScript") are collected by
 * reflection; repeated observations strengthen a trait. The top traits are injected
 * into the system prompt so the agent adapts to the user across sessions/platforms.
 */
import type { Db } from '../db/db.js';
import { fromJson, toJson } from '../db/db.js';
import { nowIso } from '../types/common.js';

export interface Trait {
  text: string;
  strength: number;
  lastSeen: string;
}

export interface UserProfile {
  userId: string;
  traits: Trait[];
  observations: Array<{ text: string; ts: string }>;
  updatedAt?: string;
}

const MAX_OBSERVATIONS = 200;
const MAX_TRAITS = 50;

export class UserModel {
  constructor(private db: Db) {}

  get(userId: string): UserProfile {
    const r = this.db.get<{ traits: string; observations: string; updated_at: string }>('SELECT * FROM user_profile WHERE user_id = ?', userId);
    return { userId, traits: fromJson(r?.traits, []), observations: fromJson(r?.observations, []), updatedAt: r?.updated_at };
  }

  /** Record an observation; similar existing traits are reinforced instead of duplicated. */
  observe(userId: string, text: string): UserProfile {
    const p = this.get(userId);
    const clean = text.trim();
    if (!clean) return p;
    const now = nowIso();
    p.observations = [...p.observations, { text: clean, ts: now }].slice(-MAX_OBSERVATIONS);
    const existing = p.traits.find((t) => similar(t.text, clean));
    if (existing) {
      existing.strength = Math.min(1, existing.strength + 0.15);
      existing.lastSeen = now;
    } else p.traits.push({ text: clean, strength: 0.4, lastSeen: now });
    p.traits = p.traits.sort((a, b) => b.strength - a.strength).slice(0, MAX_TRAITS);
    this.save(p);
    return p;
  }

  removeTrait(userId: string, match: string): number {
    const p = this.get(userId);
    const before = p.traits.length;
    p.traits = p.traits.filter((t) => !t.text.toLowerCase().includes(match.toLowerCase()));
    this.save(p);
    return before - p.traits.length;
  }

  /** Markdown summary of the strongest traits for the system prompt. */
  summary(userId: string, max = 8): string {
    const traits = this.get(userId).traits.filter((t) => t.strength >= 0.4).slice(0, max);
    return traits.map((t) => `- ${t.text}`).join('\n');
  }

  private save(p: UserProfile): void {
    this.db.run(
      'INSERT INTO user_profile (user_id, traits, observations, updated_at) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET traits=excluded.traits, observations=excluded.observations, updated_at=excluded.updated_at',
      p.userId, toJson(p.traits), toJson(p.observations), nowIso(),
    );
  }
}

/** Cheap word-overlap similarity (Jaccard ≥ 0.6). */
function similar(a: string, b: string): boolean {
  const wa = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const wb = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  const inter = [...wa].filter((w) => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return union > 0 && inter / union >= 0.6;
}
