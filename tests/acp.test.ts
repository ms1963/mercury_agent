/**
 * Offline, deterministic tests for the ACP server (Tier-3 gap #9).
 *
 * SCOPE: fully offline. Every method handler, the JSON-RPC parser/framing and the error paths are
 * exercised against an injected {@link AcpAgent} stub and an injected `emit` sink for notifications. No
 * real network, no real external ACP client, no stdio. The stdio transport framing is tested with
 * in-memory PassThrough streams.
 */
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  ACP_ERROR,
  ACP_PROTOCOL_VERSION,
  acpError,
  acpResult,
  createAcpState,
  handleAcpMessage,
  isAcpResponse,
  parseAcpMessage,
  processLine,
  promptText,
  serveAcpStdio,
  type AcpAgent,
  type AcpRequest,
  type AcpSessionUpdate,
} from '@mercury/core';

/** A deterministic agent stub. Records prompts and can stream updates / throw. */
function stubAgent(over: Partial<AcpAgent> = {}): AcpAgent {
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

const req = (method: string, params?: Record<string, unknown>, id: string | number = 1): AcpRequest => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

async function run(state: ReturnType<typeof createAcpState>, agent: AcpAgent, r: AcpRequest, emit = () => {}) {
  return handleAcpMessage(state, agent, r, emit);
}

describe('parseAcpMessage', () => {
  it('parses a valid request', () => {
    const p = parseAcpMessage('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}');
    expect(isAcpResponse(p)).toBe(false);
    expect((p as AcpRequest).method).toBe('initialize');
  });

  it('parses a notification (no id)', () => {
    const p = parseAcpMessage('{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"s1"}}') as AcpRequest;
    expect(p.id).toBeUndefined();
    expect(p.method).toBe('session/cancel');
  });

  it('rejects invalid JSON with a parse error', () => {
    const p = parseAcpMessage('{not json');
    expect(isAcpResponse(p)).toBe(true);
    expect((p as ReturnType<typeof acpError>).error?.code).toBe(ACP_ERROR.parse);
  });

  it('rejects wrong jsonrpc version', () => {
    const p = parseAcpMessage('{"jsonrpc":"1.0","id":2,"method":"x"}') as ReturnType<typeof acpError>;
    expect(p.error?.code).toBe(ACP_ERROR.invalidRequest);
    expect(p.id).toBe(2);
  });

  it('rejects a missing method', () => {
    const p = parseAcpMessage('{"jsonrpc":"2.0","id":3}') as ReturnType<typeof acpError>;
    expect(p.error?.code).toBe(ACP_ERROR.invalidRequest);
  });

  it('rejects non-object params', () => {
    const p = parseAcpMessage('{"jsonrpc":"2.0","id":4,"method":"x","params":[]}') as ReturnType<typeof acpError>;
    expect(p.error?.code).toBe(ACP_ERROR.invalidParams);
  });

  it('rejects a non-object top-level message', () => {
    const p = parseAcpMessage('42') as ReturnType<typeof acpError>;
    expect(p.error?.code).toBe(ACP_ERROR.invalidRequest);
  });
});

describe('promptText', () => {
  it('concatenates text content blocks', () => {
    expect(promptText([{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }])).toBe('hello world');
  });
  it('ignores non-text blocks and non-arrays', () => {
    expect(promptText([{ type: 'image', data: 'x' }, { type: 'text', text: 'hi' }])).toBe('hi');
    expect(promptText('nope')).toBe('');
  });
});

describe('initialize', () => {
  it('negotiates the protocol version and advertises capabilities', async () => {
    const state = createAcpState();
    const res = await run(state, stubAgent(), req('initialize', { protocolVersion: 1 }));
    expect(res?.result).toMatchObject({ protocolVersion: ACP_PROTOCOL_VERSION, authMethods: [] });
    expect((res?.result as { agentCapabilities: { loadSession: boolean } }).agentCapabilities.loadSession).toBe(false);
    expect(state.initialized).toBe(true);
  });

  it('clamps a higher requested version down to the supported one', async () => {
    const state = createAcpState();
    const res = await run(state, stubAgent(), req('initialize', { protocolVersion: 99 }));
    expect((res?.result as { protocolVersion: number }).protocolVersion).toBe(ACP_PROTOCOL_VERSION);
  });
});

describe('session lifecycle', () => {
  it('requires initialize before session/new', async () => {
    const state = createAcpState();
    const res = await run(state, stubAgent(), req('session/new'));
    expect(res?.error?.code).toBe(ACP_ERROR.invalidRequest);
  });

  it('opens a session with a deterministic id', async () => {
    const state = createAcpState();
    await run(state, stubAgent(), req('initialize'));
    const res = await run(state, stubAgent(), req('session/new', { cwd: '/tmp/x' }));
    expect(res?.result).toEqual({ sessionId: 'sess_1' });
    expect(state.sessions.get('sess_1')?.cwd).toBe('/tmp/x');
  });

  it('lists open sessions', async () => {
    const state = createAcpState();
    await run(state, stubAgent(), req('initialize'));
    await run(state, stubAgent(), req('session/new'));
    await run(state, stubAgent(), req('session/new'));
    const res = await run(state, stubAgent(), req('session/list'));
    expect((res?.result as { sessions: unknown[] }).sessions).toHaveLength(2);
  });
});

describe('session/prompt', () => {
  async function initSession(agent: AcpAgent) {
    const state = createAcpState();
    await run(state, agent, req('initialize'));
    await run(state, agent, req('session/new'));
    return state;
  }

  it('runs a turn, streams an agent_message_chunk and answers end_turn', async () => {
    const agent = stubAgent();
    const state = await initSession(agent);
    const rec = recorder();
    const res = await handleAcpMessage(state, agent, req('session/prompt', { sessionId: 'sess_1', prompt: [{ type: 'text', text: 'hi' }] }), rec.emit);
    expect(res?.result).toEqual({ stopReason: 'end_turn' });
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]!.method).toBe('session/update');
    const update = rec.events[0]!.params.update as AcpSessionUpdate;
    expect(update).toMatchObject({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'echo:hi' } });
  });

  it('forwards streamed tool-call updates from the agent', async () => {
    const agent = stubAgent({
      async runPrompt(_input, opts) {
        opts.onUpdate?.({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'calc', status: 'in_progress' });
        opts.onUpdate?.({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
        return { output: 'done', stopReason: 'end_turn' };
      },
    });
    const state = await initSession(agent);
    const rec = recorder();
    await handleAcpMessage(state, agent, req('session/prompt', { sessionId: 'sess_1', prompt: [{ type: 'text', text: 'go' }] }), rec.emit);
    const kinds = rec.events.map((e) => (e.params.update as AcpSessionUpdate).sessionUpdate);
    expect(kinds).toEqual(['tool_call', 'tool_call_update', 'agent_message_chunk']);
  });

  it('rejects a prompt for an unknown session', async () => {
    const agent = stubAgent();
    const state = await initSession(agent);
    const res = await run(state, agent, req('session/prompt', { sessionId: 'nope', prompt: [{ type: 'text', text: 'hi' }] }));
    expect(res?.error?.code).toBe(ACP_ERROR.invalidParams);
  });

  it('rejects a prompt with no text content', async () => {
    const agent = stubAgent();
    const state = await initSession(agent);
    const res = await run(state, agent, req('session/prompt', { sessionId: 'sess_1', prompt: [] }));
    expect(res?.error?.code).toBe(ACP_ERROR.invalidParams);
  });

  it('rejects a prompt missing sessionId', async () => {
    const agent = stubAgent();
    const state = await initSession(agent);
    const res = await run(state, agent, req('session/prompt', { prompt: [{ type: 'text', text: 'hi' }] }));
    expect(res?.error?.code).toBe(ACP_ERROR.invalidParams);
  });

  it('reports cancelled when the session was cancelled mid-turn', async () => {
    const agent = stubAgent({
      async runPrompt() {
        return { output: 'partial', stopReason: 'end_turn' };
      },
    });
    const state = await initSession(agent);
    // Simulate a cancel notification racing with the turn: mark cancelled, then let a custom agent set it.
    const cancelAgent = stubAgent({
      async runPrompt() {
        state.sessions.get('sess_1')!.cancelled = true;
        return { output: 'partial', stopReason: 'end_turn' };
      },
    });
    const res = await handleAcpMessage(state, cancelAgent, req('session/prompt', { sessionId: 'sess_1', prompt: [{ type: 'text', text: 'hi' }] }), () => {});
    expect(res?.result).toEqual({ stopReason: 'cancelled' });
    void agent;
  });

  it('surfaces an agent error as a JSON-RPC internal error', async () => {
    const agent = stubAgent({
      async runPrompt() {
        throw new Error('boom');
      },
    });
    const state = await initSession(agent);
    const res = await run(state, agent, req('session/prompt', { sessionId: 'sess_1', prompt: [{ type: 'text', text: 'hi' }] }));
    expect(res?.error?.code).toBe(ACP_ERROR.internal);
    expect(res?.error?.message).toContain('boom');
  });
});

describe('session/cancel', () => {
  it('marks the session cancelled and returns no response (notification)', async () => {
    const state = createAcpState();
    await run(state, stubAgent(), req('initialize'));
    await run(state, stubAgent(), req('session/new'));
    const res = await handleAcpMessage(state, stubAgent(), { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'sess_1' } }, () => {});
    expect(res).toBeNull();
    expect(state.sessions.get('sess_1')?.cancelled).toBe(true);
  });
});

describe('vendor tool extensions', () => {
  async function ready(agent: AcpAgent) {
    const state = createAcpState();
    await run(state, agent, req('initialize'));
    return state;
  }

  it('_mercury/tools/list returns the tool specs', async () => {
    const agent = stubAgent();
    const state = await ready(agent);
    const res = await run(state, agent, req('_mercury/tools/list'));
    expect((res?.result as { tools: Array<{ name: string }> }).tools[0]!.name).toBe('calc');
  });

  it('_mercury/tools/call invokes the tool', async () => {
    const agent = stubAgent();
    const state = await ready(agent);
    const res = await run(state, agent, req('_mercury/tools/call', { name: 'calc', arguments: { a: 1 } }));
    expect((res?.result as { content: Array<{ text: string }> }).content[0]!.text).toContain('ran calc');
  });

  it('_mercury/tools/call rejects a missing name', async () => {
    const agent = stubAgent();
    const state = await ready(agent);
    const res = await run(state, agent, req('_mercury/tools/call', {}));
    expect(res?.error?.code).toBe(ACP_ERROR.invalidParams);
  });

  it('_mercury/tools/call reports methodNotFound when the agent has no callTool', async () => {
    const agent: AcpAgent = { async runPrompt() { return { output: '', stopReason: 'end_turn' }; } };
    const state = await ready(agent);
    const res = await run(state, agent, req('_mercury/tools/call', { name: 'x' }));
    expect(res?.error?.code).toBe(ACP_ERROR.methodNotFound);
  });
});

describe('unsupported / unknown methods', () => {
  it('rejects auth methods (no auth advertised)', async () => {
    const state = createAcpState();
    await run(state, stubAgent(), req('initialize'));
    for (const method of ['authenticate', 'auth/login', 'auth/logout']) {
      const res = await run(state, stubAgent(), req(method));
      expect(res?.error?.code).toBe(ACP_ERROR.methodNotFound);
    }
  });

  it('rejects session/load (loadSession=false)', async () => {
    const state = createAcpState();
    await run(state, stubAgent(), req('initialize'));
    const res = await run(state, stubAgent(), req('session/load', { sessionId: 'x' }));
    expect(res?.error?.code).toBe(ACP_ERROR.methodNotFound);
  });

  it('returns methodNotFound for an unknown method', async () => {
    const state = createAcpState();
    await run(state, stubAgent(), req('initialize'));
    const res = await run(state, stubAgent(), req('does/not/exist'));
    expect(res?.error?.code).toBe(ACP_ERROR.methodNotFound);
  });
});

describe('helpers', () => {
  it('acpResult / acpError shape', () => {
    expect(acpResult(1, { ok: true })).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    expect(acpError(2, -32601, 'nope')).toEqual({ jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'nope' } });
    expect(acpError(3, -1, 'x', { extra: 1 }).error?.data).toEqual({ extra: 1 });
  });
});

describe('processLine (framing)', () => {
  it('writes a response for a request', async () => {
    const state = createAcpState();
    const writes: unknown[] = [];
    await processLine(state, stubAgent(), '{"jsonrpc":"2.0","id":1,"method":"initialize"}', () => {}, (o) => writes.push(o));
    expect((writes[0] as { result: unknown }).result).toBeDefined();
  });

  it('writes nothing for a notification', async () => {
    const state = createAcpState();
    const writes: unknown[] = [];
    await processLine(state, stubAgent(), '{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"x"}}', () => {}, (o) => writes.push(o));
    expect(writes).toHaveLength(0);
  });

  it('writes a parse-error response for garbage', async () => {
    const state = createAcpState();
    const writes: Array<{ error?: { code: number } }> = [];
    await processLine(state, stubAgent(), '{bad', () => {}, (o) => writes.push(o as { error?: { code: number } }));
    expect(writes[0]!.error?.code).toBe(ACP_ERROR.parse);
  });
});

describe('serveAcpStdio (transport)', () => {
  it('handles a full newline-delimited session over streams', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on('data', (c: Buffer) => {
      for (const l of c.toString('utf8').split('\n')) if (l.trim()) lines.push(l);
    });
    const done = serveAcpStdio(stubAgent(), { input, output });
    input.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
    input.write('{"jsonrpc":"2.0","id":2,"method":"session/new"}\n');
    input.write('{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"sess_1","prompt":[{"type":"text","text":"ping"}]}}\n');
    input.end();
    await done;
    const msgs = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    // initialize response, session/new response, session/update notification, session/prompt response
    expect(msgs.find((m) => m.id === 1)).toBeDefined();
    expect((msgs.find((m) => m.id === 2)!.result as { sessionId: string }).sessionId).toBe('sess_1');
    expect(msgs.some((m) => m.method === 'session/update')).toBe(true);
    expect(msgs.find((m) => m.id === 3)!.result).toEqual({ stopReason: 'end_turn' });
  });
});
