import { describe, expect, it } from 'vitest';
import type { HarLog } from '@/entities/exchange';
import type { CapturedExchange } from '@/shared/api';
import { exportFileName, serializeExchangesAsJson, serializeHar } from './exportLog';

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

describe('serializeExchangesAsJson', () => {
  it('serializes as a plain exchange array, re-parseable as-is', () => {
    const output = serializeExchangesAsJson([exchange({ id: 'a' })]);
    expect(JSON.parse(output)).toEqual([exchange({ id: 'a' })]);
  });
});

describe('serializeHar', () => {
  it('pretty-prints an already-built HAR document', () => {
    const har: HarLog = { log: { version: '1.2', creator: { name: 'Detour Dashboard', version: '1' }, entries: [] } };
    expect(JSON.parse(serializeHar(har))).toEqual(har);
  });
});

describe('exportFileName', () => {
  it('embeds the format extension and an ISO-derived timestamp', () => {
    const when = new Date('2026-09-03T12:00:00.000Z');
    expect(exportFileName('har', when)).toBe('detour-log-2026-09-03T12-00-00-000Z.har');
    expect(exportFileName('json', when)).toBe('detour-log-2026-09-03T12-00-00-000Z.json');
  });
});
