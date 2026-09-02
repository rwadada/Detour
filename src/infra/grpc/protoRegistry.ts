import protobuf from 'protobufjs';

export interface ResolvedGrpcMethod {
  requestType: protobuf.Type;
  responseType: protobuf.Type;
}

/**
 * Loads `.proto` file(s) into a Protobuf schema and resolves gRPC service
 * methods against it, so a captured message's raw bytes can be decoded
 * using the request/response type declared for that RPC (issue #18) — no
 * extra type-name mapping needed beyond the `.proto` files themselves.
 */
export class ProtoRegistry {
  private constructor(private readonly root: protobuf.Root) {}

  /**
   * Parses `paths` (one or more `.proto` files) into a single schema and
   * resolves every cross-file/import reference up front — the same
   * fail-fast-at-startup convention `rules.json` uses (see cli.ts), so a
   * broken schema is caught immediately rather than surfacing as a decode
   * error deep into a session.
   */
  static async load(paths: string[]): Promise<ProtoRegistry> {
    const root = await protobuf.load(paths);
    root.resolveAll();
    return new ProtoRegistry(root);
  }

  /** Looks up the request/response message types declared for `service`'s `method`, or undefined if the loaded schema doesn't define it. */
  resolveMethod(service: string, method: string): ResolvedGrpcMethod | undefined {
    let svc: protobuf.Service;
    try {
      svc = this.root.lookupService(service);
    } catch {
      return undefined;
    }
    const rpc = svc.methods[method];
    if (!rpc?.resolvedRequestType || !rpc.resolvedResponseType) return undefined;
    return { requestType: rpc.resolvedRequestType, responseType: rpc.resolvedResponseType };
  }

  /**
   * Decodes `payload` as a message of `type`, converting it to a plain
   * JSON-friendly object (64-bit integers and byte fields as strings, enums
   * by name). Throws on malformed input — callers decode one frame at a
   * time and should catch per frame, so one bad message doesn't take down
   * the whole dump.
   */
  decode(type: protobuf.Type, payload: Buffer): unknown {
    const message = type.decode(payload);
    return type.toObject(message, { longs: String, enums: String, bytes: String, defaults: false });
  }
}
