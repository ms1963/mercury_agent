/**
 * Capability-manifest policy for self-extending tools (deny-by-default).
 *
 * A synthesized tool declares exactly which capabilities it needs (filesystem / network+hosts /
 * shell). This module decides whether the admin-controlled policy is willing to GRANT those
 * capabilities. Anything a draft requests that the policy does not allow is a violation and the
 * draft is rejected BEFORE it is ever compiled, tested, approved or run.
 *
 * Pure: no IO. The policy itself comes from config (`selfExtension.*`).
 */
import { SYNTH_RUNTIMES, type CapabilityManifest, type SynthesisPolicy, type SynthesizedToolDraft } from './types.js';

/** A conservative default policy: enabled off, nothing granted, high threshold, no auto-approve. */
export function defaultSynthesisPolicy(): SynthesisPolicy {
  return {
    enabled: false,
    missThreshold: 3,
    autoApprove: false,
    allowFilesystem: false,
    allowNetwork: false,
    allowedHosts: [],
    allowShell: false,
    runtimes: ['python', 'node'],
    timeoutMs: 15_000,
    maxOutputChars: 20_000,
  };
}

/** The result of checking a manifest against a policy. */
export interface ManifestCheck {
  ok: boolean;
  violations: string[];
}

/**
 * Check a capability manifest against the policy. Deny-by-default: a capability is allowed only if the
 * policy explicitly permits it, and a networked tool's hosts must ALL be in the policy allowlist.
 */
export function checkManifest(manifest: CapabilityManifest, policy: SynthesisPolicy): ManifestCheck {
  const violations: string[] = [];

  if (manifest.filesystem && !policy.allowFilesystem) {
    violations.push('tool requests filesystem access but policy.allowFilesystem is false');
  }

  if (manifest.network === 'allow') {
    if (!policy.allowNetwork) {
      violations.push('tool requests network access but policy.allowNetwork is false');
    } else if (manifest.hosts.length === 0) {
      violations.push('tool requests network access but declares no host allowlist (empty hosts)');
    } else {
      const disallowed = manifest.hosts.filter((h) => !hostAllowed(h, policy.allowedHosts));
      if (disallowed.length) violations.push(`hosts not permitted by policy.allowedHosts: ${disallowed.join(', ')}`);
    }
  } else if (manifest.hosts.length > 0) {
    violations.push('hosts declared but network is "none" — set network:"allow" or clear hosts');
  }

  if (manifest.shell && !policy.allowShell) {
    violations.push('tool requests shell/host execution but policy.allowShell is false');
  }

  return { ok: violations.length === 0, violations };
}

/** True when `host` is covered by the allowlist (exact match or a `*.suffix` wildcard entry). */
export function hostAllowed(host: string, allowlist: readonly string[]): boolean {
  const h = host.trim().toLowerCase();
  return allowlist.some((entry) => {
    const e = entry.trim().toLowerCase();
    if (e === h) return true;
    if (e.startsWith('*.')) {
      const suffix = e.slice(1); // ".example.com"
      return h.endsWith(suffix) && h.length > suffix.length;
    }
    return false;
  });
}

const NAME_RE = /^[a-z][a-z0-9_]{2,63}$/;

/** Validate the non-capability parts of a draft (name, runtime, code/test presence). */
export function checkDraftShape(draft: SynthesizedToolDraft, policy: SynthesisPolicy): string[] {
  const errors: string[] = [];
  if (!NAME_RE.test(draft.name)) errors.push(`invalid tool name "${draft.name}" (must match ${NAME_RE})`);
  if (!SYNTH_RUNTIMES.includes(draft.runtime)) errors.push(`unsupported runtime "${draft.runtime}"`);
  else if (!policy.runtimes.includes(draft.runtime)) errors.push(`runtime "${draft.runtime}" not permitted by policy.runtimes`);
  if (!draft.description || draft.description.trim().length < 3) errors.push('description is required');
  if (!draft.code || !draft.code.trim()) errors.push('implementation code is empty');
  if (!draft.test || !draft.test.trim()) errors.push('generated test is empty');
  if (!draft.parameters || typeof draft.parameters !== 'object') errors.push('parameters must be a JSON-schema object');
  return errors;
}
