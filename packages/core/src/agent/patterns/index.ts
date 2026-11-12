/** Pattern registry: built-in patterns plus any registered by plugins. */
import { cotPattern, reactPattern } from './basic.js';
import { planExecutePattern } from './plan-execute.js';
import { criticPattern, reflexionPattern } from './reflective.js';
import { selfConsistencyPattern, totPattern } from './sampling.js';
import type { Pattern } from './types.js';

export const BUILTIN_PATTERNS: Pattern[] = [reactPattern, cotPattern, planExecutePattern, reflexionPattern, criticPattern, selfConsistencyPattern, totPattern];

export class PatternRegistry {
  private patterns = new Map<string, Pattern>();

  constructor(initial: Pattern[] = BUILTIN_PATTERNS) {
    for (const p of initial) this.register(p);
  }

  register(p: Pattern): void {
    this.patterns.set(p.name, p);
  }

  get(name: string): Pattern | undefined {
    return this.patterns.get(name);
  }

  list(): Pattern[] {
    return [...this.patterns.values()];
  }

  descriptions(): Record<string, string> {
    return Object.fromEntries(this.list().map((p) => [p.name, p.description]));
  }
}

export * from './types.js';
