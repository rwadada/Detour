/**
 * Renders a gRPC-decoded exchange (issue #18) as a human-readable dump
 * section, appended alongside `formatExchangeDump`'s regular output by
 * `presentation/logger.ts` / `infra/fs/dumpFileWriter.ts`. Kept separate
 * from `domain/dump/dumpPolicy.ts` since building `GrpcExchangeInfo` itself
 * needs a `.proto`-derived schema (an infra concern — see
 * `infra/grpc/protoRegistry.ts`); this module only formats whatever was
 * already decoded (or, when it couldn't be, why not).
 */

/** One gRPC message frame, decoded to a plain object — or, if that failed, why. */
export interface GrpcDecodedFrame {
  json?: unknown;
  error?: string;
}

/** A gRPC call's decode result: which RPC it targeted, and its request/response messages. */
export interface GrpcExchangeInfo {
  service: string;
  method: string;
  requestFrames: GrpcDecodedFrame[];
  /** True when the request body's last frame was incomplete (see `splitGrpcFrames`) — frames parsed before it are still included. */
  requestFramesTruncated: boolean;
  responseFrames: GrpcDecodedFrame[];
  responseFramesTruncated: boolean;
  /**
   * Set when messages couldn't even be attempted — no `--proto` was
   * configured, or the schema doesn't declare this RPC — explaining why in
   * place of the (necessarily empty) frame lists above.
   */
  decodeUnavailableReason?: string;
}

const SEPARATOR = '='.repeat(60);

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

function formatFrame(frame: GrpcDecodedFrame, index: number): string {
  if (frame.error) return `  [${index}] (${frame.error})`;
  return `  [${index}]\n${indent(JSON.stringify(frame.json, null, 2))}`;
}

function formatFrameList(label: string, frames: GrpcDecodedFrame[], truncated: boolean): string[] {
  const count = truncated ? `${frames.length}+, truncated` : `${frames.length}`;
  const lines = [`${label} (${count}):`];
  if (frames.length === 0) {
    lines.push('  (none)');
  } else {
    frames.forEach((frame, i) => lines.push(formatFrame(frame, i)));
  }
  return lines;
}

/** Renders `info` as a labeled block — the RPC method, then decoded request/response messages (or, absent a schema, why they're missing). */
export function formatGrpcSection(info: GrpcExchangeInfo): string {
  const lines: string[] = [SEPARATOR, `gRPC: ${info.service}/${info.method}`];

  if (info.decodeUnavailableReason) {
    lines.push(info.decodeUnavailableReason);
  } else {
    lines.push(...formatFrameList('Request messages', info.requestFrames, info.requestFramesTruncated));
    lines.push(...formatFrameList('Response messages', info.responseFrames, info.responseFramesTruncated));
  }

  lines.push(SEPARATOR);
  return lines.join('\n');
}
