import protobuf from 'protobufjs';
import { describe, expect, it } from 'vitest';
import { decodeGrpcBody } from './decodeGrpcBody';

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

function schemaJson(): Record<string, unknown> {
  return protobuf.parse(PROTO_SOURCE).root.toJSON() as Record<string, unknown>;
}

/** Base64-encodes a single gRPC wire frame (1-byte flags + 4-byte BE length + payload) around an already-Protobuf-encoded message — the same shape a captured `CapturedExchange.requestBody`/`responseBody` has on the wire. */
function frameBase64(payload: Uint8Array): string {
  const framed = new Uint8Array(5 + payload.length);
  new DataView(framed.buffer).setUint32(1, payload.length, false);
  framed.set(payload, 5);
  return btoa(String.fromCharCode(...framed));
}

function encodedHelloRequest(name: string): Uint8Array {
  const root = protobuf.parse(PROTO_SOURCE).root;
  return root.lookupType('helloworld.HelloRequest').encode({ name }).finish();
}

describe('decodeGrpcBody', () => {
  it('reports "decoded" with no frames when the body is undefined (nothing captured)', async () => {
    const result = await decodeGrpcBody({
      body: undefined,
      schema: schemaJson(),
      service: 'helloworld.Greeter',
      method: 'SayHello',
      direction: 'request',
      grpcEncoding: undefined,
      bodyTruncated: false,
    });
    expect(result).toEqual({ kind: 'decoded', frames: [], framesTruncated: false });
  });

  it('reports "unavailable" when no schema is loaded for this session', async () => {
    const result = await decodeGrpcBody({
      body: frameBase64(encodedHelloRequest('x')),
      schema: null,
      service: 'helloworld.Greeter',
      method: 'SayHello',
      direction: 'request',
      grpcEncoding: undefined,
      bodyTruncated: false,
    });
    expect(result.kind).toBe('unavailable');
    expect(result).toMatchObject({ reason: expect.stringMatching(/no --proto configured/i) });
  });

  it('reports "unavailable" when the RPC is not declared in the loaded schema', async () => {
    const result = await decodeGrpcBody({
      body: frameBase64(encodedHelloRequest('x')),
      schema: schemaJson(),
      service: 'helloworld.Greeter',
      method: 'NoSuchMethod',
      direction: 'request',
      grpcEncoding: undefined,
      bodyTruncated: false,
    });
    expect(result).toMatchObject({ kind: 'unavailable', reason: expect.stringContaining('NoSuchMethod') });
  });

  it('reports "unavailable" for a malformed schema descriptor', async () => {
    const result = await decodeGrpcBody({
      body: frameBase64(encodedHelloRequest('x')),
      schema: { not: 'a real protobuf schema descriptor', nested: { deeply: true } },
      service: 'helloworld.Greeter',
      method: 'SayHello',
      direction: 'request',
      grpcEncoding: undefined,
      bodyTruncated: false,
    });
    // Whether an unrecognized JSON shape throws while building the Root or
    // just fails to resolve the method depends on protobufjs's own
    // leniency — either way this must come back as "unavailable", not throw.
    expect(result.kind).toBe('unavailable');
  });

  it('decodes the request side using requestType, and the response side using responseType', async () => {
    const root = protobuf.parse(PROTO_SOURCE).root;
    const requestBytes = root.lookupType('helloworld.HelloRequest').encode({ name: 'req' }).finish();
    const responseBytes = root.lookupType('helloworld.HelloReply').encode({ message: 'res' }).finish();

    const requestResult = await decodeGrpcBody({
      body: frameBase64(requestBytes),
      schema: schemaJson(),
      service: 'helloworld.Greeter',
      method: 'SayHello',
      direction: 'request',
      grpcEncoding: undefined,
      bodyTruncated: false,
    });
    expect(requestResult).toEqual({ kind: 'decoded', frames: [{ json: { name: 'req' } }], framesTruncated: false });

    const responseResult = await decodeGrpcBody({
      body: frameBase64(responseBytes),
      schema: schemaJson(),
      service: 'helloworld.Greeter',
      method: 'SayHello',
      direction: 'response',
      grpcEncoding: undefined,
      bodyTruncated: false,
    });
    expect(responseResult).toEqual({ kind: 'decoded', frames: [{ json: { message: 'res' } }], framesTruncated: false });
  });

  it('folds the exchange-level bodyTruncated flag into framesTruncated even when frame-splitting itself landed cleanly', async () => {
    const result = await decodeGrpcBody({
      body: frameBase64(encodedHelloRequest('x')),
      schema: schemaJson(),
      service: 'helloworld.Greeter',
      method: 'SayHello',
      direction: 'request',
      grpcEncoding: undefined,
      bodyTruncated: true,
    });
    expect(result).toMatchObject({ kind: 'decoded', framesTruncated: true });
  });

  it('reports "unavailable" for a body that is not valid base64', async () => {
    const result = await decodeGrpcBody({
      body: '!!! not base64 !!!',
      schema: schemaJson(),
      service: 'helloworld.Greeter',
      method: 'SayHello',
      direction: 'request',
      grpcEncoding: undefined,
      bodyTruncated: false,
    });
    expect(result).toMatchObject({ kind: 'unavailable', reason: expect.stringMatching(/not valid base64/i) });
  });
});
