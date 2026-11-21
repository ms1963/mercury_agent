/**
 * Feature — Sharable Agent Bundles ("Mercury packs").
 *
 * Exercised against the real subsystems (SQLite install ledger, canonical-JSON signing/verification,
 * the BundleService) with no product-code mocks. Covers:
 *   - round-trip export → install equality for ungoverned sections,
 *   - signature verification passes for a genuine bundle and FAILS on tampered contents,
 *   - version/compatibility gating (newer wire format / newer Mercury major refused),
 *   - idempotent re-install (same digest → no-op),
 *   - governance: policy/MCP sections are queued for approval, not applied silently,
 *   - inspect without install leaves config and ledger untouched.
 */
import { describe, expect, it } from 'vitest';
import {
  BundleService,
  ConfigSchema,
  Db,
  SqliteBundleStore,
  getPath,
  verifyBundle,
  type Bundle,
  type MercuryConfig,
} from '@mercury/core';

const SECRET = 'shared-signing-secret';

function cfgWith(values: Partial<Record<string, unknown>> = {}): MercuryConfig {
  const cfg = ConfigSchema.parse({});
  cfg.agent.personality = 'pirate-captain';
  (cfg as unknown as Record<string, unknown>).skills = { enabled: true, marker: 'src' };
  cfg.security.policies = [
    { id: 'p1', description: 'block big charges', tool: 'payment.charge', effect: 'deny' },
  ] as never;
  cfg.mcp.servers = { fs: { command: 'mcp-fs', args: [] } } as never;
  for (const [k, v] of Object.entries(values)) (cfg as unknown as Record<string, unknown>)[k] = v;
  return cfg;
}

function svc(cfg: MercuryConfig, over: Partial<ConstructorParameters<typeof BundleService>[2]> = {}) {
  const db = new Db(':memory:');
  const store = new SqliteBundleStore(db);
  const service = new BundleService(store, cfg, {
    dir: '/tmp/mercury-bundles-test',
    signingSecret: SECRET,
    requireSignature: true,
    autoApprovePolicy: false,
    autoApproveMcp: false,
    mercuryVersion: '1.3.0',
    ...over,
  });
  return { db, store, service };
}

describe('bundles — export & signing', () => {
  it('exports a signed bundle whose manifest records the requested sections', () => {
    const { service } = svc(cfgWith());
    const b = service.export({ name: 'team-pack', version: '2.1.0', sections: ['personality', 'policy'] });
    expect(b.manifest.name).toBe('team-pack');
    expect(b.manifest.version).toBe('2.1.0');
    expect(b.manifest.sections.sort()).toEqual(['personality', 'policy']);
    expect(b.manifest.mercuryVersion).toBe('1.3.0');
    expect(b.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyBundle(b, SECRET)).toBe(true);
    expect(b.contents.personality).toBe('pirate-captain');
  });

  it('signature is stable regardless of key order (canonical JSON)', () => {
    const { service } = svc(cfgWith());
    const a = service.export({ name: 'p', sections: ['personality', 'policy'] });
    const b = service.export({ name: 'p', sections: ['policy', 'personality'], createdAt: a.manifest.createdAt });
    expect(a.signature).toBe(b.signature);
  });
});

describe('bundles — round-trip export → install equality', () => {
  it('ungoverned sections installed into a fresh instance match the source', () => {
    const source = svc(cfgWith());
    const bundle = source.service.export({ name: 'migrate', sections: ['personality', 'skills'] });

    // Fresh target instance with different starting config.
    const targetCfg = cfgWith({ /* defaults */ });
    targetCfg.agent.personality = 'default';
    const target = svc(targetCfg);

    const res = target.service.install(bundle, { source: 'test' });
    expect(res.status).toBe('installed');
    expect(res.applied.sort()).toEqual(['personality', 'skills']);
    expect(res.pending).toHaveLength(0);
    expect(getPath(targetCfg, 'agent.personality')).toBe('pirate-captain');
    expect(getPath(targetCfg, 'skills')).toEqual({ enabled: true, marker: 'src' });
  });
});

describe('bundles — signature verification & tamper detection', () => {
  it('a genuine bundle verifies; tampering with contents invalidates the signature and install is refused', () => {
    const source = svc(cfgWith());
    const bundle = source.service.export({ name: 'secure', sections: ['personality'] });
    expect(verifyBundle(bundle, SECRET)).toBe(true);

    const tampered: Bundle = JSON.parse(JSON.stringify(bundle));
    tampered.contents.personality = 'evil-override';
    expect(verifyBundle(tampered, SECRET)).toBe(false);

    const target = svc(cfgWith());
    const res = target.service.install(tampered);
    expect(res.status).toBe('rejected');
    expect(res.issues.join(' ')).toMatch(/signature|tamper/i);
    // Config must be untouched by a rejected install.
    expect(target.store.list()).toHaveLength(0);
  });

  it('a bundle signed with a different secret fails verification here', () => {
    const other = svc(cfgWith(), { signingSecret: 'different-secret' });
    const bundle = other.service.export({ name: 'foreign', sections: ['personality'] });
    const here = svc(cfgWith());
    expect(here.service.inspect(bundle).signatureValid).toBe(false);
    expect(here.service.install(bundle).status).toBe('rejected');
  });

  it('with requireSignature off, an unsigned bundle installs but is flagged', () => {
    const other = svc(cfgWith(), { signingSecret: 'different-secret' });
    const bundle = other.service.export({ name: 'loose', sections: ['personality'] });
    const here = svc(cfgWith(), { requireSignature: false });
    const res = here.service.install(bundle);
    expect(res.status).toBe('installed');
    expect(res.issues.join(' ')).toMatch(/not verified/i);
  });
});

describe('bundles — version / compatibility gating', () => {
  it('refuses a bundle from a newer wire-format major', () => {
    const source = svc(cfgWith());
    const bundle = source.service.export({ name: 'future', sections: ['personality'] });
    const future: Bundle = JSON.parse(JSON.stringify(bundle));
    future.manifest.formatVersion = 99;
    const target = svc(cfgWith(), { requireSignature: false });
    const res = target.service.install(future);
    expect(res.status).toBe('rejected');
    expect(res.issues.join(' ')).toMatch(/format/i);
  });

  it('refuses a bundle built for a newer Mercury major', () => {
    const source = svc(cfgWith(), { mercuryVersion: '9.0.0' });
    const bundle = source.service.export({ name: 'newer', sections: ['personality'] });
    const target = svc(cfgWith(), { mercuryVersion: '1.3.0' });
    const insp = target.service.inspect(bundle);
    expect(insp.compatible).toBe(false);
    expect(target.service.install(bundle).status).toBe('rejected');
  });
});

describe('bundles — idempotent install', () => {
  it('re-installing the identical bundle is a no-op', () => {
    const source = svc(cfgWith());
    const bundle = source.service.export({ name: 'idem', sections: ['personality', 'skills'] });
    const target = svc(cfgWith());

    const first = target.service.install(bundle);
    expect(first.status).toBe('installed');
    expect(first.alreadyInstalled).toBe(false);

    const second = target.service.install(bundle);
    expect(second.status).toBe('unchanged');
    expect(second.alreadyInstalled).toBe(true);
    // The ledger has a single row.
    expect(target.store.list()).toHaveLength(1);
  });
});

describe('bundles — governance for policy / MCP sections', () => {
  it('queues governed sections for approval instead of applying them silently', () => {
    const source = svc(cfgWith());
    const bundle = source.service.export({ name: 'gov', sections: ['personality', 'policy', 'mcp'] });

    const targetCfg = cfgWith();
    targetCfg.security.policies = [] as never;
    targetCfg.mcp.servers = {} as never;
    const target = svc(targetCfg);

    const res = target.service.install(bundle);
    expect(res.status).toBe('installed');
    expect(res.applied).toContain('personality');
    expect(res.pending.sort()).toEqual(['mcp', 'policy']);
    // Governed sections NOT applied yet.
    expect(getPath(targetCfg, 'security.policies')).toEqual([]);
    expect(getPath(targetCfg, 'mcp.servers')).toEqual({});

    // Approve → governed sections are applied.
    const rec = target.store.list()[0];
    const updated = target.service.approvePending(rec.id, undefined, bundle);
    expect(updated!.applied.sort()).toContain('policy');
    expect(getPath(targetCfg, 'mcp.servers')).toEqual({ fs: { command: 'mcp-fs', args: [] } });
  });

  it('auto-approves governed sections only when explicitly configured', () => {
    const source = svc(cfgWith());
    const bundle = source.service.export({ name: 'auto', sections: ['policy', 'mcp'] });
    const targetCfg = cfgWith();
    targetCfg.security.policies = [] as never;
    const target = svc(targetCfg, { autoApprovePolicy: true, autoApproveMcp: true });
    const res = target.service.install(bundle);
    expect(res.applied.sort()).toEqual(['mcp', 'policy']);
    expect(res.pending).toHaveLength(0);
  });
});

describe('bundles — inspect without install', () => {
  it('inspect reports signature/compat/governed without changing config or the ledger', () => {
    const source = svc(cfgWith());
    const bundle = source.service.export({ name: 'look', sections: ['personality', 'policy'] });
    const target = svc(cfgWith());
    const before = getPath(target.service['config'] as never, 'agent.personality');

    const insp = target.service.inspect(bundle);
    expect(insp.signatureValid).toBe(true);
    expect(insp.compatible).toBe(true);
    expect(insp.governed).toEqual(['policy']);
    expect(insp.digest).toMatch(/^[0-9a-f]{64}$/);

    // Nothing installed, nothing changed.
    expect(target.store.list()).toHaveLength(0);
    expect(getPath(target.service['config'] as never, 'agent.personality')).toBe(before);
  });

  it('read() parses a bundle from a JSON string', () => {
    const source = svc(cfgWith());
    const bundle = source.service.export({ name: 'parse', sections: ['personality'] });
    const target = svc(cfgWith());
    const parsed = target.service.read(JSON.stringify(bundle));
    expect(parsed.manifest.name).toBe('parse');
    expect(verifyBundle(parsed, SECRET)).toBe(true);
  });
});
