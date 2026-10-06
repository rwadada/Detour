import { describe, expect, it } from 'vitest';
import type { CapturedExchange, WireExchange } from '../domain/exchange/types';
import { DetourEventBus } from '../infra/eventBus';
import type { HttpRequester } from './ports/httpRequester';
import { replayExchange } from './replayExchange';

function fakeRequester(result: Awaited<ReturnType<HttpRequester['request']>>): HttpRequester {
  return { request: async () => result };
}

function failingRequester(error: Error): HttpRequester {
  return {
    request: async () => {
      throw error;
    },
  };
}

/** The dashboard client's replay request always carries a `WireExchange` — base64 body, same as everything else it sends (issue #165's Proposal B). */
function original(overrides: Partial<WireExchange> = {}): WireExchange {
  return {
    id: 'original-1',
    method: 'POST',
    url: 'https://api.example.com/widgets',
    host: 'api.example.com',
    isSSL: true,
    protocol: 'HTTP/1.1',
    requestHeaders: { 'content-type': 'application/json', host: 'api.example.com', 'content-length': '13' },
    requestBodySize: 13,
    requestBody: Buffer.from('{"name":"x"}').toString('base64'),
    startedAt: 0,
    responseBodySize: 0,
    ...overrides,
  };
}

describe('replayExchange', () => {
  it('emits request then response, with a fresh id distinct from the original', async () => {
    const eventBus = new DetourEventBus();
    const emitted: Array<{ type: string; exchange: CapturedExchange }> = [];
    eventBus.on('request', (exchange) => emitted.push({ type: 'request', exchange }));
    eventBus.on('response', (exchange) => emitted.push({ type: 'response', exchange }));

    const requester = fakeRequester({
      statusCode: 201,
      statusMessage: 'Created',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{"id":"w1"}'),
    });

    await replayExchange(original(), eventBus, requester);

    expect(emitted.map((e) => e.type)).toEqual(['request', 'response']);
    expect(emitted[0]?.exchange.id).not.toBe('original-1');
    expect(emitted[0]?.exchange.id).toBe(emitted[1]?.exchange.id);
  });

  it('carries over method/url/host/body from the original', async () => {
    const eventBus = new DetourEventBus();
    let requestPhase: CapturedExchange | undefined;
    eventBus.on('request', (exchange) => {
      requestPhase = exchange;
    });
    const requester = fakeRequester({ statusCode: 200, headers: {}, body: Buffer.alloc(0) });

    await replayExchange(original(), eventBus, requester);

    expect(requestPhase?.method).toBe('POST');
    expect(requestPhase?.url).toBe('https://api.example.com/widgets');
    expect(requestPhase?.host).toBe('api.example.com');
    expect(requestPhase?.requestBody?.toString('utf8')).toBe('{"name":"x"}');
  });

  it('strips hop-by-hop headers before sending, but keeps them out of the captured request only', async () => {
    const eventBus = new DetourEventBus();
    let sentHeaders: unknown;
    const requester: HttpRequester = {
      request: async (opts) => {
        sentHeaders = opts.headers;
        return { statusCode: 200, headers: {}, body: Buffer.alloc(0) };
      },
    };

    await replayExchange(original(), eventBus, requester);

    expect(sentHeaders).toEqual({ 'content-type': 'application/json' });
  });

  it('populates response fields from a successful request', async () => {
    const eventBus = new DetourEventBus();
    let responsePhase: CapturedExchange | undefined;
    eventBus.on('response', (exchange) => {
      responsePhase = exchange;
    });
    const requester = fakeRequester({
      statusCode: 201,
      statusMessage: 'Created',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{"id":"w1"}'),
    });

    await replayExchange(original(), eventBus, requester);

    expect(responsePhase?.statusCode).toBe(201);
    expect(responsePhase?.statusMessage).toBe('Created');
    expect(responsePhase?.responseHeaders).toEqual({ 'content-type': 'application/json' });
    expect(responsePhase?.responseBodySize).toBe(11);
    expect(responsePhase?.responseBody?.toString()).toBe('{"id":"w1"}');
    expect(responsePhase?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('sets `error` instead of throwing when the outbound request fails', async () => {
    const eventBus = new DetourEventBus();
    let responsePhase: CapturedExchange | undefined;
    eventBus.on('response', (exchange) => {
      responsePhase = exchange;
    });

    await replayExchange(original(), eventBus, failingRequester(new Error('ECONNREFUSED')));

    expect(responsePhase?.error).toBe('ECONNREFUSED');
    expect(responsePhase?.statusCode).toBeUndefined();
  });

  describe('Edit & Send overrides (issue #214)', () => {
    async function send(overrides: Parameters<typeof replayExchange>[3], base: WireExchange = original()) {
      const eventBus = new DetourEventBus();
      let sent: Parameters<HttpRequester['request']>[0] | undefined;
      let broadcast: CapturedExchange | undefined;
      eventBus.on('request', (exchange) => {
        broadcast = exchange;
      });
      const requester: HttpRequester = {
        request: async (req) => {
          sent = req;
          return { statusCode: 200, statusMessage: 'OK', headers: {}, body: Buffer.alloc(0) };
        },
      };
      await replayExchange(base, eventBus, requester, overrides);
      return { sent: sent!, broadcast: broadcast! };
    }

    it('records which exchange it was sent from, with or without edits', async () => {
      expect((await send(undefined)).broadcast.replayOf).toBe('original-1');
      expect((await send({ method: 'PUT' })).broadcast.replayOf).toBe('original-1');
    });

    it('changes only what is overridden', async () => {
      const { sent, broadcast } = await send({ method: 'put' });
      expect(sent.method).toBe('put');
      expect(sent.url).toBe('https://api.example.com/widgets');
      expect(broadcast.host).toBe('api.example.com');
      expect(sent.body?.toString()).toBe('{"name":"x"}');
    });

    it('replaces the header set wholesale (still dropping hop-by-hop ones)', async () => {
      const { sent } = await send({ headers: { 'x-only': '1', host: 'evil', 'content-length': '999' } });
      expect(sent.headers).toEqual({ 'x-only': '1' });
    });

    it('re-derives host and scheme from an edited URL', async () => {
      const { sent, broadcast } = await send({ url: 'http://localhost:3000/v2/widgets' });
      expect(sent.url).toBe('http://localhost:3000/v2/widgets');
      expect(broadcast.host).toBe('localhost:3000');
      expect(broadcast.isSSL).toBe(false);
    });

    it('sends an edited body and records its real size', async () => {
      const body = Buffer.from('{"name":"changed!"}');
      const { sent, broadcast } = await send({ body: body.toString('base64') });
      expect(sent.body?.toString()).toBe('{"name":"changed!"}');
      expect(broadcast.requestBodySize).toBe(body.length);
      expect(broadcast.requestBodyTruncated).toBe(false);
    });

    it('an empty edited body removes the body', async () => {
      const { sent, broadcast } = await send({ body: '' });
      expect(sent.body).toBeUndefined();
      expect(broadcast.requestBodySize).toBe(0);
    });
  });
});
