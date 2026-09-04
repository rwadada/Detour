import type { IncomingHttpHeaders } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { CapturedExchange, CapturedWebSocketConnection } from '../exchange/types';
import { formatExchangeDump, formatWebSocketDump, isDumpLevel, redactHeaders } from './dumpPolicy';

function baseExchange(overrides: Partial<CapturedExchange> = {}): CapturedExchange {
  return {
    id: 'ex-1',
    method: 'GET',
    url: 'https://api.example.com/users?x=1',
    host: 'api.example.com',
    isSSL: true,
    protocol: 'HTTP/1.1',
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
    const dump = formatExchangeDump(
      baseExchange({ requestHeaders: { vary: ['accept', 'origin'] } as unknown as IncomingHttpHeaders }),
    );
    expect(dump).toContain('vary: accept, origin');
  });

  it('omits the status message and duration when neither is present, and defaults missing response headers to "(none)"', () => {
    const dump = formatExchangeDump(baseExchange({ statusCode: 204 }));
    expect(dump).toContain('204\n');
    expect(dump).not.toContain('undefined');
    expect(dump).toContain('Response headers:\n  (none)');
  });
});

function baseWsConnection(overrides: Partial<CapturedWebSocketConnection> = {}): CapturedWebSocketConnection {
  return {
    id: 'ws-1',
    url: 'wss://api.example.com/socket',
    host: 'api.example.com',
    isSSL: true,
    requestHeaders: { host: 'api.example.com' },
    openedAt: 0,
    frames: [],
    frameCount: 0,
    framesTruncated: false,
    ...overrides,
  };
}

describe('formatWebSocketDump', () => {
  it('includes the connection line and redacts sensitive headers', () => {
    const dump = formatWebSocketDump(
      baseWsConnection({ requestHeaders: { host: 'api.example.com', cookie: 'session=secret' } }),
    );
    expect(dump).toContain('WS wss://api.example.com/socket');
    expect(dump).toContain('cookie: [REDACTED]');
    expect(dump).not.toContain('secret');
  });

  it('shows "(none)" when there are no frames', () => {
    const dump = formatWebSocketDump(baseWsConnection());
    expect(dump).toContain('Frames (0):');
    expect(dump).toContain('(none)');
  });

  it('renders a text message frame with its direction and pretty-printed JSON body', () => {
    const dump = formatWebSocketDump(
      baseWsConnection({
        frameCount: 1,
        frames: [
          {
            type: 'message',
            direction: 'toServer',
            binary: false,
            size: 13,
            at: 0,
            data: Buffer.from(JSON.stringify({ id: 1 })).toString('base64'),
          },
        ],
      }),
    );
    expect(dump).toContain('→ server text');
    expect(dump).toContain('"id": 1');
  });

  it('labels a binary message frame accordingly', () => {
    const dump = formatWebSocketDump(
      baseWsConnection({
        frameCount: 1,
        frames: [
          {
            type: 'message',
            direction: 'toServer',
            binary: true,
            size: 4,
            at: 0,
            data: Buffer.from('data').toString('base64'),
          },
        ],
      }),
    );
    expect(dump).toContain('→ server binary');
  });

  it('renders a ping/pong frame without a body section', () => {
    const dump = formatWebSocketDump(
      baseWsConnection({
        frameCount: 1,
        frames: [{ type: 'ping', direction: 'toClient', binary: false, size: 0, at: 0 }],
      }),
    );
    expect(dump).toContain('→ client ping (0B)');
  });

  it('notes truncation with the total frame count vs. what is shown', () => {
    const dump = formatWebSocketDump(baseWsConnection({ frameCount: 250, framesTruncated: true, frames: [] }));
    expect(dump).toContain('Frames (250 total, showing the last 0):');
  });

  it('includes the close line once closed, with code/reason/side/duration', () => {
    const dump = formatWebSocketDump(
      baseWsConnection({ closedAt: 100, durationMs: 100, closeCode: 1000, closeReason: 'bye', closedByServer: true }),
    );
    expect(dump).toContain('Closed: 1000 bye (closed by server) (100ms)');
  });

  it('labels a client-initiated close accordingly', () => {
    const dump = formatWebSocketDump(baseWsConnection({ closedAt: 100, closedByServer: false }));
    expect(dump).toContain('(closed by client)');
  });

  it('defaults code to "(none)" and omits reason/side/duration when none are known', () => {
    const dump = formatWebSocketDump(baseWsConnection({ closedAt: 100 }));
    expect(dump).toContain('Closed: (none)');
    expect(dump).not.toContain('closed by');
    expect(dump).not.toContain('undefined');
  });

  it('omits the close line while still open, and includes an error line when present', () => {
    const dump = formatWebSocketDump(baseWsConnection({ error: 'ECONNRESET' }));
    expect(dump).not.toContain('Closed:');
    expect(dump).toContain('Error: ECONNRESET');
  });
});
