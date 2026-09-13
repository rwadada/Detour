/**
 * gRPC wire-format detection and framing, mirrored client-side from
 * `src/domain/grpc/grpcFraming.ts` (issue #18's dashboard follow-up) —
 * deliberately duplicated, not imported, the same way `ringBuffer.ts` is
 * (see `.jscpd.json`): this dashboard is a standalone package with no
 * import path back into the CLI's `src/`, and the only difference here is
 * operating on a browser `Uint8Array` instead of Node's `Buffer` (no
 * `readUInt32BE`/`subarray`-on-Buffer equivalent without one). Keep both in
 * sync if the framing logic itself ever changes.
 */

/**
 * Matches `application/grpc` (native gRPC, HTTP/2) and `application/grpc-web`
 * (the HTTP/1.1-compatible variant browsers use), each optionally suffixed
 * with a serialization (`+proto`, `+json`, …) or, for grpc-web, `-text` (a
 * base64-wrapped variant this module doesn't unwrap — its frames won't
 * parse as binary and will just come back `truncated`).
 */
const GRPC_CONTENT_TYPE_PATTERN = /^application\/grpc(-web)?(\+|-|$)/i;

/** Whether `contentType` (a raw `content-type` header value, e.g. `"application/grpc+proto"`) identifies gRPC/gRPC-Web traffic. */
export function isGrpcContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  return GRPC_CONTENT_TYPE_PATTERN.test(contentType.trim());
}

/**
 * Extracts the `{service, method}` a gRPC call targets from its request
 * path, per the protocol's fixed `/{package.Service}/{Method}` convention
 * (e.g. `/helloworld.Greeter/SayHello`).
 */
export function parseGrpcPath(pathname: string): { service: string; method: string } | undefined {
  const match = /^\/([^/]+)\/([^/]+)\/?$/.exec(pathname);
  if (!match) return undefined;
  return { service: match[1]!, method: match[2]! };
}

/** One length-delimited frame from a gRPC/gRPC-Web message stream. */
export interface GrpcFrame {
  /**
   * `'message'` carries an (optionally compressed) Protobuf-encoded
   * message; `'trailer'` is gRPC-Web's way of embedding HTTP-style
   * trailing headers (status, etc.) as a final frame in the body — not
   * something a `.proto` schema can decode, so callers should render it as
   * text rather than attempt Protobuf decoding.
   */
  kind: 'message' | 'trailer';
  /** True when the message payload is compressed (per the frame's compression flag) — this module does not decompress it. */
  compressed: boolean;
  payload: Uint8Array;
}

/** 1-byte flags + 4-byte big-endian length, per gRPC's wire framing. */
const FRAME_HEADER_BYTES = 5;
const TRAILER_FLAG = 0x80;
const COMPRESSED_FLAG = 0x1;

/**
 * Splits a captured gRPC/gRPC-Web body into its individual length-delimited
 * frames. Stops (without erroring) at the first incomplete frame — expected
 * whenever the body itself was truncated by the proxy's own capture cap, or
 * a streaming call was still in flight when captured — and reports that via
 * `truncated` rather than losing frames that did parse cleanly.
 */
export function splitGrpcFrames(body: Uint8Array): { frames: GrpcFrame[]; truncated: boolean } {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const frames: GrpcFrame[] = [];
  let offset = 0;
  while (offset + FRAME_HEADER_BYTES <= body.length) {
    const flags = view.getUint8(offset);
    const length = view.getUint32(offset + 1, false);
    const payloadStart = offset + FRAME_HEADER_BYTES;
    const payloadEnd = payloadStart + length;
    if (payloadEnd > body.length) break;
    frames.push({
      kind: (flags & TRAILER_FLAG) !== 0 ? 'trailer' : 'message',
      compressed: (flags & COMPRESSED_FLAG) !== 0,
      payload: body.subarray(payloadStart, payloadEnd),
    });
    offset = payloadEnd;
  }
  return { frames, truncated: offset < body.length };
}
