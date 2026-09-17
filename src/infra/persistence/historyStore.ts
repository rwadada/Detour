import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type { HistoryQuery } from '../../domain/dashboard/protocol';
import type { CapturedExchange } from '../../domain/exchange/types';

export interface HistoryQueryResult {
  items: CapturedExchange[];
  hasMore: boolean;
}

/**
 * Optional SQLite-backed persistence for finished exchanges (issue #144),
 * opt-in via `detour start --persist`. Exists entirely to answer
 * `queryHistory` requests for traffic that's already fallen out of the
 * live dashboard's in-memory backlog (`DEFAULT_BACKLOG_SIZE`, 500 items) —
 * the live backlog, its item cap, and the 256KB per-body capture cap
 * (`MAX_CAPTURED_BODY_BYTES`) are all unchanged by this; a persisted
 * exchange is stored exactly as captured, truncated body and all.
 */
export interface HistoryStore {
  /** Upserts a finished exchange — called once per `response`/proxy-error event, same trigger as the CLI's own dump/log output. */
  record(exchange: Readonly<CapturedExchange>): void;
  /** Returns one page of persisted exchanges matching `query`, newest-first. */
  query(query: HistoryQuery): HistoryQueryResult;
  close(): void;
}

/**
 * Whether this Node runtime has `node:sqlite` (stable since Node 22.5,
 * always present from Node 24 on) — `--persist` requires it since this
 * feature intentionally adds no new npm dependency: a native SQLite binding
 * (e.g. `better-sqlite3`) would mean prebuilt binaries per platform for
 * every distribution channel this project ships through (`npm install`,
 * the single-file release tarball, Homebrew) — real cost for a feature
 * that's opt-in and off by default. `require('node:sqlite')` fresh each
 * call rather than caching a module-level constant: cheap (Node caches the
 * module internally), and avoids this file itself throwing at import time
 * on an older runtime that never uses `--persist` at all.
 */
export function isHistoryPersistenceSupported(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- see openHistoryStore's identical comment on why this must be a runtime require, not a static import.
    require('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS exchanges (
    id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    method TEXT NOT NULL,
    host TEXT NOT NULL,
    url TEXT NOT NULL,
    status_code INTEGER,
    data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS exchanges_started_at ON exchanges (started_at);
  CREATE INDEX IF NOT EXISTS exchanges_host ON exchanges (host);
`;

/** Builds a query's `WHERE` clause + matching parameter list from `HistoryQuery` — every clause parameterized, never string-interpolated, since `urlContains`/`host`/`method` all ultimately trace back to captured network traffic (attacker-influenced input). */
function buildWhereClause(query: HistoryQuery): { sql: string; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (query.before !== undefined) {
    clauses.push('started_at < ?');
    params.push(query.before);
  }
  if (query.method !== undefined) {
    clauses.push('method = ?');
    params.push(query.method);
  }
  if (query.host !== undefined) {
    clauses.push('host = ?');
    params.push(query.host);
  }
  if (query.urlContains !== undefined) {
    clauses.push("url LIKE ? ESCAPE '\\'");
    // Escapes SQL LIKE's own wildcards (`%`/`_`) in the *user's* substring so
    // e.g. searching for a literal "50%" doesn't act as a wildcard match.
    const escaped = query.urlContains.replace(/[\\%_]/g, (m) => `\\${m}`);
    params.push(`%${escaped}%`);
  }
  if (query.statusMin !== undefined) {
    clauses.push('status_code >= ?');
    params.push(query.statusMin);
  }
  if (query.statusMax !== undefined) {
    clauses.push('status_code <= ?');
    params.push(query.statusMax);
  }

  return { sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/**
 * Opens (creating if necessary, including parent directories) a SQLite
 * database at `dbPath` for `--persist`. Throws if `node:sqlite` isn't
 * available on this runtime (see `isHistoryPersistenceSupported`) — the
 * caller (cli.ts) is expected to check that first and fail startup with a
 * clear message rather than let this throw a raw `node:sqlite` import error.
 */
export function openHistoryStore(dbPath: string): HistoryStore {
  // Despite the type-only import above (erased at compile time), the actual
  // binding has to be loaded at runtime via `require` — a static `import`
  // would make *loading this module* fail outright on a runtime without
  // `node:sqlite`, defeating `isHistoryPersistenceSupported`'s whole point
  // of letting the rest of the CLI keep working without `--persist`.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db: DatabaseSyncType = new DatabaseSync(dbPath);
  db.exec(SCHEMA);

  const upsert = db.prepare(
    'INSERT OR REPLACE INTO exchanges (id, started_at, method, host, url, status_code, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );

  return {
    record(exchange) {
      upsert.run(
        exchange.id,
        exchange.startedAt,
        exchange.method,
        exchange.host,
        exchange.url,
        exchange.statusCode ?? null,
        JSON.stringify(exchange),
      );
    },

    query(query) {
      const { sql: where, params } = buildWhereClause(query);
      // Fetches one extra row purely to answer `hasMore` without a second
      // COUNT(*) query — sliced back off below before returning.
      const rows = db
        .prepare(`SELECT data FROM exchanges ${where} ORDER BY started_at DESC LIMIT ?`)
        .all(...params, query.limit + 1) as Array<{ data: string }>;
      const hasMore = rows.length > query.limit;
      const items = rows.slice(0, query.limit).map((row) => JSON.parse(row.data) as CapturedExchange);
      return { items, hasMore };
    },

    close() {
      db.close();
    },
  };
}
