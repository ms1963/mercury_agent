/** Shared test helpers: isolated Mercury instances in throw-away data directories. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMercury, type Mercury } from '@mercury/runtime';

export function tempDir(prefix = 'mercury-test-'): string {
  return mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), prefix));
}

export async function makeMercury(overrides: Record<string, unknown> = {}, opts: Parameters<typeof createMercury>[0] = {}): Promise<{ m: Mercury; dir: string; close: () => Promise<void> }> {
  const dir = tempDir();
  const m = await createMercury({ isolated: true, startServices: false, ...opts, overrides: { dataDir: dir, logLevel: 'error', ...overrides } });
  return {
    m,
    dir,
    close: async () => {
      await m.shutdown();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
