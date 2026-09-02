import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { CapturedExchange } from '../../domain/exchange/types';
import { buildGrpcExchangeInfo } from './grpcExchangeInfo';
import { ProtoRegistry } from './protoRegistry';

const PROTO_SOURCE = `
syntax = "proto3";
package helloworld;

service Greeter {
  rpc SayHello (HelloRequest) returns (HelloReply);
}

message HelloRequest {
  string name = 1;
}

message HelloReply {
  string message = 1;
}
`;

const dirs: string[] = [];
afterEach(() => {
  for (const file of dirs.splice(0)) fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

async function loadRegistry(): Promise<ProtoRegistry> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-grpc-info-test-'));
  const file = path.join(dir, 'helloworld.proto');
  fs.writeFileSync(file, PROTO_SOURCE, 'utf8');
  dirs.push(file);
  return ProtoRegistry.load([file]);
}

/** Wraps a Protobuf-encoded payload in a single gRPC wire frame (1-byte flags + 4-byte BE length). */
function frame(payload: Buffer, flags = 0): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt8(flags, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

function baseExchange(overrides: Partial<CapturedExchange> = {}): CapturedExchange {
  return {
    id: 'ex-1',
    method: 'POST',
    url: 'https://api.example.com/helloworld.Greeter/SayHello',
    host: 'api.example.com',
    isSSL: true,
    protocol: 'HTTP/1.1',
    requestHeaders: { 'content-type': 'application/grpc+proto' },
    requestBodySize: 0,
    responseBodySize: 0,
    startedAt: 0,
    ...overrides,
  };
}

describe('buildGrpcExchangeInfo', () => {
  it('returns undefined for a non-gRPC content-type', () => {
    const exchange = baseExchange({ requestHeaders: { 'content-type': 'application/json' } });
    expect(buildGrpcExchangeInfo(exchange, undefined)).toBeUndefined();
  });

  it("detects gRPC regardless of the content-type header's casing", () => {
    // A `rewrite` rule's request.headers (from rules.json) or a breakpoint
    // edit's headers (typed by hand in the dashboard) aren't guaranteed to
    // be lowercased the way Node's own HTTP parser lowercases them.
    const exchange = baseExchange({ requestHeaders: { 'Content-Type': 'application/grpc+proto' } });
    expect(buildGrpcExchangeInfo(exchange, undefined)?.service).toBe('helloworld.Greeter');
  });

  it('returns undefined when the URL path is not a well-formed gRPC path', () => {
    const exchange = baseExchange({ url: 'https://api.example.com/not-grpc-shaped' });
    expect(buildGrpcExchangeInfo(exchange, undefined)).toBeUndefined();
  });

  it('reports decodeUnavailableReason when no registry is configured', () => {
    const info = buildGrpcExchangeInfo(baseExchange(), undefined);
    expect(info?.service).toBe('helloworld.Greeter');
    expect(info?.method).toBe('SayHello');
    expect(info?.decodeUnavailableReason).toMatch(/no --proto configured/);
  });

  it('reports decodeUnavailableReason when the schema does not declare the RPC', async () => {
    const registry = await loadRegistry();
    const exchange = baseExchange({ url: 'https://api.example.com/helloworld.Greeter/NoSuchMethod' });
    const info = buildGrpcExchangeInfo(exchange, registry);
    expect(info?.decodeUnavailableReason).toMatch(/not declared/);
  });

  it('decodes request and response messages using the loaded schema', async () => {
    const registry = await loadRegistry();
    const requestType = registry.resolveMethod('helloworld.Greeter', 'SayHello')!.requestType;
    const responseType = registry.resolveMethod('helloworld.Greeter', 'SayHello')!.responseType;
    const requestBody = frame(Buffer.from(requestType.encode({ name: 'world' }).finish()));
    const responseBody = frame(Buffer.from(responseType.encode({ message: 'hi world' }).finish()));

    const exchange = baseExchange({
      requestBody: requestBody.toString('base64'),
      responseHeaders: { 'content-type': 'application/grpc+proto' },
      responseBody: responseBody.toString('base64'),
    });

    const info = buildGrpcExchangeInfo(exchange, registry);
    expect(info?.decodeUnavailableReason).toBeUndefined();
    expect(info?.requestFrames).toEqual([{ json: { name: 'world' } }]);
    expect(info?.responseFrames).toEqual([{ json: { message: 'hi world' } }]);
  });

  it('decompresses a gzip-compressed frame per the grpc-encoding header', async () => {
    const registry = await loadRegistry();
    const requestType = registry.resolveMethod('helloworld.Greeter', 'SayHello')!.requestType;
    const compressed = zlib.gzipSync(Buffer.from(requestType.encode({ name: 'zipped' }).finish()));
    const requestBody = frame(compressed, 0x1);

    const exchange = baseExchange({
      requestHeaders: { 'content-type': 'application/grpc+proto', 'grpc-encoding': 'gzip' },
      requestBody: requestBody.toString('base64'),
    });

    const info = buildGrpcExchangeInfo(exchange, registry);
    expect(info?.requestFrames).toEqual([{ json: { name: 'zipped' } }]);
  });

  it('reports a per-frame error for an unsupported compression encoding', async () => {
    const registry = await loadRegistry();
    const requestBody = frame(Buffer.from('not really compressed'), 0x1);
    const exchange = baseExchange({
      requestHeaders: { 'content-type': 'application/grpc+proto', 'grpc-encoding': 'snappy' },
      requestBody: requestBody.toString('base64'),
    });

    const info = buildGrpcExchangeInfo(exchange, registry);
    expect(info?.requestFrames[0]?.error).toMatch(/unsupported grpc-encoding "snappy"/);
  });

  it('propagates frame truncation from splitGrpcFrames', async () => {
    const registry = await loadRegistry();
    const exchange = baseExchange({ requestBody: Buffer.from([0, 0, 0]).toString('base64') });
    const info = buildGrpcExchangeInfo(exchange, registry);
    expect(info?.requestFramesTruncated).toBe(true);
  });

  it('also reports truncation when BodyCapture itself truncated the body, even if it happened to land on a frame boundary', async () => {
    // Simulates BodyCapture's own cap (MAX_CAPTURED_BODY_BYTES) cutting the
    // body exactly at a frame boundary — splitGrpcFrames alone would see a
    // clean, "complete" stream and report untruncated, silently hiding that
    // later frames existed but were never captured.
    const registry = await loadRegistry();
    const requestType = registry.resolveMethod('helloworld.Greeter', 'SayHello')!.requestType;
    const completeFrame = frame(Buffer.from(requestType.encode({ name: 'world' }).finish()));
    const exchange = baseExchange({
      requestBody: completeFrame.toString('base64'),
      requestBodyTruncated: true,
    });
    const info = buildGrpcExchangeInfo(exchange, registry);
    expect(info?.requestFramesTruncated).toBe(true);
  });

  it('decodes gzip using a case-insensitive grpc-encoding header lookup', async () => {
    const registry = await loadRegistry();
    const requestType = registry.resolveMethod('helloworld.Greeter', 'SayHello')!.requestType;
    const compressed = zlib.gzipSync(Buffer.from(requestType.encode({ name: 'zipped' }).finish()));
    const requestBody = frame(compressed, 0x1);

    const exchange = baseExchange({
      requestHeaders: { 'content-type': 'application/grpc+proto', 'Grpc-Encoding': 'gzip' },
      requestBody: requestBody.toString('base64'),
    });

    const info = buildGrpcExchangeInfo(exchange, registry);
    expect(info?.requestFrames).toEqual([{ json: { name: 'zipped' } }]);
  });

  it('treats a missing body as zero frames rather than throwing', async () => {
    const registry = await loadRegistry();
    const info = buildGrpcExchangeInfo(baseExchange(), registry);
    expect(info?.requestFrames).toEqual([]);
    expect(info?.responseFrames).toEqual([]);
  });
});
