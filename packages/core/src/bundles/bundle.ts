/**
 * Pure bundle construction, signing, verification and compatibility checking.
 *
 * Signing is an HMAC-SHA256 (reusing {@link hmacHex}/{@link safeEqual} from the security layer) over
 * a canonical JSON encoding of `{manifest, contents}` — canonical so semantically-identical bundles
 * produce identical signatures and digests regardless of key order. The content digest (SHA-256 of
 * the canonical contents) is the idempotency key. Everything here is a pure function of its inputs:
 * no I/O, no config mutation, trivially testable and deterministic.
 */
import { createHash } from 'node:crypto';
import { hmacHex, safeEqual } from '../security/misc.js';
import {
  BUNDLE_FORMAT_VERSION,
  BUNDLE_SECTIONS,
  GOVERNED_SECTIONS,
  type Bundle,
  type BundleContents,
  type BundleManifest,
  type BundleSection,
  type InspectResult,
} from './ports.js';

/** Deterministic JSON with recursively sorted object keys (stable across key insertion order). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** SHA-256 (hex) of the canonical contents — the idempotency key for a bundle. */
export function digestOf(contents: BundleContents): string {
  return createHash('sha256').update(canonicalJson(contents)).digest('hex');
}

/** The exact payload that gets signed: canonical JSON of the manifest + contents together. */
function signingPayload(manifest: BundleManifest, contents: BundleContents): string {
  return canonicalJson({ manifest, contents });
}

/** Compute the HMAC-SHA256 signature (hex) for a manifest + contents under `secret`. */
export function signBundle(manifest: BundleManifest, contents: BundleContents, secret: string): string {
  return hmacHex(secret, signingPayload(manifest, contents));
}

/** Verify a bundle's signature against `secret` (constant-time). */
export function verifyBundle(bundle: Bundle, secret: string): boolean {
  if (!bundle.signature) return false;
  const expected = signBundle(bundle.manifest, bundle.contents, secret);
  return safeEqual(bundle.signature, expected);
}

export interface BuildBundleInput {
  name: string;
  version: string;
  mercuryVersion: string;
  contents: BundleContents;
  description?: string;
  author?: string;
  /** Override createdAt (tests/determinism); defaults to now. */
  createdAt?: string;
}

/** Build and sign a bundle from its contents. The included sections are derived from `contents`. */
export function buildBundle(input: BuildBundleInput, secret: string): Bundle {
  const sections = BUNDLE_SECTIONS.filter((s) => input.contents[s] !== undefined);
  const manifest: BundleManifest = {
    name: input.name,
    version: input.version,
    formatVersion: BUNDLE_FORMAT_VERSION,
    mercuryVersion: input.mercuryVersion,
    sections,
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...(input.description ? { description: input.description } : {}),
    ...(input.author ? { author: input.author } : {}),
  };
  // Keep only the included sections in the stored contents so digest/signature are stable.
  const contents: BundleContents = {};
  for (const s of sections) contents[s] = input.contents[s];
  const signature = signBundle(manifest, contents, secret);
  return { manifest, contents, signature };
}

/** The major component of a semantic version string ("1.3.0" → 1). */
export function majorOf(version: string): number {
  const m = /^(\d+)/.exec(String(version).trim());
  return m ? Number(m[1]) : 0;
}

/**
 * Compatibility check: the bundle's wire format must not be from a newer major than this build
 * understands, and (best-effort) the bundle should not come from a newer Mercury major.
 */
export function checkCompat(manifest: BundleManifest, currentMercuryVersion: string): { compatible: boolean; issues: string[] } {
  const issues: string[] = [];
  if (typeof manifest.formatVersion !== 'number' || manifest.formatVersion > BUNDLE_FORMAT_VERSION) {
    issues.push(
      `bundle format v${manifest.formatVersion} is newer than supported v${BUNDLE_FORMAT_VERSION}; upgrade Mercury to install it`,
    );
  }
  if (majorOf(manifest.mercuryVersion) > majorOf(currentMercuryVersion)) {
    issues.push(
      `bundle was built for Mercury v${manifest.mercuryVersion}, newer than this instance v${currentMercuryVersion}`,
    );
  }
  return { compatible: issues.length === 0, issues };
}

/** Inspect a bundle (signature + compatibility + which sections are governed) without installing. */
export function inspectBundle(bundle: Bundle, secret: string, currentMercuryVersion: string): InspectResult {
  const signatureValid = verifyBundle(bundle, secret);
  const compat = checkCompat(bundle.manifest, currentMercuryVersion);
  const sections = bundle.manifest.sections ?? [];
  const governed = sections.filter((s) => GOVERNED_SECTIONS.includes(s));
  const issues = [...compat.issues];
  if (!signatureValid) issues.push('signature invalid or missing (bundle may have been tampered with)');
  return {
    manifest: bundle.manifest,
    sections,
    digest: digestOf(bundle.contents),
    signatureValid,
    compatible: compat.compatible,
    governed,
    issues,
  };
}

/** Narrow an unknown parsed object to a Bundle shape (throws on obvious shape violations). */
export function assertBundleShape(value: unknown): asserts value is Bundle {
  const b = value as Partial<Bundle>;
  if (!b || typeof b !== 'object') throw new Error('bundle is not an object');
  if (!b.manifest || typeof b.manifest !== 'object') throw new Error('bundle is missing its manifest');
  if (typeof b.manifest.name !== 'string' || !b.manifest.name) throw new Error('bundle manifest is missing a name');
  if (typeof b.signature !== 'string') throw new Error('bundle is missing its signature');
  if (!b.contents || typeof b.contents !== 'object') throw new Error('bundle is missing its contents');
}

export { GOVERNED_SECTIONS, type BundleSection };
