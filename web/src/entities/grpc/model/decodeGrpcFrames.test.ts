import protobuf from 'protobufjs';
import { describe, expect, it } from 'vitest';
import { buildSchemaRoot, decodeGrpcFrames, resolveGrpcMethod } from './decodeGrpcFrames';
import type { GrpcFrame } from './grpcFraming';

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

/** The JSON descriptor `dashboardServer.ts` would send as `protoSchema` for this fixture — built with the full (Node-only) `protobufjs` package, same as `ProtoRegistry.toJSON()` does server-side; the code under test only ever consumes the JSON, via `protobufjs/light`. */
function schemaJson(): Record<string, unknown> {
  return protobuf.parse(PROTO_SOURCE).root.toJSON() as Record<string, unknown>;
}

describe('buildSchemaRoot / resolveGrpcMethod', () => {
  it('resolves a declared method to its request/response types', () => {
    const root = buildSchemaRoot(schemaJson());
    const resolved = resolveGrpcMethod(root, 'helloworld.Greeter', 'SayHello');
    expect(resolved?.requestType.name).toBe('HelloRequest');
    expect(resolved?.responseType.name).toBe('HelloReply');
  });

  it('returns undefined for an unknown service', () => {
    const root = buildSchemaRoot(schemaJson());
    expect(resolveGrpcMethod(root, 'nope.NoSuchService', 'Method')).toBeUndefined();
  });

  it('returns undefined for a known service but unknown method', () => {
    const root = buildSchemaRoot(schemaJson());
    expect(resolveGrpcMethod(root, 'helloworld.Greeter', 'NoSuchMethod')).toBeUndefined();
  });

  it('caches the resolved Root per schema object identity, rebuilding only for a different object', () => {
    const schema = schemaJson();
    const first = buildSchemaRoot(schema);
    const second = buildSchemaRoot(schema);
    expect(second).toBe(first);

    const otherSchema = schemaJson();
    expect(buildSchemaRoot(otherSchema)).not.toBe(first);
  });
});

describe('decodeGrpcFrames', () => {
  function messageFrame(payload: Uint8Array, compressed = false): GrpcFrame {
    return { kind: 'message', compressed, payload };
  }

  it('decodes an uncompressed message frame into a plain object', async () => {
    const root = buildSchemaRoot(schemaJson());
    const { requestType } = resolveGrpcMethod(root, 'helloworld.Greeter', 'SayHello')!;
    const encoded = requestType.encode({ name: 'world' }).finish();

    const decoded = await decodeGrpcFrames([messageFrame(encoded)], requestType, undefined);
    expect(decoded).toEqual([{ json: { name: 'world' } }]);
  });

  it("decodes a trailer frame as text instead of attempting to parse it as a message — a .proto schema has nothing to say about it, and dropping it would hide a grpc-web call's actual outcome (often reported only in the trailer, with an HTTP 200 on the wire)", async () => {
    const root = buildSchemaRoot(schemaJson());
    const { requestType } = resolveGrpcMethod(root, 'helloworld.Greeter', 'SayHello')!;
    const encoded = requestType.encode({ name: 'x' }).finish();
    const trailer: GrpcFrame = {
      kind: 'trailer',
      compressed: false,
      payload: new TextEncoder().encode('grpc-status:0\r\n'),
    };

    const decoded = await decodeGrpcFrames([messageFrame(encoded), trailer], requestType, undefined);
    expect(decoded).toEqual([{ json: { name: 'x' } }, { trailer: 'grpc-status:0\r\n' }]);
  });

  it('reports a per-frame error for a payload that fails to decode, without aborting the rest', async () => {
    const root = buildSchemaRoot(schemaJson());
    const { requestType } = resolveGrpcMethod(root, 'helloworld.Greeter', 'SayHello')!;
    const good = requestType.encode({ name: 'ok' }).finish();
    // A varint field tag claiming a wildly implausible length runs off the
    // end of the buffer — genuinely malformed input, not just "empty".
    const garbage = new Uint8Array([0x0a, 0xff, 0xff, 0xff, 0xff, 0x0f]);

    const decoded = await decodeGrpcFrames([messageFrame(garbage), messageFrame(good)], requestType, undefined);
    expect(decoded).toHaveLength(2);
    expect(decoded[0]!.json).toBeUndefined();
    expect(decoded[0]!.error).toEqual(expect.any(String));
    expect(decoded[1]).toEqual({ json: { name: 'ok' } });
  });

  it('decompresses a gzip-flagged frame before decoding it', async () => {
    const root = buildSchemaRoot(schemaJson());
    const { requestType } = resolveGrpcMethod(root, 'helloworld.Greeter', 'SayHello')!;
    const encoded = requestType.encode({ name: 'compressed' }).finish();
    const gzipped = new Uint8Array(
      await new Response(
        new Blob([encoded as BufferSource]).stream().pipeThrough(new CompressionStream('gzip')),
      ).arrayBuffer(),
    );

    const decoded = await decodeGrpcFrames([messageFrame(gzipped, true)], requestType, 'gzip');
    expect(decoded).toEqual([{ json: { name: 'compressed' } }]);
  });

  it('tolerates a grpc-encoding header with different casing or surrounding whitespace', async () => {
    const root = buildSchemaRoot(schemaJson());
    const { requestType } = resolveGrpcMethod(root, 'helloworld.Greeter', 'SayHello')!;
    const encoded = requestType.encode({ name: 'compressed' }).finish();
    const gzipped = new Uint8Array(
      await new Response(
        new Blob([encoded as BufferSource]).stream().pipeThrough(new CompressionStream('gzip')),
      ).arrayBuffer(),
    );

    const decoded = await decodeGrpcFrames([messageFrame(gzipped, true)], requestType, ' GZIP ');
    expect(decoded).toEqual([{ json: { name: 'compressed' } }]);
  });

  it('reports an error for a compressed frame whose grpc-encoding is unsupported', async () => {
    const root = buildSchemaRoot(schemaJson());
    const { requestType } = resolveGrpcMethod(root, 'helloworld.Greeter', 'SayHello')!;
    const encoded = requestType.encode({ name: 'x' }).finish();

    const decoded = await decodeGrpcFrames([messageFrame(encoded, true)], requestType, 'br');
    expect(decoded[0]!.json).toBeUndefined();
    expect(decoded[0]!.error).toMatch(/unsupported grpc-encoding "br"/);
  });

  it('decodes a body consisting of only a trailer (e.g. a failed grpc-web call with no message frames)', async () => {
    const root = buildSchemaRoot(schemaJson());
    const { requestType } = resolveGrpcMethod(root, 'helloworld.Greeter', 'SayHello')!;
    const trailer: GrpcFrame = {
      kind: 'trailer',
      compressed: false,
      payload: new TextEncoder().encode('grpc-status:2\r\ngrpc-message:boom\r\n'),
    };

    const decoded = await decodeGrpcFrames([trailer], requestType, undefined);
    expect(decoded).toEqual([{ trailer: 'grpc-status:2\r\ngrpc-message:boom\r\n' }]);
  });

  it('returns an empty list for no frames', async () => {
    const root = buildSchemaRoot(schemaJson());
    const { requestType } = resolveGrpcMethod(root, 'helloworld.Greeter', 'SayHello')!;
    expect(await decodeGrpcFrames([], requestType, undefined)).toEqual([]);
  });
});
