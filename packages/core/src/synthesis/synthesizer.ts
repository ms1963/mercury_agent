/**
 * The self-extending-tools orchestrator.
 *
 * Ties the pieces together behind the master kill-switch:
 *   recordMiss()  — feed a tool-miss into the gap tracker; returns whether the threshold is reached.
 *   synthesize()  — author → validate → create a PENDING record (never auto-runs); audited.
 *   approve()/deny() — human/policy gate for first run; approval required unless policy.autoApprove.
 *
 * When the feature is disabled, EVERY entry point is a hard no-op that refuses clearly (so a stray
 * call can never synthesize, approve or run a tool). All effects (LLM, validation, audit, clock, ids)
 * are injected, so the whole flow is unit-testable offline.
 */
import { buildAuthoringPrompt, parseDraft, type AuthoringRequest } from './authoring.js';
import { GapTracker } from './gap-detector.js';
import { checkManifest } from './policy.js';
import { SynthRegistry } from './registry.js';
import { validateDraft, type ValidatorDeps } from './validation.js';
import type {
  SynthAuditSink,
  SynthClock,
  SynthesisPolicy,
  SynthesizedToolRecord,
  SynthIdGen,
  SynthLlmRunner,
} from './types.js';

export interface SynthesizerDeps {
  policy: SynthesisPolicy;
  llm: SynthLlmRunner;
  validator: ValidatorDeps;
  /** Existing gap tracker (shared with the live runtime) or a fresh one. */
  tracker?: GapTracker;
  /** Existing registry (hydrated from disk) or a fresh one. */
  registry?: SynthRegistry;
  audit?: SynthAuditSink;
  clock?: SynthClock;
  idGen?: SynthIdGen;
}

/** The disabled-feature refusal, surfaced to the caller (localized at the CLI/UI boundary). */
export const SYNTH_DISABLED = 'self-extending tools are disabled (selfExtension.enabled = false)';

/** Outcome of a synthesize() attempt. */
export type SynthesizeOutcome =
  | { ok: true; record: SynthesizedToolRecord }
  | { ok: false; reason: string; record?: SynthesizedToolRecord };

export class Synthesizer {
  readonly tracker: GapTracker;
  readonly registry: SynthRegistry;
  private readonly clock: SynthClock;
  private readonly idGen: SynthIdGen;
  private readonly audit: SynthAuditSink;

  constructor(private readonly deps: SynthesizerDeps) {
    this.clock = deps.clock ?? (() => new Date().toISOString());
    this.idGen = deps.idGen ?? (() => `synth_${Math.random().toString(36).slice(2, 10)}`);
    this.audit = deps.audit ?? (() => undefined);
    this.tracker = deps.tracker ?? new GapTracker(this.clock);
    this.registry = deps.registry ?? new SynthRegistry();
  }

  get policy(): SynthesisPolicy {
    return this.deps.policy;
  }

  isEnabled(): boolean {
    return this.deps.policy.enabled === true;
  }

  /**
   * Record a tool-miss. Returns `{ triggered }` indicating whether the gap has now crossed the
   * threshold and synthesis should be offered/attempted. A hard no-op when disabled.
   */
  recordMiss(capability: string, context = ''): { triggered: boolean; count: number } {
    if (!this.isEnabled()) return { triggered: false, count: 0 };
    const miss = this.tracker.record(capability, context);
    const triggered = this.tracker.shouldTrigger(capability, this.deps.policy.missThreshold);
    if (triggered) this.audit('synth.gap_triggered', miss.key, { count: miss.count, threshold: this.deps.policy.missThreshold });
    return { triggered, count: miss.count };
  }

  /**
   * Run the full synthesis flow for a capability: author a draft, validate it (manifest/compile/test),
   * and — on success — create a PENDING record (or approved iff policy.autoApprove). NEVER executes the
   * tool. Returns the record or a failure reason. A hard no-op when disabled.
   */
  async synthesize(input: { capability: string; context?: string; actor?: string }): Promise<SynthesizeOutcome> {
    if (!this.isEnabled()) return { ok: false, reason: SYNTH_DISABLED };
    const actor = input.actor ?? 'system';
    const context = input.context ?? this.tracker.get(input.capability)?.lastContext ?? '';
    const gapKey = this.tracker.get(input.capability)?.key ?? input.capability;

    const req: AuthoringRequest = {
      capability: input.capability,
      context,
      allowedRuntimes: this.deps.policy.runtimes,
      grantable: {
        filesystem: this.deps.policy.allowFilesystem,
        network: this.deps.policy.allowNetwork,
        hosts: this.deps.policy.allowedHosts,
        shell: this.deps.policy.allowShell,
      },
    };

    let raw: string;
    try {
      raw = await this.deps.llm(buildAuthoringPrompt(req));
    } catch (err) {
      const reason = `authoring failed: ${err instanceof Error ? err.message : String(err)}`;
      this.audit('synth.author_failed', gapKey, { reason });
      return { ok: false, reason };
    }

    const parsed = parseDraft(raw);
    if (!parsed.ok) {
      this.audit('synth.author_invalid', gapKey, { errors: parsed.errors });
      return { ok: false, reason: `author output invalid: ${parsed.errors.join('; ')}` };
    }

    const validation = await validateDraft(parsed.draft, this.deps.policy, this.deps.validator);
    const autoApprove = this.deps.policy.autoApprove && validation.ok;
    const record: SynthesizedToolRecord = {
      id: this.idGen(),
      draft: parsed.draft,
      provenance: {
        actor,
        gapKey,
        trigger: context.slice(0, 500),
        author: 'llm',
        createdAt: this.clock(),
      },
      validation,
      approval: autoApprove ? 'approved' : 'pending',
      invocations: 0,
      ...(autoApprove ? { decidedBy: 'policy.autoApprove', decidedAt: this.clock() } : {}),
    };
    this.registry.add(record);
    // Clear the counter so the same gap doesn't immediately re-trigger another synthesis.
    this.tracker.reset(input.capability);

    if (!validation.ok) {
      this.audit('synth.rejected', parsed.draft.name, { id: record.id, stage: validation.stage, errors: validation.errors });
      return { ok: false, reason: `validation failed at ${validation.stage}: ${validation.errors.join('; ')}`, record };
    }
    this.audit('synth.created', parsed.draft.name, {
      id: record.id,
      approval: record.approval,
      capabilities: parsed.draft.capabilities,
      gapKey,
    });
    return { ok: true, record };
  }

  /** Approve a pending tool for first execution. Hard no-op when disabled. */
  approve(id: string, by = 'admin'): { ok: boolean; reason?: string; record?: SynthesizedToolRecord } {
    if (!this.isEnabled()) return { ok: false, reason: SYNTH_DISABLED };
    const existing = this.registry.get(id);
    if (!existing) return { ok: false, reason: `no synthesized tool "${id}"` };
    if (existing.approval === 'denied') return { ok: false, reason: `tool "${id}" was denied and cannot be approved; re-synthesize instead` };
    if (!existing.validation.ok) return { ok: false, reason: `tool "${id}" failed validation (${existing.validation.stage}) and cannot be approved` };
    // Re-check the manifest against the CURRENT policy at approval time (policy may have tightened).
    const recheck = checkManifest(existing.draft.capabilities, this.deps.policy);
    if (!recheck.ok) return { ok: false, reason: `tool "${id}" requests capabilities no longer permitted: ${recheck.violations.join('; ')}` };
    const record = this.registry.approve(id, by, this.clock());
    this.audit('synth.approved', record!.draft.name, { id, by });
    return { ok: true, record };
  }

  /** Deny a tool (it can never run). Hard no-op when disabled. */
  deny(id: string, by = 'admin'): { ok: boolean; reason?: string; record?: SynthesizedToolRecord } {
    if (!this.isEnabled()) return { ok: false, reason: SYNTH_DISABLED };
    const existing = this.registry.get(id);
    if (!existing) return { ok: false, reason: `no synthesized tool "${id}"` };
    const record = this.registry.deny(id, by, this.clock());
    this.audit('synth.denied', record!.draft.name, { id, by });
    return { ok: true, record };
  }

  /** List synthesized tool records (optionally filtered by approval state). */
  list(approval?: SynthesizedToolRecord['approval']): SynthesizedToolRecord[] {
    return this.registry.list(approval ? { approval } : undefined);
  }

  /** The gaps tracked so far (most-missed first). */
  gaps(): ReturnType<GapTracker['list']> {
    return this.tracker.list();
  }
}
