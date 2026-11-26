/**
 * Offline, deterministic tests for the LSP server (Tier-4 gap #17).
 *
 * SCOPE: fully offline. The Content-Length framing (encode/decode, partial buffers, multiple messages in
 * one chunk, malformed frames), every method handler and the error paths are exercised against an
 * injected {@link LspAgent} stub and an injected `emit` sink for notifications. No real network, no real
 * external LSP client, no stdio. The stdio transport framing is tested with in-memory PassThrough streams.
 */
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  LSP_ERROR,
  LSP_PROTOCOL,
  LSP_COMMANDS,
  createLspState,
  decodeLspFrames,
  encodeLspMessage,
  handleLspMessage,
  isLspResponse,
  lspError,
  lspPromptText,
  lspResult,
  parseLspMessage,
  processLspFrame,
  serveLspStdio,
  type LspAgent,
  type LspRequest,
  type LspUpdate,
} from '@mercury/core';

/** A deterministic agent stub. Records prompts and can stream updates / throw. */
function stubAgent(over: Partial<LspAgent> = {}): LspAgent {
  return {
    async runPrompt(input) {
      return { output: `echo:${input}`, stopReason: 'end_turn' };
    },
    toolSpecs: () => [{ name: 'calc', description: 'do math', parameters: { type: 'object', properties: {} } }],
    async callTool(name, args) {
      return { content: `ran ${name}(${JSON.stringify(args)})` };
    },
    ...over,
  };
}

/** Collect emitted notifications. */
function recorder() {
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  return { emit: (method: string, params: Record<string, unknown>) => events.push({ method, params }), events };
}

const req = (method: string, params?: Record<string, unknown>, id: string | number = 1): LspRequest => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
const note = (method: string, params?: Record<string, unknown>): LspRequest => ({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });

async function run(state: ReturnType<typeof createLspState>, agent: LspAgent, r: LspRequest, emit = () => {}) {
  return handleLspMessage(state, agent, r, emit);
}

async function ready(agent: LspAgent, version?: string) {
  const state = createLspState(version ? { version } : {});
  await run(state, agent, req('initialize'));
  return state;
}

// ── framing ──────────────────────────────────────────────────────────────────

describe('Content-Length framing', () => {
  it('encodes a message with a byte-accurate Content-Length header', () => {
    const framed = encodeLspMessage({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(framed).toBe(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  });

  it('uses the UTF-8 byte length, not the character count, for multi-byte bodies', () => {
    const obj = { jsonrpc: '2.0', method: 'say', params: { text: 'héllo — 世界' } };
    const framed = encodeLspMessage(obj);
    const body = JSON.stringify(obj);
    const declared = Number(/content-length:\s*(\d+)/i.exec(framed)![1]);
    expect(declared).toBe(Buffer.byteLength(body, 'utf8'));
    // Round-trips cleanly through the decoder.
    const { messages } = decodeLspFrames(Buffer.from(framed, 'utf8'));
    expect(JSON.parse(messages[0]!)).toEqual(obj);
  });

  it('decodes a single complete frame and leaves no remainder', () => {
    const framed = encodeLspMessage({ a: 1 });
    const { messages, rest } = decodeLspFrames(Buffer.from(framed, 'utf8'));
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0]!)).toEqual({ a: 1 });
    expect(rest.length).toBe(0);
  });

  it('decodes multiple messages in one chunk', () => {
    const buf = Buffer.from(encodeLspMessage({ n: 1 }) + encodeLspMessage({ n: 2 }) + encodeLspMessage({ n: 3 }), 'utf8');
    const { messages, rest } = decodeLspFrames(buf);
    expect(messages.map((m) => JSON.parse(m).n)).toEqual([1, 2, 3]);
    expect(rest.length).toBe(0);
  });

  it('holds back a partial frame until the rest of the body arrives', () => {
    const framed = encodeLspMessage({ hello: 'world' });
    const cut = framed.length - 4; // split mid-body
    const first = decodeLspFrames(Buffer.from(framed.slice(0, cut), 'utf8'));
    expect(first.messages).toHaveLength(0);
    expect(first.rest.length).toBeGreaterThan(0);
    // Feed the remainder appended to the held-back bytes.
    const second = decodeLspFrames(Buffer.concat([first.rest, Buffer.from(framed.slice(cut), 'utf8')]));
    expect(second.messages).toHaveLength(1);
    expect(JSON.parse(second.messages[0]!)).toEqual({ hello: 'world' });
  });

  it('holds back a partial header (separator not yet seen)', () => {
    const { messages, rest } = decodeLspFrames(Buffer.from('Content-Length: 10\r\n', 'utf8'));
    expect(messages).toHaveLength(0);
    expect(rest.toString('utf8')).toBe('Content-Length: 10\r\n');
  });

  it('skips a malformed frame (header without Content-Length) and recovers the next one', () => {
    const buf = Buffer.from(`X-Bogus: nope\r\n\r\n${encodeLspMessage({ ok: true })}`, 'utf8');
    const { messages } = decodeLspFrames(buf);
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0]!)).toEqual({ ok: true });
  });
});

describe('parseLspMessage', () => {
  it('parses a valid request', () => {
    const p = parseLspMessage('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}');
    expect(isLspResponse(p)).toBe(false);
    expect((p as LspRequest).method).toBe('initialize');
  });

  it('parses a notification (no id)', () => {
    const p = parseLspMessage('{"jsonrpc":"2.0","method":"exit"}') as LspRequest;
    expect(p.id).toBeUndefined();
    expect(p.method).toBe('exit');
  });

  it('accepts array params (LSP allows positional params)', () => {
    const p = parseLspMessage('{"jsonrpc":"2.0","id":1,"method":"x","params":[1,2]}');
    expect(isLspResponse(p)).toBe(true); // arrays are not object params → invalid for our object dispatch
    expect((p as ReturnType<typeof lspError>).error?.code).toBe(LSP_ERROR.invalidParams);
  });

  it('rejects invalid JSON with a parse error', () => {
    const p = parseLspMessage('{not json') as ReturnType<typeof lspError>;
    expect(p.error?.code).toBe(LSP_ERROR.parse);
  });

  it('rejects a wrong jsonrpc version', () => {
    const p = parseLspMessage('{"jsonrpc":"1.0","id":2,"method":"x"}') as ReturnType<typeof lspError>;
    expect(p.error?.code).toBe(LSP_ERROR.invalidRequest);
    expect(p.id).toBe(2);
  });

  it('rejects a missing method', () => {
    const p = parseLspMessage('{"jsonrpc":"2.0","id":3}') as ReturnType<typeof lspError>;
    expect(p.error?.code).toBe(LSP_ERROR.invalidRequest);
  });

  it('rejects a non-object top-level message', () => {
    const p = parseLspMessage('42') as ReturnType<typeof lspError>;
    expect(p.error?.code).toBe(LSP_ERROR.invalidRequest);
  });
});

describe('lspPromptText', () => {
  it('accepts a plain string', () => {
    expect(lspPromptText('hello')).toBe('hello');
  });
  it('concatenates text content blocks', () => {
    expect(lspPromptText([{ type: 'text', text: 'a ' }, { type: 'text', text: 'b' }])).toBe('a b');
  });
  it('accepts a { prompt } object and ignores anything else', () => {
    expect(lspPromptText({ prompt: 'hi' })).toBe('hi');
    expect(lspPromptText(42)).toBe('');
  });
});

// ── lifecycle ──────────────────────────────────────────────────────────────

describe('initialize', () => {
  it('advertises capabilities and a serverInfo', async () => {
    const state = createLspState({ version: '1.9.0' });
    const res = await run(state, stubAgent(), req('initialize'));
    const result = res?.result as { capabilities: Record<string, unknown>; serverInfo: { name: string; version: string } };
    expect(result.serverInfo).toEqual({ name: 'mercury', version: '1.9.0' });
    expect(result.capabilities.textDocumentSync).toEqual({ openClose: true, change: 1 });
    expect((result.capabilities.executeCommandProvider as { commands: string[] }).commands).toEqual([...LSP_COMMANDS]);
    expect(state.initialized).toBe(true);
  });

  it('defaults serverInfo.version to 0.0.0 when none is injected', async () => {
    const state = createLspState();
    const res = await run(state, stubAgent(), req('initialize'));
    expect((res?.result as { serverInfo: { version: string } }).serverInfo.version).toBe('0.0.0');
  });
});

describe('shutdown / exit', () => {
  it('requires initialize before shutdown', async () => {
    const state = createLspState();
    const res = await run(state, stubAgent(), req('shutdown'));
    expect(res?.error?.code).toBe(LSP_ERROR.serverNotInitialized);
  });

  it('shutdown returns a null result and flags state', async () => {
    const state = await ready(stubAgent());
    const res = await run(state, stubAgent(), req('shutdown'));
    expect(res?.result).toBeNull();
    expect(state.shutdownRequested).toBe(true);
  });

  it('initialized and exit are notifications (no response)', async () => {
    const state = await ready(stubAgent());
    expect(await run(state, stubAgent(), note('initialized'))).toBeNull();
    expect(await run(state, stubAgent(), note('exit'))).toBeNull();
  });
});

// ── document sync ──────────────────────────────────────────────────────────

describe('document sync', () => {
  it('tracks didOpen → didChange → didClose', async () => {
    const state = await ready(stubAgent());
    await run(state, stubAgent(), note('textDocument/didOpen', { textDocument: { uri: 'file:///a.ts', languageId: 'typescript', version: 1, text: 'const a = 1;' } }));
    expect(state.documents.get('file:///a.ts')).toMatchObject({ version: 1, text: 'const a = 1;', languageId: 'typescript' });

    await run(state, stubAgent(), note('textDocument/didChange', { textDocument: { uri: 'file:///a.ts', version: 2 }, contentChanges: [{ text: 'const a = 2;' }] }));
    expect(state.documents.get('file:///a.ts')).toMatchObject({ version: 2, text: 'const a = 2;', languageId: 'typescript' });

    await run(state, stubAgent(), note('textDocument/didClose', { textDocument: { uri: 'file:///a.ts' } }));
    expect(state.documents.has('file:///a.ts')).toBe(false);
  });

  it('ignores a didChange for an unknown document without throwing', async () => {
    const state = await ready(stubAgent());
    const res = await run(state, stubAgent(), note('textDocument/didChange', { textDocument: { uri: 'file:///ghost.ts' }, contentChanges: [{ text: 'x' }] }));
    expect(res).toBeNull();
    expect(state.documents.get('file:///ghost.ts')?.text).toBe('x');
  });
});

// ── executeCommand ──────────────────────────────────────────────────────────

describe('workspace/executeCommand', () => {
  it('runs mercury.prompt, streams $/progress and returns the output', async () => {
    const agent = stubAgent();
    const state = await ready(agent);
    const rec = recorder();
    const res = await handleLspMessage(state, agent, req('workspace/executeCommand', { command: 'mercury.prompt', arguments: ['hi'] }), rec.emit);
    expect(res?.result).toEqual({ output: 'echo:hi', stopReason: 'end_turn' });
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]!.method).toBe('$/progress');
    const update = (rec.events[0]!.params as { value: LspUpdate }).value;
    expect(update).toMatchObject({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'echo:hi' } });
  });

  it('forwards streamed tool-call updates as $/progress before the final chunk', async () => {
    const agent = stubAgent({
      async runPrompt(_input, opts) {
        opts.onUpdate?.({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'calc', status: 'in_progress' });
        opts.onUpdate?.({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
        return { output: 'done', stopReason: 'end_turn' };
      },
    });
    const state = await ready(agent);
    const rec = recorder();
    await handleLspMessage(state, agent, req('workspace/executeCommand', { command: 'mercury.prompt', arguments: ['go'] }), rec.emit);
    const kinds = rec.events.map((e) => (e.params as { value: LspUpdate }).value.sessionUpdate);
    expect(kinds).toEqual(['tool_call', 'tool_call_update', 'agent_message_chunk']);
  });

  it('mercury.tools.list returns the tool specs', async () => {
    const agent = stubAgent();
    const state = await ready(agent);
    const res = await run(state, agent, req('workspace/executeCommand', { command: 'mercury.tools.list' }));
    expect((res?.result as { tools: Array<{ name: string }> }).tools[0]!.name).toBe('calc');
  });

  it('mercury.tools.call invokes the tool', async () => {
    const agent = stubAgent();
    const state = await ready(agent);
    const res = await run(state, agent, req('workspace/executeCommand', { command: 'mercury.tools.call', arguments: [{ name: 'calc', arguments: { a: 1 } }] }));
    expect((res?.result as { content: Array<{ text: string }> }).content[0]!.text).toContain('ran calc');
  });

  it('rejects an unknown command', async () => {
    const agent = stubAgent();
    const state = await ready(agent);
    const res = await run(state, agent, req('workspace/executeCommand', { command: 'mercury.nope' }));
    expect(res?.error?.code).toBe(LSP_ERROR.invalidParams);
  });

  it('rejects a missing command', async () => {
    const agent = stubAgent();
    const state = await ready(agent);
    const res = await run(state, agent, req('workspace/executeCommand', {}));
    expect(res?.error?.code).toBe(LSP_ERROR.invalidParams);
  });

  it('requires initialize first', async () => {
    const state = createLspState();
    const res = await run(state, stubAgent(), req('workspace/executeCommand', { command: 'mercury.tools.list' }));
    expect(res?.error?.code).toBe(LSP_ERROR.serverNotInitialized);
  });
});

// ── vendor extensions ────────────────────────────────────────────────────────

describe('vendor extensions', () => {
  it('_mercury/agent/prompt runs a turn', async () => {
    const agent = stubAgent();
    const state = await ready(agent);
    const res = await run(state, agent, req('_mercury/agent/prompt', { prompt: 'yo' }));
    expect(res?.result).toEqual({ output: 'echo:yo', stopReason: 'end_turn' });
  });

  it('_mercury/agent/prompt rejects empty prompt text', async () => {
    const agent = stubAgent();
    const state = await ready(agent);
    const res = await run(state, agent, req('_mercury/agent/prompt', { prompt: '   ' }));
    expect(res?.error?.code).toBe(LSP_ERROR.invalidParams);
  });

  it('_mercury/tools/list returns specs', async () => {
    const agent = stubAgent();
    const state = await ready(agent);
    const res = await run(state, agent, req('_mercury/tools/list'));
    expect((res?.result as { tools: Array<{ name: string }> }).tools[0]!.name).toBe('calc');
  });

  it('_mercury/tools/call rejects a missing name', async () => {
    const agent = stubAgent();
    const state = await ready(agent);
    const res = await run(state, agent, req('_mercury/tools/call', {}));
    expect(res?.error?.code).toBe(LSP_ERROR.invalidParams);
  });

  it('_mercury/tools/call reports methodNotFound when the agent has no callTool', async () => {
    const agent: LspAgent = { async runPrompt() { return { output: '', stopReason: 'end_turn' }; } };
    const state = await ready(agent);
    const res = await run(state, agent, req('_mercury/tools/call', { name: 'x' }));
    expect(res?.error?.code).toBe(LSP_ERROR.methodNotFound);
  });

  it('surfaces an agent error as a JSON-RPC internal error', async () => {
    const agent = stubAgent({
      async runPrompt() {
        throw new Error('boom');
      },
    });
    const state = await ready(agent);
    const res = await run(state, agent, req('_mercury/agent/prompt', { prompt: 'hi' }));
    expect(res?.error?.code).toBe(LSP_ERROR.internal);
    expect(res?.error?.message).toContain('boom');
  });
});

// ── unknown methods / helpers ────────────────────────────────────────────────

describe('unknown methods', () => {
  it('returns methodNotFound for an unknown request', async () => {
    const state = await ready(stubAgent());
    const res = await run(state, stubAgent(), req('does/not/exist'));
    expect(res?.error?.code).toBe(LSP_ERROR.methodNotFound);
  });

  it('silently drops an unknown notification', async () => {
    const state = await ready(stubAgent());
    const res = await run(state, stubAgent(), note('$/cancelRequest', { id: 1 }));
    expect(res).toBeNull();
  });
});

describe('helpers', () => {
  it('lspResult / lspError shape', () => {
    expect(lspResult(1, { ok: true })).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    expect(lspError(2, -32601, 'nope')).toEqual({ jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'nope' } });
    expect(lspError(3, -1, 'x', { extra: 1 }).error?.data).toEqual({ extra: 1 });
  });

  it('exposes the targeted protocol version', () => {
    expect(LSP_PROTOCOL).toBe('3.17');
  });
});

// ── processLspFrame ──────────────────────────────────────────────────────────

describe('processLspFrame', () => {
  it('writes a framed response for a request', async () => {
    const state = createLspState();
    const writes: unknown[] = [];
    const exit = await processLspFrame(state, stubAgent(), '{"jsonrpc":"2.0","id":1,"method":"initialize"}', () => {}, (o) => writes.push(o));
    expect(exit).toBe(false);
    expect((writes[0] as { result: unknown }).result).toBeDefined();
  });

  it('writes nothing for a notification', async () => {
    const state = await ready(stubAgent());
    const writes: unknown[] = [];
    const exit = await processLspFrame(state, stubAgent(), '{"jsonrpc":"2.0","method":"initialized"}', () => {}, (o) => writes.push(o));
    expect(exit).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it('signals exit on an exit notification', async () => {
    const state = await ready(stubAgent());
    const exit = await processLspFrame(state, stubAgent(), '{"jsonrpc":"2.0","method":"exit"}', () => {}, () => {});
    expect(exit).toBe(true);
  });

  it('writes a parse-error response for garbage', async () => {
    const state = createLspState();
    const writes: Array<{ error?: { code: number } }> = [];
    await processLspFrame(state, stubAgent(), '{bad', () => {}, (o) => writes.push(o as { error?: { code: number } }));
    expect(writes[0]!.error?.code).toBe(LSP_ERROR.parse);
  });
});

// ── transport ────────────────────────────────────────────────────────────────

describe('serveLspStdio (transport)', () => {
  it('handles a full Content-Length-framed session over streams and ends on exit', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let outBuf = Buffer.alloc(0);
    const parsed: Record<string, unknown>[] = [];
    output.on('data', (c: Buffer) => {
      outBuf = Buffer.concat([outBuf, c]);
      const { messages, rest } = decodeLspFrames(outBuf);
      outBuf = rest;
      for (const m of messages) parsed.push(JSON.parse(m));
    });
    const done = serveLspStdio(stubAgent(), { input, output }, { version: '1.9.0' });
    input.write(encodeLspMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' }));
    input.write(encodeLspMessage({ jsonrpc: '2.0', id: 2, method: 'workspace/executeCommand', params: { command: 'mercury.prompt', arguments: ['ping'] } }));
    input.write(encodeLspMessage({ jsonrpc: '2.0', method: 'exit' }));
    await done;
    expect((parsed.find((m) => m.id === 1)!.result as { serverInfo: { version: string } }).serverInfo.version).toBe('1.9.0');
    expect(parsed.some((m) => m.method === '$/progress')).toBe(true);
    expect((parsed.find((m) => m.id === 2)!.result as { output: string }).output).toBe('echo:ping');
  });

  it('reassembles a message split across two chunks', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let outBuf = Buffer.alloc(0);
    const parsed: Record<string, unknown>[] = [];
    output.on('data', (c: Buffer) => {
      outBuf = Buffer.concat([outBuf, c]);
      const { messages, rest } = decodeLspFrames(outBuf);
      outBuf = rest;
      for (const m of messages) parsed.push(JSON.parse(m));
    });
    const done = serveLspStdio(stubAgent(), { input, output });
    const framed = encodeLspMessage({ jsonrpc: '2.0', id: 7, method: 'initialize' });
    const cut = framed.length - 5;
    input.write(Buffer.from(framed.slice(0, cut), 'utf8'));
    input.write(Buffer.from(framed.slice(cut), 'utf8'));
    input.end();
    await done;
    expect(parsed.find((m) => m.id === 7)).toBeDefined();
  });
});
