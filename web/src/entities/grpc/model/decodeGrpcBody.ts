import { base64ToBytes } from '@/shared/lib/utils';
import { buildSchemaRoot, decodeGrpcFrames, resolveGrpcMethod, type GrpcDecodedFrame } from './decodeGrpcFrames';
import { splitGrpcFrames } from './grpcFraming';

/**
 * The result of trying to decode one side (request or response) of a
 * captured gRPC exchange's body — mirrors the CLI's own
 * `GrpcExchangeInfo.decodeUnavailableReason` vs. actual frames split
 * (`infra/grpc/grpcExchangeInfo.ts`), just for one direction rather than
 * both at once (`BodyViewer` already renders request/response as separate
 * tabs, each with its own `decodeGrpcBody` call).
 */
export type GrpcBodyDecodeResult =
  | { kind: 'unavailable'; reason: string }
  | { kind: 'decoded'; frames: GrpcDecodedFrame[]; framesTruncated: boolean };

/**
 * Orchestrates decoding one direction of a gRPC exchange's body for
 * `BodyViewer`: reconstructs the schema from its JSON descriptor, resolves
 * the RPC's request/response type, splits the captured body into frames,
 * and decodes each one — reporting *why* decoding couldn't proceed (no
 * schema loaded, the RPC isn't declared in it, …) rather than just an empty
 * result, same as the CLI's own `--dump full` does for the same data.
 * Pulled out of `BodyViewer`'s own hook as a plain async function so this
 * orchestration is unit-testable without mounting a component.
 */
export async function decodeGrpcBody(params: {
  body: string | undefined;
  schema: Record<string, unknown> | null;
  service: string;
  method: string;
  direction: 'request' | 'response';
  grpcEncoding: string | undefined;
  bodyTruncated: boolean | undefined;
}): Promise<GrpcBodyDecodeResult> {
  const { body, schema, service, method, direction, grpcEncoding, bodyTruncated } = params;

  if (!body) return { kind: 'decoded', frames: [], framesTruncated: false };

  if (!schema) {
    return {
      kind: 'unavailable',
      reason: 'No --proto configured for this session — pass --proto <path> to detour start to decode messages.',
    };
  }

  let resolved;
  try {
    const root = buildSchemaRoot(schema);
    resolved = resolveGrpcMethod(root, service, method);
  } catch (err) {
    return {
      kind: 'unavailable',
      reason: `Failed to load the .proto schema: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!resolved) {
    return { kind: 'unavailable', reason: `"${service}/${method}" is not declared in the loaded .proto schema.` };
  }

  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(body);
  } catch {
    return { kind: 'unavailable', reason: 'Captured body is not valid base64 — cannot decode.' };
  }

  const type = direction === 'request' ? resolved.requestType : resolved.responseType;
  // `splitGrpcFrames` only sees a body already capped by the proxy's own
  // capture limit — if that cap happened to land exactly on a frame
  // boundary, it reports `truncated: false` even though later frames may
  // have existed beyond the cap and were never captured at all. Folding in
  // the exchange's own `bodyTruncated` flag catches that case too, mirroring
  // `grpcExchangeInfo.ts`'s own `requestFramesTruncated`/`responseFramesTruncated`.
  const { frames, truncated: framesSplitTruncated } = splitGrpcFrames(bytes);
  const decodedFrames = await decodeGrpcFrames(frames, type, grpcEncoding);
  return { kind: 'decoded', frames: decodedFrames, framesTruncated: framesSplitTruncated || Boolean(bodyTruncated) };
}
