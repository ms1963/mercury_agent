/**
 * Self-extending tools (dynamic tool synthesis) — shared types.
 *
 * Mercury can draft a NEW tool when it repeatedly needs a capability no registered tool provides.
 * This is a high-risk capability, so it is DISABLED BY DEFAULT and every step is gated:
 *   gap detection (threshold) → authoring (injected LLM) → validation (compile + generated test +
 *   capability-manifest policy) → human/policy approval → sandboxed out-of-process execution →
 *   provenance + audit → persistence (as a polyglot tool folder that survives restarts).
 *
 * All the logic in this folder is PURE over injected runners (LLM, compiler, test runner, clock,
 * id generator, audit sink) so it is unit-testable offline with stubs — mirroring how the hooks and
 * moa subsystems inject their runners. No module here spawns a process, calls a real model, or
 * eval()s generated code in the main runtime.
 */

/** Runtime a synthesized tool's implementation is written in (maps to a polyglot command). */
export type SynthRuntime = 'python' | 'node';

/** The set of all supported runtimes, for validation. */
export const SYNTH_RUNTIMES: readonly SynthRuntime[] = ['python', 'node'];

/**
 * A least-privilege capability manifest the author MUST declare for a synthesized tool. Anything
 * not declared here is DENIED by the sandbox policy (deny-by-default). The policy, in turn, decides
 * whether a declared capability is even allowed to be granted.
 */
export interface CapabilityManifest {
  /** Needs to read/write files (inside the sandbox workdir only — never ambient host paths). */
  filesystem: boolean;
  /** Network reach: 'none' (default, no network) or 'allow' (restricted to `hosts`). */
  network: 'none' | 'allow';
  /** When network is 'allow', the explicit host allowlist. An empty list with 'allow' is invalid. */
  hosts: string[];
  /** Needs to run shell/host commands. The most dangerous capability; off unless the policy allows. */
  shell: boolean;
}

/** A fresh default manifest: no capabilities at all (deny-by-default baseline). */
export function emptyManifest(): CapabilityManifest {
  return { filesystem: false, network: 'none', hosts: [], shell: false };
}

/**
 * A tool draft produced by the authoring step (parsed + structurally validated from the LLM
 * output). Not yet compiled, tested, approved or registered.
 */
export interface SynthesizedToolDraft {
  /** Tool name (slug): `[a-z][a-z0-9_]{2,63}` — also the persisted folder name. */
  name: string;
  description: string;
  /** JSON schema object for the tool's arguments (sent to the model when the tool is live). */
  parameters: Record<string, unknown>;
  runtime: SynthRuntime;
  /** The implementation source (polyglot protocol: reads JSON args on stdin, writes result stdout). */
  code: string;
  /** A unit test for the implementation, run IN ISOLATION by the validation gate before registration. */
  test: string;
  /** The least-privilege capabilities the tool requires. */
  capabilities: CapabilityManifest;
}

/** Approval lifecycle of a synthesized tool. A tool never runs while `pending` or `denied`. */
export type SynthApprovalState = 'pending' | 'approved' | 'denied';

/** Where a validation attempt stopped (for honest reporting). */
export type ValidationStage = 'manifest' | 'compile' | 'test' | 'passed';

/** The outcome of running the validation gate against a draft. */
export interface ValidationResult {
  ok: boolean;
  stage: ValidationStage;
  /** Human-readable reasons (policy violations, compiler errors, failing test output). */
  errors: string[];
  /** Captured stdout/stderr of the compile + test steps, for the audit trail. */
  compileOutput?: string;
  testOutput?: string;
}

/** Provenance captured for every synthesized tool — who/what made it and why. */
export interface SynthProvenance {
  /** Principal/user id (or 'system') that triggered the synthesis. */
  actor: string;
  /** The capability key (gap signature) that repeatedly missed. */
  gapKey: string;
  /** The triggering prompt/context (truncated) that motivated the tool. */
  trigger: string;
  /** Model slot / author identifier that drafted the tool (e.g. 'auto', 'llm'). */
  author: string;
  /** ISO timestamp of creation. */
  createdAt: string;
}

/** A fully-tracked synthesized tool record: draft + provenance + validation + approval state. */
export interface SynthesizedToolRecord {
  id: string;
  draft: SynthesizedToolDraft;
  provenance: SynthProvenance;
  validation: ValidationResult;
  approval: SynthApprovalState;
  /** Who approved/denied and when (set on transition). */
  decidedBy?: string;
  decidedAt?: string;
  /** Number of times the tool has been invoked since approval (audit counter). */
  invocations: number;
}

/** Policy controlling what synthesis is allowed to do. All of it is admin-controlled config. */
export interface SynthesisPolicy {
  /** Master kill-switch. When false, every synthesis entry point is a hard no-op. */
  enabled: boolean;
  /** How many times the SAME gap must be seen before synthesis is triggered (>= 1). */
  missThreshold: number;
  /** Auto-approve a validated tool for first run WITHOUT a human (dangerous; default false). */
  autoApprove: boolean;
  /** Capabilities the policy is willing to grant. A draft requesting more is rejected. */
  allowFilesystem: boolean;
  allowNetwork: boolean;
  /** Hosts the policy permits for networked tools (a tool's hosts must be a subset). */
  allowedHosts: string[];
  allowShell: boolean;
  /** Runtimes a synthesized tool may be written in. */
  runtimes: SynthRuntime[];
  /** Per-tool wall-clock limit (ms) applied in the sandbox. */
  timeoutMs: number;
  /** Max characters of a synthesized tool's output passed back to the model. */
  maxOutputChars: number;
}

/** An injected LLM runner that drafts a tool from an authoring prompt. Returns raw text. */
export type SynthLlmRunner = (prompt: string) => Promise<string>;

/** Normalized output of an injected compile/test runner. */
export interface RunnerOutput {
  ok: boolean;
  output: string;
}

/** An injected runner that typechecks/compiles a draft's code in isolation. */
export type SynthCompileRunner = (draft: SynthesizedToolDraft) => Promise<RunnerOutput> | RunnerOutput;

/** An injected runner that executes a draft's generated unit test in isolation. */
export type SynthTestRunner = (draft: SynthesizedToolDraft) => Promise<RunnerOutput> | RunnerOutput;

/** An injected audit sink (the real one is {@link AuditLog.record}). */
export type SynthAuditSink = (action: string, target: string, details: Record<string, unknown>) => void;

/** An injected clock (ISO string) so timestamps are deterministic in tests. */
export type SynthClock = () => string;

/** An injected id generator so ids are deterministic in tests. */
export type SynthIdGen = () => string;
