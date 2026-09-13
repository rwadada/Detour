import { Root, type Type } from 'protobufjs/light';
import type { GrpcFrame } from './grpcFraming';

/** One gRPC message frame, decoded to a plain object — or, if that failed, why. Mirrors `src/domain/grpc/grpcDumpFormat.ts`'s `GrpcDecodedFrame` (the CLI's own dump format for the same data), so a frame looks the same whether it came from `--dump full` or this dashboard. */
export interface GrpcDecodedFrame {
  json?: unknown;
  error?: string;
}

export interface ResolvedGrpcMethod {
  requestType: Type;
  responseType: Type;
}

/**
 * Reconstructs a usable schema from the JSON descriptor the dashboard
 * server sent as `protoSchema` (`ProtoRegistry.toJSON()`'s output —
 * `protobufjs`'s own serialization of a `Root`). `protobufjs/light` (not
 * the full build with the `.proto` text parser this dashboard has no use
 * for and would only add dead weight to the bundle) is enough: a JSON
 * descriptor needs no parsing, only `Root.fromJSON` + reflection.
 */
export function buildSchemaRoot(schema: Record<string, unknown>): Root {
  const root = Root.fromJSON(schema);
  root.resolveAll();
  return root;
}

/** Looks up the request/response message types declared for `service`'s `method` in `root`, or undefined if the schema doesn't define it — mirrors `ProtoRegistry.resolveMethod`. */
export function resolveGrpcMethod(root: Root, service: string, method: string): ResolvedGrpcMethod | undefined {
  let svc;
  try {
    svc = root.lookupService(service);
  } catch {
    return undefined;
  }
  const rpc = svc.methods[method];
  if (!rpc?.resolvedRequestType || !rpc.resolvedResponseType) return undefined;
  return { requestType: rpc.resolvedRequestType, responseType: rpc.resolvedResponseType };
}

/**
 * Decompresses a frame's payload per its declared `grpc-encoding` (only
 * `gzip` is supported, same as the CLI's own `grpcExchangeInfo.ts` —
 * anything else is reported as a per-frame error rather than silently
 * handed to the Protobuf decoder as garbage bytes). Uses the browser's
 * native `DecompressionStream`, the same way `decodeCapturedBodyAsync`
 * (shared/lib/utils.ts) already reverses a body's HTTP-level
 * `Content-Encoding` — gRPC's own per-message compression is a completely
 * separate mechanism (a dedicated `grpc-encoding` header plus each frame's
 * own compression flag byte, not `Content-Encoding`), but the underlying
 * browser API doing the actual decompression work is the same one either
 * way.
 */
async function decompress(payload: Uint8Array, encoding: string | undefined): Promise<Uint8Array> {
  if (encoding !== 'gzip') {
    throw new Error(`compressed frame uses unsupported grpc-encoding "${encoding ?? '(unknown)'}"`);
  }
  const stream = new Blob([payload as BufferSource]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Decodes every `'message'` frame in `frames` (trailer frames — gRPC-Web's
 * way of embedding HTTP-style trailing headers — are skipped; a `.proto`
 * schema has nothing to say about those) as a message of `type`, mirroring
 * `infra/grpc/grpcExchangeInfo.ts`'s own `decodeFrames` server-side. A
 * frame that fails to decompress or parse gets its own `error` instead of
 * aborting the whole batch, so one bad message doesn't hide the rest.
 */
export async function decodeGrpcFrames(
  frames: GrpcFrame[],
  type: Type,
  encoding: string | undefined,
): Promise<GrpcDecodedFrame[]> {
  const messageFrames = frames.filter((frame) => frame.kind === 'message');
  return Promise.all(
    messageFrames.map(async (frame) => {
      try {
        const payload = frame.compressed ? await decompress(frame.payload, encoding) : frame.payload;
        const message = type.decode(payload);
        return { json: type.toObject(message, { longs: String, enums: String, bytes: String, defaults: false }) };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
}
