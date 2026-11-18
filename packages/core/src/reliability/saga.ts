/**
 * Saga orchestrator — run an ordered list of steps, and if any step fails, undo
 * the ones that already completed by running their compensations in reverse order.
 *
 * This implements the saga pattern for multi-step operations that have no shared
 * transaction (e.g. "create a record, call an external API, write a file"): each
 * step declares how to compensate (roll back) its own effect, and the orchestrator
 * guarantees that on failure the completed steps are compensated newest-first.
 *
 * Compensation is best-effort: every completed step's `compensate` is attempted
 * even if an earlier compensation throws. Compensation errors are collected and
 * surfaced on the thrown {@link SagaError} without masking the original failure.
 *
 * Dependency-free; observability is via the optional `onEvent` hook.
 */
import { MercuryError, errorMessage } from '../types/common.js';

/** One saga step. `T` is the type produced by `action` and consumed by `compensate`. */
export interface SagaStep<Ctx, T = unknown> {
  /** Unique, human-readable step name (used as the result key and in events). */
  name: string;
  /** Perform the step. Its resolved value is stored under `name` in the results. */
  action: (ctx: Ctx) => Promise<T>;
  /** Undo the step's effect. Called with the context and the value `action` returned. */
  compensate?: (ctx: Ctx, result: T) => Promise<void>;
}

/** Lifecycle phases reported to {@link SagaOptions.onEvent}. */
export type SagaPhase =
  | 'action'
  | 'action_ok'
  | 'action_error'
  | 'compensate'
  | 'compensate_ok'
  | 'compensate_error';

/** A single saga lifecycle event. */
export interface SagaEvent {
  phase: SagaPhase;
  step: string;
  error?: unknown;
}

/** Outcome of one compensation attempt. */
export interface CompensationOutcome {
  step: string;
  ok: boolean;
  error?: unknown;
}

/** Successful saga run result: the accumulated step results plus the final context. */
export interface SagaRunResult<Ctx> {
  results: Record<string, unknown>;
  ctx: Ctx;
}

/** Options for a {@link Saga}. */
export interface SagaOptions {
  /** Optional name for error messages/events. */
  name?: string;
  /** Observability hook invoked for every action/compensation phase. */
  onEvent?: (event: SagaEvent) => void;
}

/**
 * Error thrown when a saga step fails. Carries the failing step name, the original
 * cause, and the outcome of every compensation that was attempted.
 */
export class SagaError extends MercuryError {
  readonly domain = 'reliability';
  constructor(
    message: string,
    readonly failedStep: string,
    /** The original error thrown by the failing step's `action`. */
    override readonly cause: unknown,
    /** One entry per completed step whose compensation was attempted (reverse order). */
    readonly compensations: CompensationOutcome[],
  ) {
    super(message, 'saga_failed', 'reliability', 500);
    this.name = 'SagaError';
  }
}

/**
 * A saga: build it with {@link step} (chainable), then {@link run} it with a context.
 *
 * @typeParam Ctx - the shared context object threaded through every step.
 */
export class Saga<Ctx = Record<string, unknown>> {
  private readonly steps: SagaStep<Ctx>[] = [];
  constructor(private readonly options: SagaOptions = {}) {}

  /** Append a step. Returns `this` for chaining. */
  step<T>(step: SagaStep<Ctx, T>): this {
    this.steps.push(step as SagaStep<Ctx>);
    return this;
  }

  /**
   * Execute all steps in order.
   *
   * @returns the accumulated results (keyed by step name) and the context.
   * @throws {@link SagaError} if any step fails, after compensating completed steps.
   */
  async run(ctx: Ctx): Promise<SagaRunResult<Ctx>> {
    const completed: Array<{ step: SagaStep<Ctx>; result: unknown }> = [];
    const results: Record<string, unknown> = {};
    const emit = this.options.onEvent;

    for (const step of this.steps) {
      emit?.({ phase: 'action', step: step.name });
      try {
        const result = await step.action(ctx);
        results[step.name] = result;
        completed.push({ step, result });
        emit?.({ phase: 'action_ok', step: step.name });
      } catch (err) {
        emit?.({ phase: 'action_error', step: step.name, error: err });
        const compensations = await this.compensate(ctx, completed);
        const label = this.options.name ? `saga '${this.options.name}'` : 'saga';
        throw new SagaError(`${label} step '${step.name}' failed: ${errorMessage(err)}`, step.name, err, compensations);
      }
    }
    return { results, ctx };
  }

  /** Run compensations for completed steps in reverse order, best-effort. */
  private async compensate(ctx: Ctx, completed: Array<{ step: SagaStep<Ctx>; result: unknown }>): Promise<CompensationOutcome[]> {
    const outcomes: CompensationOutcome[] = [];
    const emit = this.options.onEvent;
    for (let i = completed.length - 1; i >= 0; i--) {
      const { step, result } = completed[i]!;
      if (!step.compensate) continue;
      emit?.({ phase: 'compensate', step: step.name });
      try {
        await step.compensate(ctx, result);
        outcomes.push({ step: step.name, ok: true });
        emit?.({ phase: 'compensate_ok', step: step.name });
      } catch (compErr) {
        outcomes.push({ step: step.name, ok: false, error: compErr });
        emit?.({ phase: 'compensate_error', step: step.name, error: compErr });
      }
    }
    return outcomes;
  }
}

/**
 * Functional convenience: build and run a saga from an array of steps in one call.
 */
export async function runSaga<Ctx>(steps: Array<SagaStep<Ctx>>, ctx: Ctx, options: SagaOptions = {}): Promise<SagaRunResult<Ctx>> {
  const saga = new Saga<Ctx>(options);
  for (const s of steps) saga.step(s);
  return saga.run(ctx);
}
