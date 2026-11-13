/** HTTP transport: the real fetch-based implementation used by every adapter. */
import type { HttpRequestInit, HttpResponse, HttpTransport } from './types.js';

function wrap(status: number, headers: Record<string, string>, body: Buffer): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    text: async () => body.toString('utf8'),
    json: async <T>() => JSON.parse(body.toString('utf8') || 'null') as T,
    buffer: async () => body,
  };
}

export class FetchTransport implements HttpTransport {
  async request(url: string, init: HttpRequestInit = {}): Promise<HttpResponse> {
    const timeout = AbortSignal.timeout(init.timeoutMs ?? 60_000);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    const res = await fetch(url, { method: init.method ?? 'GET', headers: init.headers, body: init.body as BodyInit | undefined, signal });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    return wrap(res.status, headers, Buffer.from(await res.arrayBuffer()));
  }
}
