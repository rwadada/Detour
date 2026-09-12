import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeCapturedBody, decodeCapturedBodyAsync, findHeaderValue, needsDecompression } from './utils';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe('decodeCapturedBody', () => {
  it('decodes a plain UTF-8 body', () => {
    expect(decodeCapturedBody(btoa('{"ok":true}'))).toBe('{"ok":true}');
  });

  it('reports non-UTF-8 bytes as undefined', () => {
    expect(decodeCapturedBody(bytesToBase64(new Uint8Array([0xff, 0xfe, 0x00])))).toBeUndefined();
  });
});

describe('decodeCapturedBodyAsync', () => {
  it('decodes an uncompressed body the same as decodeCapturedBody', async () => {
    const base64 = btoa('{"ok":true}');
    await expect(decodeCapturedBodyAsync(base64)).resolves.toBe('{"ok":true}');
  });

  // Regression test for issue #115: a gzip-compressed JSON response used to
  // fail the plain UTF-8 decode and get reported as binary.
  it('transparently un-gzips a gzip-encoded body', async () => {
    const json = JSON.stringify({ hello: 'world', n: 42 });
    const gzipped = zlib.gzipSync(Buffer.from(json, 'utf-8'));
    const base64 = bytesToBase64(new Uint8Array(gzipped));

    await expect(decodeCapturedBodyAsync(base64, 'gzip')).resolves.toBe(json);
  });

  it('handles a deflate-encoded body', async () => {
    const json = JSON.stringify({ deflated: true });
    const deflated = zlib.deflateSync(Buffer.from(json, 'utf-8'));
    const base64 = bytesToBase64(new Uint8Array(deflated));

    await expect(decodeCapturedBodyAsync(base64, 'deflate')).resolves.toBe(json);
  });

  it('falls back to a plain decode when the encoding is unrecognized', async () => {
    const base64 = btoa('plain text');
    await expect(decodeCapturedBodyAsync(base64, 'identity')).resolves.toBe('plain text');
  });

  it('falls back to a plain decode when a truncated gzip stream fails to decompress', async () => {
    const gzipped = zlib.gzipSync(Buffer.from('{"ok":true}', 'utf-8'));
    // Simulate a capture cut off mid-stream (MAX_CAPTURED_BODY_BYTES) rather
    // than a genuinely corrupt body.
    const truncated = gzipped.subarray(0, gzipped.length - 4);
    const base64 = bytesToBase64(new Uint8Array(truncated));

    // The truncated gzip bytes aren't valid UTF-8 either, so this still
    // reports binary rather than throwing.
    await expect(decodeCapturedBodyAsync(base64, 'gzip')).resolves.toBeUndefined();
  });

  it('still reports genuinely binary bodies as undefined', async () => {
    const base64 = bytesToBase64(new Uint8Array([0xff, 0xfe, 0x00, 0x01]));
    await expect(decodeCapturedBodyAsync(base64)).resolves.toBeUndefined();
  });
});

// Regression coverage for a PR review comment on issue #115's fix: BodyViewer
// uses this to take a synchronous fast path for the common (uncompressed)
// case instead of always flashing "Decoding…" through decodeCapturedBodyAsync's
// async DecompressionStream round trip, even when nothing needs decompressing.
describe('needsDecompression', () => {
  it('is true for a recognized compression coding', () => {
    expect(needsDecompression('gzip')).toBe(true);
    expect(needsDecompression('x-gzip')).toBe(true);
    expect(needsDecompression('deflate')).toBe(true);
    expect(needsDecompression('br')).toBe(true);
  });

  it('is false when absent, identity, or unrecognized', () => {
    expect(needsDecompression(undefined)).toBe(false);
    expect(needsDecompression('identity')).toBe(false);
    expect(needsDecompression('bogus')).toBe(false);
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(needsDecompression('  GZIP  ')).toBe(true);
  });
});

describe('findHeaderValue', () => {
  it('finds a header case-insensitively', () => {
    expect(findHeaderValue({ 'Content-Encoding': 'gzip' }, 'content-encoding')).toBe('gzip');
  });

  it('returns the first value of a multi-value header', () => {
    expect(findHeaderValue({ 'set-cookie': ['a=1', 'b=2'] }, 'set-cookie')).toBe('a=1');
  });

  it('returns undefined when absent', () => {
    expect(findHeaderValue({ 'content-type': 'application/json' }, 'content-encoding')).toBeUndefined();
    expect(findHeaderValue(undefined, 'content-encoding')).toBeUndefined();
  });
});
