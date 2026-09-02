import { describe, expect, it } from 'vitest';
import { BodyCapture, MAX_CAPTURED_BODY_BYTES } from './bodyCapture';
import type { CapturedExchange } from './types';

function exchange(): CapturedExchange {
  return {
    id: 'x',
    method: 'GET',
    url: 'https://example.com',
    host: 'example.com',
    isSSL: true,
    protocol: 'HTTP/1.1',
    requestHeaders: {},
    requestBodySize: 0,
    responseBodySize: 0,
    startedAt: 0,
  };
}

describe('BodyCapture', () => {
  it('applies nothing when no chunk was added', () => {
    const capture = new BodyCapture();
    const ex = exchange();
    capture.applyTo(ex, 'request');
    expect(ex.requestBody).toBeUndefined();
  });

  it('captures a chunk and reports it untruncated', () => {
    const capture = new BodyCapture();
    capture.add(Buffer.from('hello'));
    const ex = exchange();
    capture.applyTo(ex, 'response');
    expect(Buffer.from(ex.responseBody ?? '', 'base64').toString('utf8')).toBe('hello');
    expect(ex.responseBodyTruncated).toBe(false);
  });

  it('truncates past MAX_CAPTURED_BODY_BYTES', () => {
    const capture = new BodyCapture();
    capture.add(Buffer.alloc(MAX_CAPTURED_BODY_BYTES + 10, 'a'));
    const ex = exchange();
    capture.applyTo(ex, 'request');
    expect(ex.requestBodyTruncated).toBe(true);
    expect(Buffer.from(ex.requestBody ?? '', 'base64')).toHaveLength(MAX_CAPTURED_BODY_BYTES);
  });

  it('BodyCapture.of() caps a buffer already in memory the same way', () => {
    const capture = BodyCapture.of(Buffer.from('hi'));
    expect(capture.toBuffer().toString('utf8')).toBe('hi');
  });
});
