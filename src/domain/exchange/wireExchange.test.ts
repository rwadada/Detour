import { describe, expect, it, vi } from 'vitest';
import type { CapturedExchange, WireExchange } from './types';
import { fromWireExchange, toResponsePatch, toWireExchange } from './wireExchange';

const BASE = {
  id: 'ex-1',
  method: 'GET',
  url: 'https://api.example.com/widgets',
  host: 'api.example.com',
  isSSL: true,
  protocol: 'HTTP/1.1' as const,
  requestHeaders: {},
  requestBodySize: 0,
  responseBodySize: 0,
  startedAt: 0,
};

/** A minimal `CapturedExchange`, overridable per test — body fields deliberately omitted here since that's exactly what each test below varies. */
function exchange(overrides: Partial<CapturedExchange> = {}): CapturedExchange {
  return { ...BASE, ...overrides };
}

/** A minimal `WireExchange` counterpart of `exchange()`, for `fromWireExchange` tests — same fields, but body overrides are already-base64 strings rather than Buffers. */
function wireExchange(overrides: Partial<WireExchange> = {}): WireExchange {
  return { ...BASE, ...overrides };
}

describe('toWireExchange', () => {
  it('base64-encodes requestBody and responseBody', () => {
    const wire = toWireExchange(
      exchange({ requestBody: Buffer.from('{"name":"x"}'), responseBody: Buffer.from('{"id":"w1"}') }),
    );
    expect(wire.requestBody).toBe(Buffer.from('{"name":"x"}').toString('base64'));
    expect(wire.responseBody).toBe(Buffer.from('{"id":"w1"}').toString('base64'));
  });

  it('leaves an absent body as undefined rather than encoding it as an empty string', () => {
    const wire = toWireExchange(exchange());
    expect(wire.requestBody).toBeUndefined();
    expect(wire.responseBody).toBeUndefined();
  });

  it('distinguishes an absent body from a present-but-empty one', () => {
    const wire = toWireExchange(exchange({ requestBody: Buffer.alloc(0) }));
    expect(wire.requestBody).toBe('');
    expect(wire.responseBody).toBeUndefined();
  });

  it('passes every other field through unchanged', () => {
    const source = exchange({ statusCode: 200, durationMs: 12 });
    const wire = toWireExchange(source);
    expect(wire).toMatchObject({
      id: source.id,
      method: source.method,
      url: source.url,
      statusCode: 200,
      durationMs: 12,
    });
  });
});

describe('fromWireExchange', () => {
  it('decodes requestBody and responseBody back into real Buffers', () => {
    const wire = wireExchange({
      requestBody: Buffer.from('{"name":"x"}').toString('base64'),
      responseBody: Buffer.from('{"id":"w1"}').toString('base64'),
    });
    const decoded = fromWireExchange(wire);
    expect(Buffer.isBuffer(decoded.requestBody)).toBe(true);
    expect(Buffer.isBuffer(decoded.responseBody)).toBe(true);
    expect(decoded.requestBody?.toString('utf8')).toBe('{"name":"x"}');
    expect(decoded.responseBody?.toString('utf8')).toBe('{"id":"w1"}');
  });

  it('leaves an absent body as undefined rather than decoding it into a zero-length Buffer', () => {
    const decoded = fromWireExchange(wireExchange());
    expect(decoded.requestBody).toBeUndefined();
    expect(decoded.responseBody).toBeUndefined();
  });

  it('distinguishes an absent body from a present-but-empty one', () => {
    const decoded = fromWireExchange(wireExchange({ requestBody: '' }));
    expect(decoded.requestBody).toEqual(Buffer.alloc(0));
    expect(decoded.responseBody).toBeUndefined();
  });

  it('round-trips through toWireExchange for an arbitrary byte sequence, including bytes base64 handles awkwardly at chunk boundaries', () => {
    const original = exchange({
      requestBody: Buffer.from(Array.from({ length: 257 }, (_, i) => i % 256)),
    });
    const roundTripped = fromWireExchange(toWireExchange(original));
    expect(roundTripped.requestBody).toEqual(original.requestBody);
  });
});

describe('toResponsePatch', () => {
  it('omits requestBody and requestHeaders, keeping every other field (including a base64-encoded responseBody)', () => {
    const source = exchange({
      requestBody: Buffer.from('{"q":1}'),
      requestHeaders: { accept: 'application/json' },
      responseBody: Buffer.from('{"ok":true}'),
      statusCode: 200,
    });
    const patch = toResponsePatch(source);
    expect(patch).not.toHaveProperty('requestBody');
    expect(patch).not.toHaveProperty('requestHeaders');
    expect(patch.responseBody).toBe(Buffer.from('{"ok":true}').toString('base64'));
    expect(patch.statusCode).toBe(200);
  });

  it('leaves an absent responseBody as undefined rather than encoding it as an empty string', () => {
    const patch = toResponsePatch(exchange());
    expect(patch.responseBody).toBeUndefined();
  });

  it('never base64-encodes requestBody at all, not even to immediately discard it (agy code review — building this on toWireExchange would have encoded it first for nothing, exactly the cost this proposal exists to avoid)', () => {
    const requestBody = Buffer.from('{"q":1}');
    const toStringSpy = vi.spyOn(requestBody, 'toString');
    toResponsePatch(exchange({ requestBody, responseBody: Buffer.from('ok') }));
    expect(toStringSpy).not.toHaveBeenCalled();
  });
});
