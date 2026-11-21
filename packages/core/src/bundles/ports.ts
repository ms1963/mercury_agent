/**
 * Sharable agent bundles ("Mercury packs") — data model + ledger port.
 *
 * A {@link Bundle} is a single versioned, signed artifact that captures a subset of one Mercury
 * instance's configuration — its skills, workflows, personality, policy-as-code rules and MCP
 * presets — so it can be exported to a file and installed into another instance in one step. Each
 * bundle carries a {@link BundleManifest} (name, its own semver, wire-format version, the Mercury
 * version it came from, and which sections it contains) plus an HMAC integrity {@link Bundle.signature}
 * over its canonical contents, so an installer can detect tampering and check compatibility before
 * applying anything.
 *
 * Installs are idempotent (keyed on a content digest) and governed: the two sensitive sections —
 * `policy` and `mcp` — are never applied silently; unless explicitly auto-approved they are queued
 * as pending for the normal approval path. The install ledger ({@link BundleLedgerStore}, one real
 * SQLite implementation) records every install for idempotency and audit.
 */

/** The wire-format version of the bundle artifact itself (bumped only on breaking format changes). */
export const BUNDLE_FORMAT_VERSION = 1;

/** The configuration sections a bundle can carry. */
export type BundleSection = 'skills' | 'workflows' | 'personality' | 'policy' | 'mcp';

/** All sections, in canonical order. */
export const BUNDLE_SECTIONS: BundleSection[] = ['skills', 'workflows', 'personality', 'policy', 'mcp'];

/** Sections whose installation is governed (routed through approval unless explicitly auto-approved). */
export const GOVERNED_SECTIONS: BundleSection[] = ['policy', 'mcp'];

/** The dotted config path each section is read from / written to. */
export const SECTION_CONFIG_PATH: Record<BundleSection, string> = {
  skills: 'skills',
  workflows: 'workflows',
  personality: 'agent.personality',
  policy: 'security.policies',
  mcp: 'mcp.servers',
};

export interface BundleManifest {
  /** Human-readable pack name (stable identity for idempotency/upgrades). */
  name: string;
  /** The bundle's own semantic version (author-assigned). */
  version: string;
  /** Wire-format version — an installer refuses a format from a newer major. */
  formatVersion: number;
  /** The Mercury version this bundle was exported from (compatibility check). */
  mercuryVersion: string;
  /** Which sections this bundle contains. */
  sections: BundleSection[];
  createdAt: string;
  description?: string;
  author?: string;
}

/** The actual configuration payload — only the included sections are present. */
export interface BundleContents {
  skills?: unknown;
  workflows?: unknown;
  personality?: unknown;
  policy?: unknown;
  mcp?: unknown;
}

/** A complete, signed bundle artifact. */
export interface Bundle {
  manifest: BundleManifest;
  contents: BundleContents;
  /** HMAC-SHA256 (hex) over the canonical JSON of `{manifest, contents}`. */
  signature: string;
}

/** Result of inspecting a bundle without installing it. */
export interface InspectResult {
  manifest: BundleManifest;
  sections: BundleSection[];
  /** Content digest (idempotency key). */
  digest: string;
  /** True when the signature verifies against the configured signing secret. */
  signatureValid: boolean;
  /** True when the format + Mercury version are compatible with this instance. */
  compatible: boolean;
  /** Which sections would be applied directly vs queued for governance on install. */
  governed: BundleSection[];
  issues: string[];
}

/** Outcome of installing a bundle. */
export interface InstallResult {
  name: string;
  version: string;
  digest: string;
  /** Sections applied to the live configuration. */
  applied: BundleSection[];
  /** Governed sections queued for approval instead of being applied. */
  pending: BundleSection[];
  status: 'installed' | 'unchanged' | 'rejected';
  /** True when an identical bundle (same digest) was already installed (idempotent no-op). */
  alreadyInstalled: boolean;
  issues: string[];
}

/** A persisted install-ledger row (idempotency + audit). */
export interface InstalledBundleRecord {
  id: string;
  name: string;
  version: string;
  digest: string;
  sections: BundleSection[];
  applied: BundleSection[];
  pending: BundleSection[];
  status: string;
  source?: string;
  createdAt: string;
  updatedAt: string;
}

/** Persistence port for the install ledger. */
export interface BundleLedgerStore {
  record(r: Omit<InstalledBundleRecord, 'id' | 'createdAt' | 'updatedAt'>): InstalledBundleRecord;
  get(id: string): InstalledBundleRecord | undefined;
  getByDigest(digest: string): InstalledBundleRecord | undefined;
  getLatestByName(name: string): InstalledBundleRecord | undefined;
  list(): InstalledBundleRecord[];
  /** Mark a pending (governed) section as applied for a ledger row; returns the updated record. */
  markApplied(id: string, sections: BundleSection[]): InstalledBundleRecord | undefined;
}
