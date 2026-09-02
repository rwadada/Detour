import { describe, expect, it } from 'vitest';
import { isGrpcContentType, parseGrpcPath, splitGrpcFrames } from './grpcFraming';

/** Builds a single gRPC wire frame: 1-byte flags + 4-byte BE length + payload. */
function frame(payload: Buffer, flags = 0): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt8(flags, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

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

  it('rejects undefined and an empty array', () => {
    expect(isGrpcContentType(undefined)).toBe(false);
    expect(isGrpcContentType([])).toBe(false);
  });

  it('checks only the first value of a multi-value header', () => {
    expect(isGrpcContentType(['application/grpc', 'text/plain'])).toBe(true);
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
    const body = frame(Buffer.from('hello'));
    const { frames, truncated } = splitGrpcFrames(body);
    expect(truncated).toBe(false);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ kind: 'message', compressed: false });
    expect(frames[0]!.payload.toString('utf8')).toBe('hello');
  });

  it('parses multiple concatenated frames (e.g. a server-streaming response)', () => {
    const body = Buffer.concat([frame(Buffer.from('a')), frame(Buffer.from('bb'))]);
    const { frames } = splitGrpcFrames(body);
    expect(frames.map((f) => f.payload.toString('utf8'))).toEqual(['a', 'bb']);
  });

  it('marks the compressed flag from the frame header', () => {
    const body = frame(Buffer.from('x'), 0x1);
    const { frames } = splitGrpcFrames(body);
    expect(frames[0]!.compressed).toBe(true);
  });

  it('classifies a gRPC-Web trailer frame by its flag bit, distinct from a message', () => {
    const body = frame(Buffer.from('grpc-status:0\r\n'), 0x80);
    const { frames } = splitGrpcFrames(body);
    expect(frames[0]!.kind).toBe('trailer');
  });

  it('returns an empty, untruncated result for an empty body', () => {
    expect(splitGrpcFrames(Buffer.alloc(0))).toEqual({ frames: [], truncated: false });
  });

  it('reports truncated when the body ends mid-header', () => {
    const { frames, truncated } = splitGrpcFrames(Buffer.from([0, 0, 0]));
    expect(frames).toEqual([]);
    expect(truncated).toBe(true);
  });

  it("reports truncated when a frame's declared length exceeds what is left, keeping frames parsed before it", () => {
    const complete = frame(Buffer.from('ok'));
    const header = Buffer.alloc(5);
    header.writeUInt32BE(1000, 1); // claims 1000 bytes of payload that were never captured
    const body = Buffer.concat([complete, header]);
    const { frames, truncated } = splitGrpcFrames(body);
    expect(frames).toHaveLength(1);
    expect(truncated).toBe(true);
  });
});
