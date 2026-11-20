/**
 * Prompt-injection taint tracking.
 *
 * Builds on the existing injection scanner + spotlighting. Tool OUTPUTS that come from
 * outside the trust boundary (web pages, files, e-mail, MCP results) are marked as
 * possibly contaminated ("tainted"). Taint is monotonic within a run: once untrusted
 * content has entered a run's context window it can influence everything the agent does
 * afterwards, so the whole run is considered tainted for the purpose of gating sensitive
 * actions. A finer value-level graph is also maintained (a derived value is tainted if any
 * of its inputs are) so callers can explain exactly which source contaminated an action.
 *
 * When a sensitive action would run in a tainted context, the executor consults policy-as-code
 * (and/or the approval gate) to block or route to approval — this module only tracks taint.
 */
import { scanForInjection, type InjectionScan } from './injection.js';
import { nowIso } from '../types/common.js';

export interface TaintSource {
  /** Where the tainted content came from, e.g. 'tool:web_fetch'. */
  source: string;
  at: string;
  /** Injection-scan verdict for the content, when it was scanned. */
  scan?: InjectionScan;
  /** True when the scanner flagged the content as a likely injection attempt. */
  suspicious: boolean;
}

export class TaintTracker {
  /** runId -> ordered list of tainting sources. */
  private byRun = new Map<string, TaintSource[]>();
  /** Value-level taint: label -> set of originating source labels. */
  private values = new Map<string, Set<string>>();

  /**
   * Mark a run as tainted by a source. When `content` is given it is scanned so the UI/audit
   * can show whether the untrusted content actually looks like an injection attempt.
   */
  mark(runId: string | undefined, source: string, content?: string): TaintSource {
    const scan = content !== undefined ? scanForInjection(content) : undefined;
    const entry: TaintSource = { source, at: nowIso(), scan, suspicious: scan?.suspicious ?? false };
    if (runId) {
      const list = this.byRun.get(runId) ?? [];
      list.push(entry);
      this.byRun.set(runId, list);
    }
    return entry;
  }

  /** True once any tainted source has entered the run's context (monotonic propagation). */
  isTainted(runId: string | undefined): boolean {
    return !!runId && (this.byRun.get(runId)?.length ?? 0) > 0;
  }

  /** True if any tainting source in the run was flagged as a likely injection attempt. */
  hasSuspicious(runId: string | undefined): boolean {
    return !!runId && (this.byRun.get(runId)?.some((s) => s.suspicious) ?? false);
  }

  /** The tainting sources recorded for a run, in order. */
  sources(runId: string | undefined): TaintSource[] {
    return runId ? [...(this.byRun.get(runId) ?? [])] : [];
  }

  /** Forget a run's taint (e.g. when the run ends). */
  clear(runId: string): void {
    this.byRun.delete(runId);
  }

  // ---- Value-level taint graph (optional, for precise provenance) ----

  /** Mark a value label as tainted at its origin. */
  taintValue(label: string, origin = label): void {
    const set = this.values.get(label) ?? new Set<string>();
    set.add(origin);
    this.values.set(label, set);
  }

  /** Derive a new value from inputs; it is tainted if any input is tainted. */
  derive(label: string, from: string[]): boolean {
    const origins = new Set<string>();
    for (const f of from) for (const o of this.values.get(f) ?? []) origins.add(o);
    if (origins.size) this.values.set(label, origins);
    return origins.size > 0;
  }

  /** Is a value label tainted (directly or via derivation)? */
  isValueTainted(label: string): boolean {
    return (this.values.get(label)?.size ?? 0) > 0;
  }

  /** The originating source labels that contaminated a value. */
  valueOrigins(label: string): string[] {
    return [...(this.values.get(label) ?? [])];
  }
}
