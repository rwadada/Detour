import zlib from 'node:zlib';
import { findHeader } from '../../domain/exchange/headers';
import type { CapturedExchange } from '../../domain/exchange/types';
import type { GrpcDecodedFrame, GrpcExchangeInfo } from '../../domain/grpc/grpcDumpFormat';
import { type GrpcFrame, isGrpcContentType, parseGrpcPath, splitGrpcFrames } from '../../domain/grpc/grpcFraming';
import type { ProtoRegistry, ResolvedGrpcMethod } from './protoRegistry';
import type protobuf from 'protobufjs';

/** Single-value, case-insensitive read of a possibly multi-value header — see `findHeader`'s doc comment for why the lookup itself must be case-insensitive. */
function headerValue(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | undefined {
  const value = findHeader(headers, name);
  return (Array.isArray(value) ? value[0] : value)?.toLowerCase();
}

/**
 * Decompresses a frame's payload per its declared `grpc-encoding` (only
 * `gzip` — the overwhelmingly common case, and covered by Node's built-in
 * `zlib` — is supported; anything else is reported as an error rather than
 * silently handed to the Protobuf decoder as garbage bytes).
 */
function decompress(payload: Buffer, encoding: string | undefined): Buffer {
  if (encoding === 'gzip') return zlib.gunzipSync(payload);
  throw new Error(`compressed frame uses unsupported grpc-encoding "${encoding ?? '(unknown)'}"`);
}

function decodeFrames(
  frames: GrpcFrame[],
  type: protobuf.Type,
  registry: ProtoRegistry,
  encoding: string | undefined,
): GrpcDecodedFrame[] {
  return frames
    .filter((frame) => frame.kind === 'message')
    .map((frame) => {
      try {
        const payload = frame.compressed ? decompress(frame.payload, encoding) : frame.payload;
        return { json: registry.decode(type, payload) };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    });
}

function bufferOf(base64: string | undefined): Buffer {
  return base64 ? Buffer.from(base64, 'base64') : Buffer.alloc(0);
}

function unresolvedInfo(
  parsed: { service: string; method: string },
  truncated: { requestFramesTruncated: boolean; responseFramesTruncated: boolean },
  reason: string,
): GrpcExchangeInfo {
  return {
    service: parsed.service,
    method: parsed.method,
    requestFrames: [],
    responseFrames: [],
    ...truncated,
    decodeUnavailableReason: reason,
  };
}

/**
 * Builds a gRPC decode summary for `exchange` (issue #18): detects
 * `application/grpc*` traffic from its request content-type, resolves the
 * RPC method from its URL path (`/{service}/{method}`), and — when
 * `registry` both is given and declares that method — decodes every
 * captured message frame using the `.proto`-derived request/response
 * types. Returns undefined for a non-gRPC exchange (nothing to show).
 */
export function buildGrpcExchangeInfo(
  exchange: Readonly<CapturedExchange>,
  registry: ProtoRegistry | undefined,
): GrpcExchangeInfo | undefined {
  if (!isGrpcContentType(findHeader(exchange.requestHeaders, 'content-type'))) return undefined;

  let pathname: string;
  try {
    pathname = new URL(exchange.url).pathname;
  } catch {
    return undefined;
  }
  const parsed = parseGrpcPath(pathname);
  if (!parsed) return undefined;

  const { frames: requestFrames, truncated: requestFramesSplitTruncated } = splitGrpcFrames(
    bufferOf(exchange.requestBody),
  );
  const { frames: responseFrames, truncated: responseFramesSplitTruncated } = splitGrpcFrames(
    bufferOf(exchange.responseBody),
  );
  // `splitGrpcFrames` only sees a body already capped by `BodyCapture` (see
  // `MAX_CAPTURED_BODY_BYTES`) — if that cap happened to land exactly on a
  // frame boundary, it reports `truncated: false` even though later frames
  // may have existed beyond the cap and were never captured at all. Folding
  // in the exchange's own truncation flags catches that case too.
  const requestFramesTruncated = requestFramesSplitTruncated || Boolean(exchange.requestBodyTruncated);
  const responseFramesTruncated = responseFramesSplitTruncated || Boolean(exchange.responseBodyTruncated);

  const truncated = { requestFramesTruncated, responseFramesTruncated };

  if (!registry) {
    return unresolvedInfo(parsed, truncated, 'no --proto configured — pass --proto <path> to decode messages');
  }

  const resolved: ResolvedGrpcMethod | undefined = registry.resolveMethod(parsed.service, parsed.method);
  if (!resolved) {
    return unresolvedInfo(
      parsed,
      truncated,
      `"${parsed.service}/${parsed.method}" is not declared in the loaded .proto schema`,
    );
  }

  return {
    service: parsed.service,
    method: parsed.method,
    requestFrames: decodeFrames(
      requestFrames,
      resolved.requestType,
      registry,
      headerValue(exchange.requestHeaders, 'grpc-encoding'),
    ),
    requestFramesTruncated,
    responseFrames: decodeFrames(
      responseFrames,
      resolved.responseType,
      registry,
      headerValue(exchange.responseHeaders ?? {}, 'grpc-encoding'),
    ),
    responseFramesTruncated,
  };
}
