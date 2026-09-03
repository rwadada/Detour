import { describe, expect, it } from 'vitest';
import type { CapturedExchange } from '@/shared/api';
import { buildCurlCommand } from './curl';

function exchange(overrides: Partial<CapturedExchange> = {}): CapturedExchange {
  return {
    id: 'x1',
    method: 'GET',
    url: 'https://example.com/',
    host: 'example.com',
    isSSL: true,
    protocol: 'HTTP/1.1',
    requestHeaders: {},
    requestBodySize: 0,
    responseBodySize: 0,
    startedAt: 0,
    ...overrides,
  };
}

describe('buildCurlCommand', () => {
  it('builds a basic GET with no headers/body', () => {
    expect(buildCurlCommand(exchange())).toBe("curl -X GET 'https://example.com/'");
  });

  it('includes every request header', () => {
    const cmd = buildCurlCommand(exchange({ requestHeaders: { accept: 'application/json', 'x-api-key': 'abc' } }));
    expect(cmd).toContain("-H 'accept: application/json'");
    expect(cmd).toContain("-H 'x-api-key: abc'");
  });

  it('emits one -H per value for a multi-value header', () => {
    const cmd = buildCurlCommand(exchange({ requestHeaders: { 'x-trace': ['a', 'b'] } }));
    expect(cmd).toContain("-H 'x-trace: a'");
    expect(cmd).toContain("-H 'x-trace: b'");
  });

  it('skips headers with an undefined value', () => {
    const cmd = buildCurlCommand(exchange({ requestHeaders: { accept: undefined } }));
    expect(cmd).not.toContain('-H');
  });

  it('decodes and includes a text body as --data-raw', () => {
    const cmd = buildCurlCommand(
      exchange({
        method: 'POST',
        requestBody: btoa('{"name":"x"}'),
        requestHeaders: { 'content-type': 'application/json' },
      }),
    );
    expect(cmd).toContain(`--data-raw '{"name":"x"}'`);
  });

  it('escapes embedded single quotes in the URL, a header, and the body', () => {
    const cmd = buildCurlCommand(
      exchange({
        url: "https://example.com/?q=O'Brien",
        requestHeaders: { 'x-note': "it's here" },
        requestBody: btoa("say 'hi'"),
      }),
    );
    expect(cmd).toContain(String.raw`'https://example.com/?q=O'\''Brien'`);
    expect(cmd).toContain(String.raw`-H 'x-note: it'\''s here'`);
    expect(cmd).toContain(String.raw`--data-raw 'say '\''hi'\'''`);
  });

  it('calls out a binary body instead of corrupting it', () => {
    const binary = Uint8Array.from([0x00, 0xff, 0xfe]);
    const cmd = buildCurlCommand(exchange({ requestBody: btoa(String.fromCharCode(...binary)) }));
    expect(cmd).toContain("--data-raw '<binary body omitted>'");
  });

  it('omits --data-raw entirely when there is no body', () => {
    expect(buildCurlCommand(exchange())).not.toContain('--data-raw');
  });
});
