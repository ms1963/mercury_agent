/**
 * Real, durable install ledger for agent bundles, backed by the shared SQLite {@link Db} (table
 * `installed_bundles`, migration #11). The {@link BundleService} depends only on the
 * {@link BundleLedgerStore} port; this is the single concrete implementation used everywhere,
 * including tests — no mocks in product code. The ledger provides idempotency (lookup by content
 * digest) and an audit trail (every install, with which sections were applied vs left pending).
 */
import type { Db } from '../db/db.js';
import { fromJson, toJson } from '../db/db.js';
import { newId, nowIso } from '../types/common.js';
import type { BundleLedgerStore, BundleSection, InstalledBundleRecord } from './ports.js';

interface BundleRow {
  id: string;
  name: string;
  version: string;
  digest: string;
  sections: string;
  applied: string;
  pending: string;
  status: string;
  source: string | null;
  created_at: string;
  updated_at: string;
}

const toRecord = (r: BundleRow): InstalledBundleRecord => ({
  id: r.id,
  name: r.name,
  version: r.version,
  digest: r.digest,
  sections: fromJson<BundleSection[]>(r.sections, []),
  applied: fromJson<BundleSection[]>(r.applied, []),
  pending: fromJson<BundleSection[]>(r.pending, []),
  status: r.status,
  source: r.source ?? undefined,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class SqliteBundleStore implements BundleLedgerStore {
  constructor(private db: Db) {}

  record(r: Omit<InstalledBundleRecord, 'id' | 'createdAt' | 'updatedAt'>): InstalledBundleRecord {
    const id = newId('bundle');
    const now = nowIso();
    this.db.run(
      `INSERT INTO installed_bundles (id, name, version, digest, sections, applied, pending, status, source, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      r.name,
      r.version,
      r.digest,
      toJson(r.sections),
      toJson(r.applied),
      toJson(r.pending),
      r.status,
      r.source ?? null,
      now,
      now,
    );
    return this.get(id)!;
  }

  get(id: string): InstalledBundleRecord | undefined {
    const r = this.db.get<BundleRow>('SELECT * FROM installed_bundles WHERE id = ?', id);
    return r ? toRecord(r) : undefined;
  }

  getByDigest(digest: string): InstalledBundleRecord | undefined {
    const r = this.db.get<BundleRow>('SELECT * FROM installed_bundles WHERE digest = ? ORDER BY created_at DESC LIMIT 1', digest);
    return r ? toRecord(r) : undefined;
  }

  getLatestByName(name: string): InstalledBundleRecord | undefined {
    const r = this.db.get<BundleRow>('SELECT * FROM installed_bundles WHERE name = ? ORDER BY created_at DESC LIMIT 1', name);
    return r ? toRecord(r) : undefined;
  }

  list(): InstalledBundleRecord[] {
    return this.db.all<BundleRow>('SELECT * FROM installed_bundles ORDER BY created_at DESC').map(toRecord);
  }

  markApplied(id: string, sections: BundleSection[]): InstalledBundleRecord | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const applied = [...new Set([...existing.applied, ...sections])];
    const pending = existing.pending.filter((s) => !sections.includes(s));
    const status = pending.length === 0 ? 'installed' : existing.status;
    this.db.run(
      'UPDATE installed_bundles SET applied = ?, pending = ?, status = ?, updated_at = ? WHERE id = ?',
      toJson(applied),
      toJson(pending),
      status,
      nowIso(),
      id,
    );
    return this.get(id);
  }
}
