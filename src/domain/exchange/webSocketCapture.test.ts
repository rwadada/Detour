import { describe, expect, it } from 'vitest';
import { MAX_CAPTURED_BODY_BYTES } from './bodyCapture';
import type { CapturedWebSocketConnection } from './types';
import { MAX_CAPTURED_WS_FRAMES, recordWebSocketFrame } from './webSocketCapture';

function connection(): CapturedWebSocketConnection {
  return {
    id: 'ws-1',
    url: 'wss://example.com/socket',
    host: 'example.com',
    isSSL: true,
    requestHeaders: {},
    openedAt: 0,
    frames: [],
    frameCount: 0,
    framesTruncated: false,
  };
}

function frame(overrides: Partial<Parameters<typeof recordWebSocketFrame>[1]> = {}) {
  return {
    type: 'message' as const,
    direction: 'toServer' as const,
    binary: false,
    payload: Buffer.from('hello'),
    at: 1,
    ...overrides,
  };
}

describe('recordWebSocketFrame', () => {
  it('appends a captured frame with base64 data and untruncated', () => {
    const conn = connection();
    recordWebSocketFrame(conn, frame());
    expect(conn.frames).toHaveLength(1);
    expect(conn.frameCount).toBe(1);
    const recorded = conn.frames[0]!;
    expect(Buffer.from(recorded.data ?? '', 'base64').toString('utf8')).toBe('hello');
    expect(recorded.truncated).toBe(false);
    expect(recorded.size).toBe(5);
  });

  it('omits `data` for an empty payload', () => {
    const conn = connection();
    recordWebSocketFrame(conn, frame({ payload: Buffer.alloc(0) }));
    const recorded = conn.frames[0]!;
    expect(recorded.data).toBeUndefined();
    expect(recorded.size).toBe(0);
  });

  it('caps an oversized payload at MAX_CAPTURED_BODY_BYTES and marks it truncated', () => {
    const conn = connection();
    const big = Buffer.alloc(MAX_CAPTURED_BODY_BYTES + 10, 'a');
    recordWebSocketFrame(conn, frame({ payload: big }));
    const recorded = conn.frames[0]!;
    expect(recorded.truncated).toBe(true);
    expect(recorded.size).toBe(MAX_CAPTURED_BODY_BYTES + 10);
    expect(Buffer.from(recorded.data ?? '', 'base64')).toHaveLength(MAX_CAPTURED_BODY_BYTES);
  });

  it('preserves direction, type, and binary flag', () => {
    const conn = connection();
    recordWebSocketFrame(conn, frame({ direction: 'toClient', type: 'ping', binary: true }));
    expect(conn.frames[0]).toMatchObject({ direction: 'toClient', type: 'ping', binary: true });
  });

  it('increments frameCount for every frame, even once frames start being evicted', () => {
    const conn = connection();
    for (let i = 0; i < MAX_CAPTURED_WS_FRAMES + 5; i++) {
      recordWebSocketFrame(conn, frame({ at: i }));
    }
    expect(conn.frameCount).toBe(MAX_CAPTURED_WS_FRAMES + 5);
  });

  it('evicts the oldest frame and sets framesTruncated once MAX_CAPTURED_WS_FRAMES is exceeded', () => {
    const conn = connection();
    for (let i = 0; i < MAX_CAPTURED_WS_FRAMES; i++) {
      recordWebSocketFrame(conn, frame({ at: i }));
    }
    expect(conn.framesTruncated).toBe(false);
    expect(conn.frames).toHaveLength(MAX_CAPTURED_WS_FRAMES);

    recordWebSocketFrame(conn, frame({ at: 999 }));

    expect(conn.framesTruncated).toBe(true);
    expect(conn.frames).toHaveLength(MAX_CAPTURED_WS_FRAMES);
    // The oldest frame (at: 0) was evicted; the newest is now the last entry.
    expect(conn.frames[0]!.at).toBe(1);
    expect(conn.frames.at(-1)?.at).toBe(999);
  });
});
