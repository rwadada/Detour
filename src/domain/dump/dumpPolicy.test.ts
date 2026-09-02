import { describe, expect, it } from 'vitest';
import type { CapturedExchange } from '../exchange/types';
import { formatExchangeDump, isDumpLevel, redactHeaders } from './dumpPolicy';

function baseExchange(overrides: Partial<CapturedExchange> = {}): CapturedExchange {
  return {
    id: 'ex-1',
    method: 'GET',
    url: 'https://api.example.com/users?x=1',
    host: 'api.example.com',
    isSSL: true,
    requestHeaders: { host: 'api.example.com' },
    requestBodySize: 0,
    startedAt: 0,
    responseBodySize: 0,
    ...overrides,
  };
}

describe('isDumpLevel', () => {
  it('accepts the three recognized levels', () => {
    expect(isDumpLevel('summary')).toBe(true);
    expect(isDumpLevel('full')).toBe(true);
    expect(isDumpLevel('file')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isDumpLevel('verbose')).toBe(false);
    expect(isDumpLevel('')).toBe(false);
  });
});

describe('redactHeaders', () => {
  it('redacts a known sensitive header case-insensitively', () => {
    expect(redactHeaders({ Authorization: 'Bearer secret' })).toEqual({ Authorization: '[REDACTED]' });
    expect(redactHeaders({ 'set-cookie': ['a=1', 'b=2'] })).toEqual({ 'set-cookie': '[REDACTED]' });
  });

  it('leaves non-sensitive headers untouched', () => {
    expect(redactHeaders({ 'content-type': 'application/json' })).toEqual({ 'content-type': 'application/json' });
  });

  it('does not mutate the input', () => {
    const headers = { authorization: 'secret' };
    redactHeaders(headers);
    expect(headers.authorization).toBe('secret');
  });
});

describe('formatExchangeDump', () => {
  it('includes the request line and redacts sensitive headers', () => {
    const dump = formatExchangeDump(
      baseExchange({ requestHeaders: { host: 'api.example.com', authorization: 'Bearer secret' } }),
    );
    expect(dump).toContain('GET https://api.example.com/users?x=1');
    expect(dump).toContain('authorization: [REDACTED]');
    expect(dump).not.toContain('secret');
  });

  it('pretty-prints a JSON body', () => {
    const body = Buffer.from(JSON.stringify({ id: 1 })).toString('base64');
    const dump = formatExchangeDump(baseExchange({ requestBody: body }));
    expect(dump).toContain('"id": 1');
  });

  it('falls back to raw text for a non-JSON body', () => {
    const body = Buffer.from('not json').toString('base64');
    const dump = formatExchangeDump(baseExchange({ requestBody: body }));
    expect(dump).toContain('not json');
  });

  it('marks an empty body and does not include the response section before it arrives', () => {
    const dump = formatExchangeDump(baseExchange());
    expect(dump).toContain('(empty)');
    expect(dump).not.toContain('Response headers:');
  });

  it('notes truncation and includes the response once present', () => {
    const dump = formatExchangeDump(
      baseExchange({
        requestBody: Buffer.from('x').toString('base64'),
        requestBodyTruncated: true,
        statusCode: 200,
        statusMessage: 'OK',
        durationMs: 12,
        responseHeaders: { 'content-type': 'text/plain' },
        responseBody: Buffer.from('ok').toString('base64'),
      }),
    );
    expect(dump).toContain('(truncated)');
    expect(dump).toContain('200 OK (12ms)');
    expect(dump).toContain('content-type: text/plain');
  });

  it('includes an error line when present', () => {
    const dump = formatExchangeDump(baseExchange({ error: 'ECONNRESET' }));
    expect(dump).toContain('Error: ECONNRESET');
  });

  it('shows "(none)" when there are no request headers', () => {
    const dump = formatExchangeDump(baseExchange({ requestHeaders: {} }));
    expect(dump).toContain('(none)');
  });

  it('joins a non-sensitive multi-value header (e.g. "vary") with commas', () => {
    const dump = formatExchangeDump(baseExchange({ requestHeaders: { vary: ['accept', 'origin'] } }));
    expect(dump).toContain('vary: accept, origin');
  });

  it('omits the status message and duration when neither is present, and defaults missing response headers to "(none)"', () => {
    const dump = formatExchangeDump(baseExchange({ statusCode: 204 }));
    expect(dump).toContain('204\n');
    expect(dump).not.toContain('undefined');
    expect(dump).toContain('Response headers:\n  (none)');
  });
});
