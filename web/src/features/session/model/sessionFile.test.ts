import { describe, expect, it } from 'vitest';
import type { Filters } from '@/entities/exchange';
import type { CapturedExchange } from '@/shared/api';

// A plain literal rather than `@/entities/exchange`'s `DEFAULT_FILTERS` —
// that barrel's `index.ts` opens a real WebSocket as an import-time side
// effect (see its own doc comment), which fails outside a browser/jsdom
// environment (this project's vitest config runs `environment: 'node'`),
// and reaching past the barrel into its internals is itself a public-API
// sidestep FSD's linter flags. This is just as good for what these tests
// check: `buildSessionFile` treats `filters` opaquely either way.
const DEFAULT_FILTERS: Filters = { method: 'ALL', status: 'ALL', query: '' };
import {
  buildSessionFile,
  parseSessionFile,
  SESSION_FILE_VERSION,
  serializeSessionFile,
  sessionFileName,
  type SessionSettings,
} from './sessionFile';

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

const SETTINGS: SessionSettings = {
  intercept: { enabled: true },
  focus: { hosts: [] },
  throttle: { enabled: false, downKbps: 0, upKbps: 0, latencyMs: 0, packetLossPct: 0 },
  blockHosts: { hosts: [], mode: 'forbidden' },
};

describe('buildSessionFile / serializeSessionFile', () => {
  it('stamps the current version and given savedAt, round-trips through parseSessionFile', () => {
    const when = new Date('2026-09-03T12:00:00.000Z');
    const file = buildSessionFile({ exchanges: [exchange()], settings: SETTINGS, filters: DEFAULT_FILTERS, when });
    expect(file.detourSession).toBe(SESSION_FILE_VERSION);
    expect(file.savedAt).toBe('2026-09-03T12:00:00.000Z');

    const parsed = parseSessionFile(serializeSessionFile(file));
    expect(parsed).toEqual(file);
  });
});

describe('sessionFileName', () => {
  it('embeds an ISO-derived timestamp', () => {
    expect(sessionFileName(new Date('2026-09-03T12:00:00.000Z'))).toBe('detour-session-2026-09-03T12-00-00-000Z.json');
  });
});

describe('parseSessionFile', () => {
  it('rejects invalid JSON', () => {
    expect(() => parseSessionFile('not json')).toThrow(/valid JSON/);
  });

  it('rejects a non-object payload', () => {
    expect(() => parseSessionFile('42')).toThrow(/Detour session file/);
  });

  it('rejects a missing/mismatched detourSession version', () => {
    const withoutVersion = JSON.stringify({ exchanges: [], settings: SETTINGS, filters: DEFAULT_FILTERS });
    expect(() => parseSessionFile(withoutVersion)).toThrow(/version/);

    const wrongVersion = JSON.stringify({
      detourSession: 999,
      exchanges: [],
      settings: SETTINGS,
      filters: DEFAULT_FILTERS,
    });
    expect(() => parseSessionFile(wrongVersion)).toThrow(/version/);
  });

  it('rejects a missing "exchanges"', () => {
    const missing = JSON.stringify({
      detourSession: SESSION_FILE_VERSION,
      settings: SETTINGS,
      filters: DEFAULT_FILTERS,
    });
    expect(() => parseSessionFile(missing)).toThrow(/exchanges/);
  });

  it('rejects a missing "settings"', () => {
    const missing = JSON.stringify({ detourSession: SESSION_FILE_VERSION, exchanges: [], filters: DEFAULT_FILTERS });
    expect(() => parseSessionFile(missing)).toThrow(/settings/);
  });

  it('rejects a missing "filters"', () => {
    const missing = JSON.stringify({ detourSession: SESSION_FILE_VERSION, exchanges: [], settings: SETTINGS });
    expect(() => parseSessionFile(missing)).toThrow(/filters/);
  });
});
