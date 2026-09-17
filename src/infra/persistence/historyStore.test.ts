import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CapturedExchange } from '../../domain/exchange/types';
import { isHistoryPersistenceSupported, openHistoryStore } from './historyStore';

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-history-test-'));
  dirs.push(dir);
  return path.join(dir, 'history.db');
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function exchange(overrides: Partial<CapturedExchange> = {}): CapturedExchange {
  return {
    id: 'ex-1',
    method: 'GET',
    url: 'https://api.example.com/users',
    host: 'api.example.com',
    isSSL: true,
    protocol: 'HTTP/1.1',
    requestHeaders: {},
    requestBodySize: 0,
    responseBodySize: 0,
    startedAt: 1000,
    statusCode: 200,
    ...overrides,
  };
}

describe('isHistoryPersistenceSupported', () => {
  it('reflects whether node:sqlite actually loads on this runtime', () => {
    // This suite itself only runs meaningfully when it's supported (every
    // other test below `openHistoryStore`s), so this is really just
    // asserting the detection function doesn't throw and returns a boolean.
    expect(typeof isHistoryPersistenceSupported()).toBe('boolean');
  });
});

describe.skipIf(!isHistoryPersistenceSupported())('openHistoryStore', () => {
  it('creates the database file and its parent directory', () => {
    const dbPath = tmpDbPath();
    const store = openHistoryStore(dbPath);
    expect(fs.existsSync(dbPath)).toBe(true);
    store.close();
  });

  it('round-trips a recorded exchange back out via query', () => {
    const store = openHistoryStore(tmpDbPath());
    store.record(exchange());
    const result = store.query({ limit: 10 });
    expect(result.items).toEqual([exchange()]);
    expect(result.hasMore).toBe(false);
    store.close();
  });

  it('upserts rather than duplicating a re-recorded exchange with the same id', () => {
    const store = openHistoryStore(tmpDbPath());
    store.record(exchange({ statusCode: undefined }));
    store.record(exchange({ statusCode: 200 }));
    const result = store.query({ limit: 10 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.statusCode).toBe(200);
    store.close();
  });

  it('orders results newest-first and paginates via `before`/`hasMore`', () => {
    const store = openHistoryStore(tmpDbPath());
    for (let i = 0; i < 5; i++) store.record(exchange({ id: `ex-${i}`, startedAt: i * 1000 }));

    const firstPage = store.query({ limit: 2 });
    expect(firstPage.items.map((e) => e.id)).toEqual(['ex-4', 'ex-3']);
    expect(firstPage.hasMore).toBe(true);

    const secondPage = store.query({ limit: 2, before: firstPage.items[1]!.startedAt });
    expect(secondPage.items.map((e) => e.id)).toEqual(['ex-2', 'ex-1']);
    expect(secondPage.hasMore).toBe(true);

    const lastPage = store.query({ limit: 2, before: secondPage.items[1]!.startedAt });
    expect(lastPage.items.map((e) => e.id)).toEqual(['ex-0']);
    expect(lastPage.hasMore).toBe(false);
    store.close();
  });

  it('filters by exact method and host', () => {
    const store = openHistoryStore(tmpDbPath());
    store.record(exchange({ id: 'a', method: 'GET', host: 'api.example.com' }));
    store.record(exchange({ id: 'b', method: 'POST', host: 'api.example.com' }));
    store.record(exchange({ id: 'c', method: 'GET', host: 'other.example.com' }));

    expect(store.query({ limit: 10, method: 'POST' }).items.map((e) => e.id)).toEqual(['b']);
    expect(store.query({ limit: 10, host: 'other.example.com' }).items.map((e) => e.id)).toEqual(['c']);
    store.close();
  });

  it("filters by a case-insensitive URL substring, escaping the substring's own SQL wildcards", () => {
    const store = openHistoryStore(tmpDbPath());
    store.record(exchange({ id: 'a', url: 'https://api.example.com/users/123' }));
    store.record(exchange({ id: 'b', url: 'https://api.example.com/orders/50%off-sale' }));

    expect(store.query({ limit: 10, urlContains: 'users' }).items.map((e) => e.id)).toEqual(['a']);
    // A literal "%" in the query must not act as a SQL LIKE wildcard.
    expect(store.query({ limit: 10, urlContains: '50%off' }).items.map((e) => e.id)).toEqual(['b']);
    // Case-insensitivity itself — not just wildcard-escaping — has to hold
    // regardless of this connection's `case_sensitive_like` pragma, not by
    // relying on plain `LIKE`'s own (togglable) default.
    expect(store.query({ limit: 10, urlContains: 'USERS' }).items.map((e) => e.id)).toEqual(['a']);
    store.close();
  });

  it('filters by a status code range', () => {
    const store = openHistoryStore(tmpDbPath());
    store.record(exchange({ id: 'ok', statusCode: 200 }));
    store.record(exchange({ id: 'client-error', statusCode: 404 }));
    store.record(exchange({ id: 'server-error', statusCode: 500 }));

    expect(store.query({ limit: 10, statusMin: 400, statusMax: 499 }).items.map((e) => e.id)).toEqual(['client-error']);
    expect(
      store
        .query({ limit: 10, statusMin: 400 })
        .items.map((e) => e.id)
        .sort(),
    ).toEqual(['client-error', 'server-error']);
    store.close();
  });

  it('clamps an unreasonably large client-supplied limit rather than trusting it verbatim', () => {
    const store = openHistoryStore(tmpDbPath());
    for (let i = 0; i < 5; i++) store.record(exchange({ id: `ex-${i}`, startedAt: i * 1000 }));

    const result = store.query({ limit: Number.MAX_SAFE_INTEGER });

    expect(result.items).toHaveLength(5);
    expect(result.hasMore).toBe(false);
    store.close();
  });

  it('treats a non-positive or non-integer limit as 1 rather than erroring or returning everything', () => {
    const store = openHistoryStore(tmpDbPath());
    store.record(exchange({ id: 'a', startedAt: 2000 }));
    store.record(exchange({ id: 'b', startedAt: 1000 }));

    expect(store.query({ limit: 0 }).items.map((e) => e.id)).toEqual(['a']);
    expect(store.query({ limit: -5 }).items.map((e) => e.id)).toEqual(['a']);
    expect(store.query({ limit: Number.NaN }).items.map((e) => e.id)).toEqual(['a']);
    store.close();
  });

  it('persists across separate store instances against the same file', () => {
    const dbPath = tmpDbPath();
    const first = openHistoryStore(dbPath);
    first.record(exchange());
    first.close();

    const second = openHistoryStore(dbPath);
    expect(second.query({ limit: 10 }).items).toHaveLength(1);
    second.close();
  });
});
