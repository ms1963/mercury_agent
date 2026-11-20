/**
 * Regression tests for the execute_code sandbox RPC bridge.
 *
 * Guards against a crash where a sandboxed child process makes a tool call and then
 * exits (or is killed on timeout) before the parent writes the reply back over the
 * fd-3 pipe. The write then fails with EPIPE; because the readline Interface over the
 * socket re-emits that error on itself, an unhandled 'error' event used to take down
 * the whole server process. The sandbox must instead treat a closed pipe as a no-op.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { directToolContext } from '@mercury/runtime';
import { makeMercury } from './helpers.js';

let ctx: Awaited<ReturnType<typeof makeMercury>>;
let principal: Awaited<ReturnType<Awaited<ReturnType<typeof makeMercury>>['m']['localPrincipal']>>;

beforeAll(async () => {
  ctx = await makeMercury({}, { startServices: true });
  principal = await ctx.m.localPrincipal();
});
afterAll(() => ctx.close());

function runCode(code: string, language: 'python' | 'javascript' = 'python') {
  return ctx.m.executor.execute(
    { id: 't', name: 'execute_code', arguments: { code, language } },
    directToolContext(ctx.m, principal, 'cli'),
    { untrustedSeen: false, userRequest: 'test' },
  );
}

describe('execute_code sandbox', () => {
  it('does not crash when the child exits before the tool-call reply is written', async () => {
    // Write a raw tool-call request to fd 3, then exit immediately without reading the
    // reply. The parent executes the tool asynchronously and writes the result back to a
    // pipe whose reader is already gone — the EPIPE must be swallowed, not fatal.
    const code = [
      'import os, json',
      'os.write(3, (json.dumps({"id": 1, "tool": "calculator", "args": {"expression": "1+1"}}) + "\\n").encode())',
      'os._exit(0)',
    ].join('\n');
    const res = await runCode(code);
    // The call completes and returns normally; the process is still alive afterwards.
    expect(res).toBeTruthy();
    expect(typeof res.result.content).toBe('string');
  });

  it('still executes tool calls and returns their results in the normal flow', async () => {
    const code = ['r = call_tool("calculator", expression="6*7")', 'print("answer=" + str(r))'].join('\n');
    const res = await runCode(code);
    expect(res.result.content).toContain('answer=');
    expect(res.result.content).toContain('42');
  });
});
