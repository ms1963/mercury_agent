/** Tiny argv parser: positionals plus `--flag value`, `--flag=value` and boolean `--flag`. */
export interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

const BOOLEAN = new Set(['json', 'help', 'yes', 'no-services', 'stream', 'watch', 'admin', 'force']);

export function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      if (v !== undefined) out.flags[k] = v;
      else if (BOOLEAN.has(k) || i + 1 >= argv.length || argv[i + 1]!.startsWith('--')) out.flags[k] = true;
      else out.flags[k] = argv[++i]!;
    } else if (a.startsWith('-') && a.length === 2) out.flags[a.slice(1)] = true;
    else out._.push(a);
  }
  return out;
}

export const flag = (a: Args, k: string): string | undefined => (typeof a.flags[k] === 'string' ? (a.flags[k] as string) : undefined);
