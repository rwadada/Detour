import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapturedExchange, CapturedWebSocketConnection } from '../../domain/exchange/types';
import type { GrpcExchangeInfo } from '../../domain/grpc/grpcDumpFormat';
import { resolveDumpDir, writeExchangeDumpFile, writeWebSocketDumpFile } from './dumpFileWriter';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'detour-dump-test-'));
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function baseExchange(overrides: Partial<CapturedExchange> = {}): CapturedExchange {
  return {
    id: 'ex-1',
    method: 'GET',
    url: 'https://example.com',
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

describe('resolveDumpDir', () => {
  it('creates and returns ~/.detour/dumps', () => {
    // A temp home, so running the tests never creates or chmods the developer's real ~/.detour.
    const home = tmpDir();
    dirs.push(home);
    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      const dir = resolveDumpDir();
      expect(fs.existsSync(dir)).toBe(true);
      expect(dir).toBe(path.join(home, '.detour', 'dumps'));
    } finally {
      homedir.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'creates the directory owner-only and tightens an existing one (issue #303)',
    () => {
      const base = tmpDir();
      dirs.push(base);
      // eslint-disable-next-line sonarjs/file-permissions -- the umask a typical shell has, so the test proves the code does not rely on it.
      const previousUmask = process.umask(0o022);
      try {
        const created = resolveDumpDir(path.join(base, 'dumps'));
        expect(fs.statSync(created).mode & 0o777).toBe(0o700);
        // eslint-disable-next-line sonarjs/file-permissions -- test fixture simulating a pre-fix, world-readable file/directory.
        fs.chmodSync(created, 0o755);
        resolveDumpDir(created);
        expect(fs.statSync(created).mode & 0o777).toBe(0o700);
      } finally {
        process.umask(previousUmask);
      }
    },
  );
});

describe.skipIf(process.platform === 'win32')('dump file permissions (issue #303)', () => {
  it('writes exchange and WebSocket dumps 0600, including when overwriting a world-readable file', () => {
    const dir = tmpDir();
    dirs.push(dir);
    // eslint-disable-next-line sonarjs/file-permissions -- the umask a typical shell has, so the test proves the code does not rely on it.
    const previousUmask = process.umask(0o022);
    try {
      fs.writeFileSync(path.join(dir, 'ex-1.txt'), 'old', { mode: 0o644 });
      // eslint-disable-next-line sonarjs/file-permissions -- test fixture simulating a pre-fix, world-readable file/directory.
      fs.chmodSync(path.join(dir, 'ex-1.txt'), 0o644);
      writeExchangeDumpFile(baseExchange(), dir);
      expect(fs.statSync(path.join(dir, 'ex-1.txt')).mode & 0o777).toBe(0o600);

      const connection: CapturedWebSocketConnection = {
        id: 'ws-1',
        url: 'wss://example.com/socket',
        host: 'example.com',
        isSSL: true,
        requestHeaders: {},
        openedAt: 0,
        frames: [],
        frameCount: 0,
        framesTruncated: false,
      };
      writeWebSocketDumpFile(connection, dir);
      expect(fs.statSync(path.join(dir, 'ws-ws-1.txt')).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previousUmask);
    }
  });
});

describe('writeExchangeDumpFile', () => {
  it('writes a dump named after the exchange id, sanitizing unsafe characters', () => {
    const dir = tmpDir();
    dirs.push(dir);
    writeExchangeDumpFile(baseExchange({ id: 'a/b:c' }), dir);
    const written = fs.readFileSync(path.join(dir, 'a_b_c.txt'), 'utf8');
    expect(written).toContain('GET https://example.com');
  });

  it('writes the exchange dump alone when no grpcInfo is given', () => {
    const dir = tmpDir();
    dirs.push(dir);
    writeExchangeDumpFile(baseExchange(), dir);
    const written = fs.readFileSync(path.join(dir, 'ex-1.txt'), 'utf8');
    expect(written).toContain('GET https://example.com');
    expect(written).not.toContain('gRPC:');
  });

  it('appends the gRPC section after the exchange dump when grpcInfo is given', () => {
    const dir = tmpDir();
    dirs.push(dir);
    const grpcInfo: GrpcExchangeInfo = {
      service: 'helloworld.Greeter',
      method: 'SayHello',
      requestFrames: [{ json: { name: 'world' } }],
      requestFramesTruncated: false,
      responseFrames: [],
      responseFramesTruncated: false,
    };
    writeExchangeDumpFile(baseExchange(), dir, grpcInfo);
    const written = fs.readFileSync(path.join(dir, 'ex-1.txt'), 'utf8');
    expect(written).toContain('GET https://example.com');
    expect(written).toContain('gRPC: helloworld.Greeter/SayHello');
    expect(written).toContain('"name": "world"');
  });
});

describe('writeWebSocketDumpFile', () => {
  it('writes a dump named after the connection id with a "ws-" prefix', () => {
    const dir = tmpDir();
    dirs.push(dir);
    const connection: CapturedWebSocketConnection = {
      id: 'a/b:c',
      url: 'wss://example.com/socket',
      host: 'example.com',
      isSSL: true,
      requestHeaders: {},
      openedAt: 0,
      frames: [],
      frameCount: 0,
      framesTruncated: false,
    };
    writeWebSocketDumpFile(connection, dir);
    const written = fs.readFileSync(path.join(dir, 'ws-a_b_c.txt'), 'utf8');
    expect(written).toContain('WS wss://example.com/socket');
  });
});
