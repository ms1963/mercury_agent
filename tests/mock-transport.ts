/**
 * Test-only scriptable HTTP transport. Records every request and answers from
 * registered routes (first route whose matcher returns a response wins; default
 * 200 `{ok:true}`). Not shipped in the gateway package — adapters always use the
 * real FetchTransport in production.
 */
import type { HttpRequestInit, HttpResponse, HttpTransport } from '@mercury/gateway';

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

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

type Route = (req: RecordedRequest) => { status?: number; body?: unknown; headers?: Record<string, string> } | undefined;

export class MockTransport implements HttpTransport {
  readonly requests: RecordedRequest[] = [];
  private routes: Array<{ match: string | RegExp; handler: Route }> = [];

  on(match: string | RegExp, handler: Route | { status?: number; body?: unknown }): this {
    this.routes.push({ match, handler: typeof handler === 'function' ? handler : () => handler });
    return this;
  }

  async request(url: string, init: HttpRequestInit = {}): Promise<HttpResponse> {
    const body = init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : init.body instanceof Buffer ? init.body.toString() : String(init.body);
    const req: RecordedRequest = { url, method: init.method ?? 'GET', headers: init.headers ?? {}, body };
    this.requests.push(req);
    for (const r of this.routes) {
      const hit = typeof r.match === 'string' ? url.includes(r.match) : r.match.test(url);
      if (!hit) continue;
      const res = r.handler(req);
      if (res) {
        const payload = typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? { ok: true });
        return wrap(res.status ?? 200, res.headers ?? { 'content-type': 'application/json' }, Buffer.from(payload));
      }
    }
    return wrap(200, { 'content-type': 'application/json' }, Buffer.from('{"ok":true}'));
  }

  last(match?: string): RecordedRequest | undefined {
    return [...this.requests].reverse().find((r) => !match || r.url.includes(match));
  }
}
