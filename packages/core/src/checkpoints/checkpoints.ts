/**
 * Filesystem checkpoints (Hermes `/rollback`). Before a tool modifies a file, the
 * previous content is snapshotted. A checkpoint groups all snapshots of one run/turn;
 * `rollback(id)` restores every file of that checkpoint and later ones (newest first).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { newId, nowIso } from '../types/common.js';

export interface CheckpointEntry {
  path: string;
  /** False when the file did not exist before (rollback deletes it). */
  existed: boolean;
  blob?: string;
}

export interface Checkpoint {
  id: string;
  label: string;
  sessionId?: string;
  createdAt: string;
  entries: CheckpointEntry[];
}

export class CheckpointManager {
  private dir: string;

  constructor(dataDir: string, private maxCheckpoints = 50) {
    this.dir = join(dataDir, 'checkpoints');
    mkdirSync(this.dir, { recursive: true });
  }

  private metaFile(id: string): string {
    return join(this.dir, id, 'checkpoint.json');
  }

  /** Get or create the open checkpoint for a run (one per agent turn). */
  open(runId: string, label: string, sessionId?: string): Checkpoint {
    const id = `cp_${runId.replace(/[^\w-]/g, '')}`;
    if (existsSync(this.metaFile(id))) return this.get(id)!;
    const cp: Checkpoint = { id, label, sessionId, createdAt: nowIso(), entries: [] };
    mkdirSync(join(this.dir, id), { recursive: true });
    this.save(cp);
    this.prune();
    return cp;
  }

  /** Snapshot a file before it is modified (only the first time per checkpoint). */
  snapshot(runId: string, path: string, label = 'agent edit', sessionId?: string): void {
    const cp = this.open(runId, label, sessionId);
    if (cp.entries.some((e) => e.path === path)) return;
    const entry: CheckpointEntry = { path, existed: existsSync(path) };
    if (entry.existed) {
      entry.blob = newId('blob');
      copyFileSync(path, join(this.dir, cp.id, entry.blob));
    }
    cp.entries.push(entry);
    this.save(cp);
  }

  list(sessionId?: string): Checkpoint[] {
    return readdirSync(this.dir)
      .map((id) => this.get(id))
      .filter((c): c is Checkpoint => !!c && c.entries.length > 0 && (!sessionId || c.sessionId === sessionId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Checkpoint | undefined {
    const f = this.metaFile(id);
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Checkpoint) : undefined;
  }

  /** Restore files to their state before checkpoint `id` (also undoing newer checkpoints). */
  rollback(id?: string, sessionId?: string): { restored: string[]; checkpoints: string[] } {
    const all = this.list(sessionId);
    const target = id ? all.find((c) => c.id === id) : all[0];
    if (!target) return { restored: [], checkpoints: [] };
    const toUndo = all.filter((c) => c.createdAt >= target.createdAt);
    const restored: string[] = [];
    for (const cp of toUndo) {
      for (const e of [...cp.entries].reverse()) {
        if (e.existed && e.blob) {
          mkdirSync(dirname(e.path), { recursive: true });
          writeFileSync(e.path, readFileSync(join(this.dir, cp.id, e.blob)));
        } else if (existsSync(e.path)) unlinkSync(e.path);
        restored.push(e.path);
      }
      rmSync(join(this.dir, cp.id), { recursive: true, force: true });
    }
    return { restored: [...new Set(restored)], checkpoints: toUndo.map((c) => c.id) };
  }

  private save(cp: Checkpoint): void {
    writeFileSync(this.metaFile(cp.id), JSON.stringify(cp, null, 2));
  }

  private prune(): void {
    const all = readdirSync(this.dir).map((id) => this.get(id)).filter((c): c is Checkpoint => !!c).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const old of all.slice(this.maxCheckpoints)) rmSync(join(this.dir, old.id), { recursive: true, force: true });
  }
}
