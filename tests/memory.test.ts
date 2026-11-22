import { describe, it, expect } from 'vitest';
import { makeMercury } from './helpers.js';

describe('governed memory & knowledge', () => {
  it('remembers and recalls (back-compat signatures still work)', async () => {
    const { m, close } = await makeMercury();
    try {
      const f = await m.memory.remember('u1', 'The sky is blue');
      expect(f.id).toBeTruthy();
      expect(f.namespace).toBe('default');
      const hits = await m.memory.recall('u1', 'sky', 5);
      expect(hits.some((h) => h.content.includes('sky'))).toBe(true);
      expect(await m.memory.forget('u1', f.id)).toBeTruthy();
    } finally {
      await close();
    }
  });

  it('redacts PII when governance pii.redact is on', async () => {
    const { m, close } = await makeMercury({ memory: { governance: { mode: 'soft', pii: { detect: true, redact: true, block: false } } } });
    try {
      const f = await m.memory.remember('u1', 'contact me at john@example.com please');
      expect(f.content).not.toContain('john@example.com');
      expect(f.content).toMatch(/\[redacted|REDACTED|\[email/i);
    } finally {
      await close();
    }
  });

  it('blocks PII writes when pii.block is on', async () => {
    const { m, close } = await makeMercury({ memory: { governance: { mode: 'strict', pii: { detect: true, redact: false, block: true } } } });
    try {
      await expect(m.memory.remember('u1', 'my card is 4111111111111111')).rejects.toBeTruthy();
    } finally {
      await close();
    }
  });

  it('isolates namespaces', async () => {
    const { m, close } = await makeMercury();
    try {
      await m.memory.remember('u1', 'alpha note', { namespace: 'projA' });
      await m.memory.remember('u1', 'beta note', { namespace: 'projB' });
      const a = await m.memory.recall('u1', 'note', 5, undefined, { namespace: 'projA' });
      expect(a.every((h) => h.content.includes('alpha'))).toBe(true);
      const ns = m.memory.namespaces('u1').map((n) => n.namespace);
      expect(ns).toContain('projA');
      expect(ns).toContain('projB');
    } finally {
      await close();
    }
  });

  it('prunes by max items per namespace', async () => {
    const { m, close } = await makeMercury({ memory: { retention: { maxItemsPerNamespace: 2 } } });
    try {
      for (let i = 0; i < 5; i++) await m.memory.remember('u1', `fact number ${i}`, { namespace: 'ns1' });
      const count = m.memory.namespaces('u1').find((n) => n.namespace === 'ns1')?.count ?? 0;
      expect(count).toBeLessThanOrEqual(2);
    } finally {
      await close();
    }
  });

  it('writes a queryable audit ledger', async () => {
    const { m, close } = await makeMercury({ memory: { governance: { mode: 'soft', pii: { detect: true, redact: true } } } });
    try {
      await m.memory.remember('u1', 'plain note');
      const audit = m.memory.auditLog({ userId: 'u1' });
      expect(audit.total).toBeGreaterThan(0);
      expect(audit.entries[0]!.action).toBeTruthy();
    } finally {
      await close();
    }
  });

  it('ingests knowledge and searches it with provenance', async () => {
    const { m, close } = await makeMercury({ memory: { knowledge: { enabled: true } } });
    try {
      const r = await m.memory.addKnowledge('u1', { title: 'Doc', content: 'Mercury is a self-hosted agentic AI platform written in TypeScript. '.repeat(40) });
      expect(r.chunks).toBeGreaterThan(0);
      const chunks = await m.memory.searchKnowledge('u1', 'agentic platform TypeScript', 3);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0]!.sourceId).toBe(r.sourceId);
      expect(chunks[0]!.title).toBe('Doc');
    } finally {
      await close();
    }
  });
});
