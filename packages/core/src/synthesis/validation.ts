/**
 * Validation gate for self-extending tools.
 *
 * BEFORE a synthesized tool can be registered it must pass, in order:
 *   1. manifest  — the declared capabilities are within policy (deny-by-default).
 *   2. compile   — the implementation typechecks / compiles (injected compile runner).
 *   3. test      — the generated unit test passes IN ISOLATION (injected test runner).
 * A failure at any stage rejects the draft and records WHERE it failed, so nothing that does not
 * compile, whose test fails, or that over-asks for privileges is ever registered or run.
 *
 * Pure orchestration: the compile + test runners are injected (the real ones spawn a child process
 * behind the polyglot/sandbox boundary; tests inject stubs).
 */
import { checkDraftShape, checkManifest } from './policy.js';
import type {
  SynthCompileRunner,
  SynthesisPolicy,
  SynthesizedToolDraft,
  SynthTestRunner,
  ValidationResult,
} from './types.js';

export interface ValidatorDeps {
  compile: SynthCompileRunner;
  test: SynthTestRunner;
}

/**
 * Run the full validation gate on a draft. Short-circuits at the first failing stage. Never throws —
 * an exception from a runner is captured as a failure of that stage.
 */
export async function validateDraft(
  draft: SynthesizedToolDraft,
  policy: SynthesisPolicy,
  deps: ValidatorDeps,
): Promise<ValidationResult> {
  // Stage 1 — manifest + shape (pure, cheapest, fail first).
  const shapeErrors = checkDraftShape(draft, policy);
  const manifest = checkManifest(draft.capabilities, policy);
  if (shapeErrors.length || !manifest.ok) {
    return { ok: false, stage: 'manifest', errors: [...shapeErrors, ...manifest.violations] };
  }

  // Stage 2 — compile / typecheck.
  let compileOut: { ok: boolean; output: string };
  try {
    compileOut = await deps.compile(draft);
  } catch (err) {
    compileOut = { ok: false, output: err instanceof Error ? err.message : String(err) };
  }
  if (!compileOut.ok) {
    return { ok: false, stage: 'compile', errors: [`implementation failed to compile`], compileOutput: compileOut.output };
  }

  // Stage 3 — generated test in isolation.
  let testOut: { ok: boolean; output: string };
  try {
    testOut = await deps.test(draft);
  } catch (err) {
    testOut = { ok: false, output: err instanceof Error ? err.message : String(err) };
  }
  if (!testOut.ok) {
    return { ok: false, stage: 'test', errors: ['generated unit test failed'], compileOutput: compileOut.output, testOutput: testOut.output };
  }

  return { ok: true, stage: 'passed', errors: [], compileOutput: compileOut.output, testOutput: testOut.output };
}
