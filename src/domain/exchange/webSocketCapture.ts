import { MAX_CAPTURED_BODY_BYTES } from './bodyCapture';
import type { CapturedWebSocketConnection, WebSocketFrameRecord } from './types';

/**
 * Upper bound on how many frames a `CapturedWebSocketConnection` keeps in
 * memory. A long-lived connection (a chat socket, a live feed) can carry an
 * unbounded number of frames over its lifetime; capturing them all would let
 * a single connection blow up process memory the same way an unbounded body
 * capture would (see `MAX_CAPTURED_BODY_BYTES`). Once hit, the oldest frame
 * is evicted to make room for the newest — recent activity is almost always
 * what a debugging session cares about — and `framesTruncated` is set so
 * consumers know the history is incomplete.
 */
export const MAX_CAPTURED_WS_FRAMES = 200;

/**
 * Appends a captured WebSocket frame to `connection.frames`, base64-encoding
 * and capping its payload the same way `BodyCapture` caps HTTP bodies, and
 * evicting the oldest frame once `MAX_CAPTURED_WS_FRAMES` is reached.
 * Mutates `connection` in place — mirrors `BodyCapture.applyTo`'s
 * convention of updating an existing record rather than returning a new one.
 */
export function recordWebSocketFrame(
  connection: CapturedWebSocketConnection,
  frame: {
    type: WebSocketFrameRecord['type'];
    direction: WebSocketFrameRecord['direction'];
    binary: boolean;
    payload: Buffer;
    at: number;
  },
): void {
  connection.frameCount += 1;

  const capped =
    frame.payload.length > MAX_CAPTURED_BODY_BYTES ? frame.payload.subarray(0, MAX_CAPTURED_BODY_BYTES) : frame.payload;
  const record: WebSocketFrameRecord = {
    type: frame.type,
    direction: frame.direction,
    binary: frame.binary,
    size: frame.payload.length,
    at: frame.at,
    data: capped.length > 0 ? capped.toString('base64') : undefined,
    truncated: capped.length < frame.payload.length,
  };

  if (connection.frames.length >= MAX_CAPTURED_WS_FRAMES) {
    connection.frames.shift();
    connection.framesTruncated = true;
  }
  connection.frames.push(record);
}
