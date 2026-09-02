import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import protobuf from 'protobufjs';
import { afterEach, describe, expect, it } from 'vitest';
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

function writeProtoFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-proto-test-'));
  const file = path.join(dir, 'helloworld.proto');
  fs.writeFileSync(file, PROTO_SOURCE, 'utf8');
  return file;
}

const dirs: string[] = [];
afterEach(() => {
  for (const file of dirs.splice(0)) fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

describe('ProtoRegistry', () => {
  it('resolves a declared method to its request/response types', async () => {
    const file = writeProtoFile();
    dirs.push(file);
    const registry = await ProtoRegistry.load([file]);

    const resolved = registry.resolveMethod('helloworld.Greeter', 'SayHello');
    expect(resolved?.requestType.name).toBe('HelloRequest');
    expect(resolved?.responseType.name).toBe('HelloReply');
  });

  it('returns undefined for an unknown service', async () => {
    const file = writeProtoFile();
    dirs.push(file);
    const registry = await ProtoRegistry.load([file]);
    expect(registry.resolveMethod('nope.NoSuchService', 'Method')).toBeUndefined();
  });

  it('returns undefined for a known service but unknown method', async () => {
    const file = writeProtoFile();
    dirs.push(file);
    const registry = await ProtoRegistry.load([file]);
    expect(registry.resolveMethod('helloworld.Greeter', 'NoSuchMethod')).toBeUndefined();
  });

  it('decodes a message encoded against the same schema into a plain object', async () => {
    const file = writeProtoFile();
    dirs.push(file);
    const registry = await ProtoRegistry.load([file]);
    const resolved = registry.resolveMethod('helloworld.Greeter', 'SayHello')!;

    const encoded = resolved.requestType.encode({ name: 'world' }).finish();
    const decoded = registry.decode(resolved.requestType, Buffer.from(encoded));

    expect(decoded).toEqual({ name: 'world' });
  });

  it('throws on a payload that is not valid for the given type', async () => {
    const file = writeProtoFile();
    dirs.push(file);
    const registry = await ProtoRegistry.load([file]);
    const resolved = registry.resolveMethod('helloworld.Greeter', 'SayHello')!;

    // A varint field tag claiming a wildly implausible length runs off the
    // end of the buffer — genuinely malformed input, not just "empty".
    const garbage = Buffer.from([0x0a, 0xff, 0xff, 0xff, 0xff, 0x0f]);
    expect(() => registry.decode(resolved.requestType, garbage)).toThrow();
  });

  it('resolves an import across multiple loaded .proto files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-proto-test-'));
    const baseFile = path.join(dir, 'base.proto');
    const serviceFile = path.join(dir, 'service.proto');
    fs.writeFileSync(baseFile, `syntax = "proto3";\npackage shared;\nmessage Empty {}\n`, 'utf8');
    fs.writeFileSync(
      serviceFile,
      `syntax = "proto3";\npackage shared;\nimport "base.proto";\nservice Pinger {\n  rpc Ping (Empty) returns (Empty);\n}\n`,
      'utf8',
    );
    dirs.push(baseFile, serviceFile);

    const registry = await ProtoRegistry.load([baseFile, serviceFile]);
    const resolved = registry.resolveMethod('shared.Pinger', 'Ping');
    expect(resolved?.requestType.name).toBe('Empty');
  });
});

// Sanity check that protobufjs itself is wired the way this test suite
// assumes (message.encode/finish → Buffer round-trips through decode).
describe('protobufjs sanity', () => {
  it('round-trips a parsed (not file-loaded) type', () => {
    const parsed = protobuf.parse(PROTO_SOURCE).root;
    const type = parsed.lookupType('helloworld.HelloRequest');
    const bytes = type.encode({ name: 'x' }).finish();
    expect(type.toObject(type.decode(bytes))).toEqual({ name: 'x' });
  });
});
