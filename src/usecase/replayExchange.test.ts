import { describe, expect, it } from 'vitest';
import type { CapturedExchange } from '../domain/exchange/types';
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

function original(overrides: Partial<CapturedExchange> = {}): CapturedExchange {
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
    expect(requestPhase?.requestBody).toBe(Buffer.from('{"name":"x"}').toString('base64'));
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
    expect(Buffer.from(responsePhase?.responseBody ?? '', 'base64').toString()).toBe('{"id":"w1"}');
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
});
