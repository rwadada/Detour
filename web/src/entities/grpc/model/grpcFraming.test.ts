import { describe, expect, it } from 'vitest';
import { isGrpcContentType, parseGrpcPath, splitGrpcFrames } from './grpcFraming';

/** Builds a single gRPC wire frame: 1-byte flags + 4-byte BE length + payload. */
function frame(payload: Uint8Array, flags = 0): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, flags);
  view.setUint32(1, payload.length, false);
  out.set(payload, 5);
  return out;
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function textOf(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function concat(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// This mirrors src/domain/grpc/grpcFraming.test.ts exactly (same cases,
// Uint8Array instead of Node's Buffer) — see this file's own doc comment on
// why the source itself is duplicated rather than shared.
describe('isGrpcContentType', () => {
  it('matches bare "application/grpc"', () => {
    expect(isGrpcContentType('application/grpc')).toBe(true);
  });

  it('matches a serialization suffix (e.g. "+proto")', () => {
    expect(isGrpcContentType('application/grpc+proto')).toBe(true);
  });

  it('matches "application/grpc-web" and its suffixed variants', () => {
    expect(isGrpcContentType('application/grpc-web')).toBe(true);
    expect(isGrpcContentType('application/grpc-web+proto')).toBe(true);
    expect(isGrpcContentType('application/grpc-web-text')).toBe(true);
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(isGrpcContentType(' APPLICATION/GRPC+PROTO ')).toBe(true);
  });

  it('rejects an unrelated content-type', () => {
    expect(isGrpcContentType('application/json')).toBe(false);
    expect(isGrpcContentType('application/grpcfoo')).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isGrpcContentType(undefined)).toBe(false);
  });
});

describe('parseGrpcPath', () => {
  it('extracts service and method from a well-formed gRPC path', () => {
    expect(parseGrpcPath('/helloworld.Greeter/SayHello')).toEqual({
      service: 'helloworld.Greeter',
      method: 'SayHello',
    });
  });

  it('tolerates a trailing slash', () => {
    expect(parseGrpcPath('/pkg.Svc/Method/')).toEqual({ service: 'pkg.Svc', method: 'Method' });
  });

  it('returns undefined for a path with the wrong number of segments', () => {
    expect(parseGrpcPath('/onlyOneSegment')).toBeUndefined();
    expect(parseGrpcPath('/a/b/c')).toBeUndefined();
    expect(parseGrpcPath('/')).toBeUndefined();
  });
});

describe('splitGrpcFrames', () => {
  it('parses a single untruncated message frame', () => {
    const body = frame(bytesOf('hello'));
    const { frames, truncated } = splitGrpcFrames(body);
    expect(truncated).toBe(false);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ kind: 'message', compressed: false });
    expect(textOf(frames[0]!.payload)).toBe('hello');
  });

  it('parses multiple concatenated frames (e.g. a server-streaming response)', () => {
    const body = concat(frame(bytesOf('a')), frame(bytesOf('bb')));
    const { frames } = splitGrpcFrames(body);
    expect(frames.map((f) => textOf(f.payload))).toEqual(['a', 'bb']);
  });

  it('marks the compressed flag from the frame header', () => {
    const body = frame(bytesOf('x'), 0x1);
    const { frames } = splitGrpcFrames(body);
    expect(frames[0]!.compressed).toBe(true);
  });

  it('classifies a gRPC-Web trailer frame by its flag bit, distinct from a message', () => {
    const body = frame(bytesOf('grpc-status:0\r\n'), 0x80);
    const { frames } = splitGrpcFrames(body);
    expect(frames[0]!.kind).toBe('trailer');
  });

  it('returns an empty, untruncated result for an empty body', () => {
    expect(splitGrpcFrames(new Uint8Array(0))).toEqual({ frames: [], truncated: false });
  });

  it('reports truncated when the body ends mid-header', () => {
    const { frames, truncated } = splitGrpcFrames(new Uint8Array([0, 0, 0]));
    expect(frames).toEqual([]);
    expect(truncated).toBe(true);
  });

  it("reports truncated when a frame's declared length exceeds what is left, keeping frames parsed before it", () => {
    const complete = frame(bytesOf('ok'));
    const header = new Uint8Array(5);
    new DataView(header.buffer).setUint32(1, 1000, false); // claims 1000 bytes of payload that were never captured
    const body = concat(complete, header);
    const { frames, truncated } = splitGrpcFrames(body);
    expect(frames).toHaveLength(1);
    expect(truncated).toBe(true);
  });

  it('operates on a subarray view (a base64-decoded body sliced from a larger buffer) without reading past its own bounds', () => {
    // `DataView`'s own constructor needs the byteOffset/byteLength of the
    // *view*, not the backing buffer — using body.buffer directly without
    // them (an easy mistake porting from Buffer, which has no such
    // distinction) would silently read from the wrong offset for exactly
    // this case.
    const backing = concat(bytesOf('leading-junk'), frame(bytesOf('hi')));
    const view = backing.subarray('leading-junk'.length);
    const { frames, truncated } = splitGrpcFrames(view);
    expect(truncated).toBe(false);
    expect(frames.map((f) => textOf(f.payload))).toEqual(['hi']);
  });
});
