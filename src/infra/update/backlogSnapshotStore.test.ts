import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CapturedExchange } from '../../domain/exchange/types';
import { BACKLOG_SNAPSHOT_TTL_MS } from '../../domain/update/backlogSnapshot';
import {
  backlogSnapshotPath,
  discardBacklogSnapshot,
  readBacklogSnapshot,
  writeBacklogSnapshot,
} from './backlogSnapshotStore';

function exchange(id: string): CapturedExchange {
  return {
    id,
    method: 'GET',
    url: `https://example.com/${id}`,
    host: 'example.com',
    isSSL: true,
    protocol: 'HTTP/1.1',
    requestHeaders: {},
    requestBodySize: 0,
    startedAt: 1,
    statusCode: 200,
    responseBodySize: 0,
    finishedAt: 2,
  };
}

describe('backlog snapshot store', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-snapshot-'));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('hands the saved exchanges to the next instance on the same port, until discarded', () => {
    writeBacklogSnapshot(8080, [exchange('a'), exchange('b')]);
    expect(readBacklogSnapshot(8080).map((e) => e.id)).toEqual(['a', 'b']);
    expect(readBacklogSnapshot(8080).map((e) => e.id)).toEqual(['a', 'b']);
    discardBacklogSnapshot(8080);
    expect(readBacklogSnapshot(8080)).toEqual([]);
  });

  it('keeps ports apart', () => {
    writeBacklogSnapshot(8080, [exchange('a')]);
    writeBacklogSnapshot(9090, [exchange('b')]);
    expect(readBacklogSnapshot(9090).map((e) => e.id)).toEqual(['b']);
    expect(readBacklogSnapshot(8080).map((e) => e.id)).toEqual(['a']);
  });

  it('writes owner-only files, since the traffic can hold credentials', () => {
    writeBacklogSnapshot(8080, [exchange('a')]);
    expect(fs.statSync(backlogSnapshotPath(8080)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(backlogSnapshotPath(8080))).mode & 0o777).toBe(0o700);
  });

  it('leaves no temp files behind', () => {
    writeBacklogSnapshot(8080, [exchange('a')]);
    expect(fs.readdirSync(path.dirname(backlogSnapshotPath(8080)))).toEqual(['8080.json']);
  });

  it('does not resume from a stale snapshot', () => {
    writeBacklogSnapshot(8080, [exchange('a')], 0);
    expect(readBacklogSnapshot(8080, BACKLOG_SNAPSHOT_TTL_MS + 1)).toEqual([]);
  });

  it('starts empty on a corrupt snapshot instead of failing', () => {
    fs.mkdirSync(path.dirname(backlogSnapshotPath(8080)), { recursive: true });
    fs.writeFileSync(backlogSnapshotPath(8080), '{broken');
    expect(readBacklogSnapshot(8080)).toEqual([]);
  });

  it('tightens the permissions of a directory that already existed', () => {
    const dir = path.dirname(backlogSnapshotPath(8080));
    fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
    fs.chmodSync(dir, 0o750);
    writeBacklogSnapshot(8080, [exchange('a')]);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('sweeps a temp file left by an interrupted write', () => {
    const dir = path.dirname(backlogSnapshotPath(8080));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${backlogSnapshotPath(8080)}.tmp`, 'half-written');
    discardBacklogSnapshot(8080);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('does not throw when the leftover file cannot be removed', () => {
    writeBacklogSnapshot(8080, [exchange('a')]);
    vi.spyOn(fs, 'rmSync').mockImplementation(() => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    });
    expect(() => discardBacklogSnapshot(8080)).not.toThrow();
  });

  it('can discard a snapshot, and tolerates there being none', () => {
    writeBacklogSnapshot(8080, [exchange('a')]);
    discardBacklogSnapshot(8080);
    expect(fs.existsSync(backlogSnapshotPath(8080))).toBe(false);
    expect(() => discardBacklogSnapshot(8080)).not.toThrow();
  });
});
