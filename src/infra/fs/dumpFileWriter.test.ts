import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

function baseExchange(): CapturedExchange {
  return {
    id: 'ex-1',
    method: 'GET',
    url: 'https://example.com',
    host: 'example.com',
    isSSL: true,
    requestHeaders: {},
    requestBodySize: 0,
    responseBodySize: 0,
    startedAt: 0,
  };
}
describe('resolveDumpDir', () => {
  it('creates and returns ~/.detour/dumps', () => {
    const dir = resolveDumpDir();
    expect(fs.existsSync(dir)).toBe(true);
    expect(dir).toBe(path.join(os.homedir(), '.detour', 'dumps'));
  });
});

describe('writeExchangeDumpFile', () => {
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

  it('writes a dump named after the exchange id, sanitizing unsafe characters', () => {
    const dir = tmpDir();
    dirs.push(dir);
    const exchange: CapturedExchange = {
      id: 'a/b:c',
      method: 'GET',
      url: 'https://example.com',
      host: 'example.com',
      isSSL: true,
      requestHeaders: {},
      requestBodySize: 0,
      responseBodySize: 0,
      startedAt: 0,
    };
    writeExchangeDumpFile(exchange, dir);
    const written = fs.readFileSync(path.join(dir, 'a_b_c.txt'), 'utf8');
    expect(written).toContain('GET https://example.com');
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
