import type { CapturedExchange } from './types';

/**
 * Upper bound (in bytes, pre-base64) on how much of a request/response body
 * we hold in memory per exchange for the dashboard's inspector. Traffic
 * bodies can be arbitrarily large (file uploads/downloads); capturing them
 * unbounded would let a single exchange blow up process memory. Bytes past
 * this cap are still proxied through to the client/server as normal — only
 * the *captured copy* used for display is truncated.
 */
export const MAX_CAPTURED_BODY_BYTES = 256 * 1024;

/** Accumulates chunks up to `MAX_CAPTURED_BODY_BYTES` and reports whether more arrived than that. */
export class BodyCapture {
  private readonly chunks: Buffer[] = [];
  private capturedBytes = 0;
  private truncated = false;

  add(chunk: Buffer): void {
    if (chunk.length === 0) return;
    if (this.capturedBytes >= MAX_CAPTURED_BODY_BYTES) {
      this.truncated = true;
      return;
    }
    const room = MAX_CAPTURED_BODY_BYTES - this.capturedBytes;
    const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
    this.chunks.push(slice);
    this.capturedBytes += slice.length;
    if (slice.length < chunk.length) this.truncated = true;
  }

  /** Applies the capture to an exchange's `{prefix}Body`/`{prefix}BodyTruncated` fields. Omitted entirely when nothing was captured. */
  applyTo(exchange: CapturedExchange, prefix: 'request' | 'response'): void {
    if (this.chunks.length === 0) return;
    const body = Buffer.concat(this.chunks).toString('base64');
    if (prefix === 'request') {
      exchange.requestBody = body;
      exchange.requestBodyTruncated = this.truncated;
    } else {
      exchange.responseBody = body;
      exchange.responseBodyTruncated = this.truncated;
    }
  }

  /** Same capping as `add`, for a body that's already fully in memory (e.g. a resolved `mock` action's response). */
  static of(buffer: Buffer): BodyCapture {
    const capture = new BodyCapture();
    capture.add(buffer);
    return capture;
  }

  /**
   * Whether more than `MAX_CAPTURED_BODY_BYTES` has been fed to this
   * capture. Lets a caller that keeps its own uncapped copy of the body (a
   * `breakpoint` rule forwarding the real, untruncated bytes while using
   * this capture only for the dashboard's display copy — see issue #95)
   * report accurate truncation without re-wrapping its already-capped
   * buffer, which would silently launder `truncated` back to `false`.
   */
  get isTruncated(): boolean {
    return this.truncated;
  }

  /** The captured bytes as a single buffer (capped the same as `add`/`applyTo`). */
  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}
