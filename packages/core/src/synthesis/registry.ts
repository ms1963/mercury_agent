/**
 * Registry + persistence for self-extending tools.
 *
 * {@link SynthRegistry} is the PURE in-memory store of {@link SynthesizedToolRecord}s with the
 * approval lifecycle (pending → approved / denied). The fs helpers below persist an APPROVED tool as
 * a polyglot tool folder (`tool.json` + the implementation) plus a sidecar metadata file, so the
 * capability survives restarts: the existing polyglot loader (`registerPolyglotTools`) picks it up,
 * runs it OUT-OF-PROCESS behind the sandbox boundary (scrubbed env, no network unless declared,
 * timeout, fingerprint-pinned), and NEVER eval's it in the main runtime.
 *
 * The registry itself does no IO; persistence is done by the fs helpers, which the runtime calls.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CapabilityManifest, SynthesizedToolDraft, SynthesizedToolRecord } from './types.js';

/** The sidecar metadata filename written next to a persisted tool folder. */
export const SYNTH_META_FILE = '.synth.json';

/** Pure in-memory registry of synthesized tool records. */
export class SynthRegistry {
  private readonly records = new Map<string, SynthesizedToolRecord>();

  add(record: SynthesizedToolRecord): void {
    this.records.set(record.id, record);
  }

  get(id: string): SynthesizedToolRecord | undefined {
    return this.records.get(id);
  }

  /** Look up by the tool's slug name (first match). */
  byName(name: string): SynthesizedToolRecord | undefined {
    return [...this.records.values()].find((r) => r.draft.name === name);
  }

  list(filter?: { approval?: SynthesizedToolRecord['approval'] }): SynthesizedToolRecord[] {
    const all = [...this.records.values()];
    const filtered = filter?.approval ? all.filter((r) => r.approval === filter.approval) : all;
    return filtered.sort((a, b) => (a.provenance.createdAt < b.provenance.createdAt ? 1 : -1));
  }

  has(id: string): boolean {
    return this.records.has(id);
  }

  remove(id: string): boolean {
    return this.records.delete(id);
  }

  clear(): void {
    this.records.clear();
  }

  /** Transition a record to approved. Returns the record, or undefined if unknown. */
  approve(id: string, by: string, at: string): SynthesizedToolRecord | undefined {
    const r = this.records.get(id);
    if (!r) return undefined;
    r.approval = 'approved';
    r.decidedBy = by;
    r.decidedAt = at;
    return r;
  }

  /** Transition a record to denied. */
  deny(id: string, by: string, at: string): SynthesizedToolRecord | undefined {
    const r = this.records.get(id);
    if (!r) return undefined;
    r.approval = 'denied';
    r.decidedBy = by;
    r.decidedAt = at;
    return r;
  }

  /** Increment the invocation counter (audit); returns the new count or undefined. */
  recordInvocation(id: string): number | undefined {
    const r = this.records.get(id);
    if (!r) return undefined;
    r.invocations += 1;
    return r.invocations;
  }
}

// ─────────────────────────────── polyglot mapping (pure) ───────────────────────────────

/** The polyglot `command` array for a draft's runtime (the entry script filename is fixed). */
export function runtimeCommand(draft: SynthesizedToolDraft): { command: string[]; file: string } {
  if (draft.runtime === 'python') return { command: ['python3', 'main.py'], file: 'main.py' };
  return { command: ['node', 'main.mjs'], file: 'main.mjs' };
}

/**
 * Build the polyglot `tool.json` for an approved synthesized tool. The capability manifest maps onto
 * the polyglot sandbox controls: network on/off, workdir mounted read-only only when the tool needs
 * filesystem (else 'none'), and a risk derived from the privileges requested.
 */
export function buildToolManifest(
  draft: SynthesizedToolDraft,
  limits: { timeoutMs: number },
): Record<string, unknown> {
  const { command } = runtimeCommand(draft);
  const cap = draft.capabilities;
  const risk = cap.shell ? 'dangerous' : cap.network === 'allow' || cap.filesystem ? 'moderate' : 'safe';
  return {
    name: draft.name,
    description: draft.description,
    toolset: 'synth',
    risk,
    parameters: draft.parameters,
    command,
    timeoutMs: limits.timeoutMs,
    untrustedOutput: true,
    network: cap.network === 'allow',
    workdir: cap.filesystem ? 'rw' : 'none',
  };
}

// ─────────────────────────────── fs persistence layer ───────────────────────────────

/**
 * Persist an APPROVED tool to `<baseDir>/<name>/`: writes `tool.json`, the implementation file and a
 * `.synth.json` sidecar with the full provenance/validation metadata. Returns the folder path.
 * Refuses to write a non-approved record.
 */
export function persistToolFolder(baseDir: string, record: SynthesizedToolRecord, limits: { timeoutMs: number }): string {
  if (record.approval !== 'approved') throw new Error(`refusing to persist non-approved tool "${record.draft.name}" (${record.approval})`);
  const dir = join(baseDir, record.draft.name);
  mkdirSync(dir, { recursive: true });
  const { file } = runtimeCommand(record.draft);
  writeFileSync(join(dir, 'tool.json'), JSON.stringify(buildToolManifest(record.draft, limits), null, 2));
  writeFileSync(join(dir, file), record.draft.code);
  writeFileSync(join(dir, SYNTH_META_FILE), JSON.stringify(record, null, 2));
  return dir;
}

/** Remove a persisted tool folder (used on deny-after-approve or cleanup). */
export function removeToolFolder(baseDir: string, name: string): void {
  const dir = join(baseDir, name);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

/** Load every persisted synthesized-tool record from `<baseDir>/<*>/.synth.json`. */
export function loadPersistedRecords(baseDir: string): SynthesizedToolRecord[] {
  const out: SynthesizedToolRecord[] = [];
  if (!existsSync(baseDir)) return out;
  for (const entry of readdirSync(baseDir)) {
    const metaPath = join(baseDir, entry, SYNTH_META_FILE);
    if (!existsSync(metaPath)) continue;
    try {
      out.push(JSON.parse(readFileSync(metaPath, 'utf8')) as SynthesizedToolRecord);
    } catch {
      /* skip corrupt metadata — never crash startup on one bad folder */
    }
  }
  return out;
}

/** Hydrate a {@link SynthRegistry} from disk. */
export function loadRegistry(baseDir: string): SynthRegistry {
  const reg = new SynthRegistry();
  for (const r of loadPersistedRecords(baseDir)) reg.add(r);
  return reg;
}

/** Re-export for callers wiring the manifest mapping. */
export type { CapabilityManifest };
