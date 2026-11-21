/**
 * Sharable agent bundles service.
 *
 * Exports a subset of this instance's live configuration into a signed {@link Bundle}, inspects a
 * bundle (signature + compatibility) without applying it, and installs one: verify signature → check
 * version/compatibility → idempotency (skip if an identical digest is already installed) → apply the
 * ungoverned sections to the live config, while routing the governed sections (`policy`, `mcp`)
 * through the approval path (queued as pending) unless explicitly auto-approved. Every install is
 * recorded in a durable ledger for idempotency and audit.
 *
 * The service depends only on the ledger port, a live config reference, the signing/verification
 * helpers and an optional persist callback — no mocks in product code.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MercuryConfig } from '../config/schema.js';
import { getPath, setPath } from '../config/load.js';
import type { EventBus } from '../events/bus.js';
import {
  assertBundleShape,
  buildBundle,
  digestOf,
  inspectBundle,
  verifyBundle,
} from './bundle.js';
import {
  BUNDLE_SECTIONS,
  GOVERNED_SECTIONS,
  SECTION_CONFIG_PATH,
  type Bundle,
  type BundleContents,
  type BundleLedgerStore,
  type BundleSection,
  type InspectResult,
  type InstallResult,
  type InstalledBundleRecord,
} from './ports.js';

export interface BundleServiceOptions {
  /** Directory bundles are written to / read from. */
  dir: string;
  /** HMAC signing secret shared across instances that exchange bundles. */
  signingSecret: string;
  /** Reject a bundle whose signature is missing/invalid. */
  requireSignature: boolean;
  /** Apply bundled policy rules immediately instead of queuing them for approval. */
  autoApprovePolicy: boolean;
  /** Apply bundled MCP presets immediately instead of queuing them for approval. */
  autoApproveMcp: boolean;
  /** The Mercury version of this instance (stamped into exported bundles, used for compat checks). */
  mercuryVersion: string;
  /** Persists an applied config section so it survives restart (runtime wires this to the YAML writer). */
  persist?: (path: string, value: unknown) => void;
  bus?: EventBus;
}

export interface ExportOptions {
  name: string;
  version?: string;
  /** Which sections to include; defaults to every section that has content. */
  sections?: BundleSection[];
  description?: string;
  author?: string;
  createdAt?: string;
}

export class BundleService {
  constructor(
    private store: BundleLedgerStore,
    private config: MercuryConfig,
    private opts: BundleServiceOptions,
  ) {}

  /** Export the current configuration (or a subset) into a signed bundle artifact. */
  export(opts: ExportOptions): Bundle {
    const wanted = opts.sections ?? BUNDLE_SECTIONS;
    const contents: BundleContents = {};
    for (const section of wanted) {
      const value = getPath(this.config, SECTION_CONFIG_PATH[section]);
      if (value !== undefined) contents[section] = clone(value);
    }
    const bundle = buildBundle(
      {
        name: opts.name,
        version: opts.version ?? '1.0.0',
        mercuryVersion: this.opts.mercuryVersion,
        contents,
        description: opts.description,
        author: opts.author,
        createdAt: opts.createdAt,
      },
      this.opts.signingSecret,
    );
    this.opts.bus?.emit({ type: 'bundle.exported', data: { name: bundle.manifest.name, sections: bundle.manifest.sections } });
    return bundle;
  }

  /** Export and write a bundle to `<dir>/<name>-<version>.mercury.json`; returns the file path. */
  exportToFile(opts: ExportOptions): { bundle: Bundle; path: string } {
    const bundle = this.export(opts);
    mkdirSync(this.opts.dir, { recursive: true });
    const safe = `${bundle.manifest.name}-${bundle.manifest.version}`.replace(/[^a-zA-Z0-9._-]+/g, '_');
    const path = join(this.opts.dir, `${safe}.mercury.json`);
    writeFileSync(path, JSON.stringify(bundle, null, 2), 'utf8');
    return { bundle, path };
  }

  /** Parse a bundle from a file path or a raw JSON string (shape-validated, not yet verified). */
  read(source: string): Bundle {
    const raw = looksLikeJson(source) ? source : readFileSync(source, 'utf8');
    const parsed = JSON.parse(raw);
    assertBundleShape(parsed);
    return parsed;
  }

  /** Inspect a bundle (signature + compatibility + governed sections) without installing it. */
  inspect(bundle: Bundle): InspectResult {
    return inspectBundle(bundle, this.opts.signingSecret, this.opts.mercuryVersion);
  }

  /**
   * Install a bundle into this instance:
   * 1. verify the integrity signature (unless `requireSignature` is off) — tamper detection;
   * 2. check wire-format + Mercury version compatibility;
   * 3. idempotency: if an identical digest is already installed, no-op;
   * 4. apply ungoverned sections to the live config; queue governed sections (policy/mcp) for
   *    approval unless auto-approved.
   */
  install(bundle: Bundle, opts: { source?: string } = {}): InstallResult {
    const digest = digestOf(bundle.contents);
    const sections = bundle.manifest.sections ?? [];
    const base: InstallResult = {
      name: bundle.manifest.name,
      version: bundle.manifest.version,
      digest,
      applied: [],
      pending: [],
      status: 'rejected',
      alreadyInstalled: false,
      issues: [],
    };

    // 1. Signature / tamper check.
    const signatureValid = verifyBundle(bundle, this.opts.signingSecret);
    if (!signatureValid && this.opts.requireSignature) {
      base.issues.push('signature invalid or missing — refusing to install (possible tampering)');
      this.opts.bus?.emit({ type: 'bundle.rejected', data: { name: base.name, reason: 'signature' } });
      return base;
    }
    if (!signatureValid) base.issues.push('signature not verified (requireSignature is off)');

    // 2. Compatibility.
    const inspected = this.inspect(bundle);
    if (!inspected.compatible) {
      base.issues.push(...inspected.issues.filter((i) => !i.includes('signature')));
      this.opts.bus?.emit({ type: 'bundle.rejected', data: { name: base.name, reason: 'incompatible' } });
      return base;
    }

    // 3. Idempotency: identical content already installed → no-op.
    const prior = this.store.getByDigest(digest);
    if (prior) {
      this.opts.bus?.emit({ type: 'bundle.unchanged', data: { name: base.name, digest } });
      return {
        ...base,
        status: 'unchanged',
        alreadyInstalled: true,
        applied: prior.applied,
        pending: prior.pending,
        issues: [...base.issues, 'identical bundle already installed (no changes applied)'],
      };
    }

    // 4. Apply / queue sections.
    const applied: BundleSection[] = [];
    const pending: BundleSection[] = [];
    for (const section of sections) {
      const value = bundle.contents[section];
      if (value === undefined) continue;
      const governed = GOVERNED_SECTIONS.includes(section);
      const autoApprove = section === 'policy' ? this.opts.autoApprovePolicy : section === 'mcp' ? this.opts.autoApproveMcp : true;
      if (governed && !autoApprove) {
        pending.push(section);
        continue;
      }
      this.applySection(section, value);
      applied.push(section);
    }

    const status = 'installed';
    this.store.record({
      name: bundle.manifest.name,
      version: bundle.manifest.version,
      digest,
      sections,
      applied,
      pending,
      status,
      source: opts.source,
    });
    this.opts.bus?.emit({ type: 'bundle.installed', data: { name: base.name, applied, pending } });
    return { ...base, status, applied, pending };
  }

  /**
   * Approve and apply the governed sections that were queued during install (the human-in-the-loop
   * governance step). Returns the updated ledger record.
   */
  approvePending(recordId: string, sections?: BundleSection[], bundle?: Bundle): InstalledBundleRecord | undefined {
    const rec = this.store.get(recordId);
    if (!rec) return undefined;
    const toApprove = (sections ?? rec.pending).filter((s) => rec.pending.includes(s));
    if (bundle) {
      for (const section of toApprove) {
        const value = bundle.contents[section];
        if (value !== undefined) this.applySection(section, value);
      }
    }
    const updated = this.store.markApplied(recordId, toApprove);
    this.opts.bus?.emit({ type: 'bundle.approved', data: { id: recordId, sections: toApprove } });
    return updated;
  }

  /** Every recorded install (newest first). */
  list(): InstalledBundleRecord[] {
    return this.store.list();
  }

  private applySection(section: BundleSection, value: unknown): void {
    const path = SECTION_CONFIG_PATH[section];
    setPath(this.config as unknown as Record<string, unknown>, path, clone(value));
    this.opts.persist?.(path, value);
  }
}

/** Structured deep clone (so applied config cannot alias a bundle's contents). */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/** Heuristic: treat a string that begins with `{` as inline JSON rather than a file path. */
function looksLikeJson(s: string): boolean {
  return s.trimStart().startsWith('{');
}
