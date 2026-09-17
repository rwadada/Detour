import { describe, expect, it } from 'vitest';
import {
  detectBodyFormat,
  extractMultipartBoundary,
  formatXml,
  parseFormUrlEncoded,
  parseMultipartFormData,
} from './bodyFormat';

describe('detectBodyFormat', () => {
  it('classifies an image content-type', () => {
    expect(detectBodyFormat('image/png')).toBe('image');
    expect(detectBodyFormat('image/jpeg; charset=binary')).toBe('image');
  });

  it('classifies html/css/javascript', () => {
    expect(detectBodyFormat('text/html; charset=utf-8')).toBe('html');
    expect(detectBodyFormat('text/css')).toBe('css');
    expect(detectBodyFormat('application/javascript')).toBe('javascript');
    expect(detectBodyFormat('text/javascript')).toBe('javascript');
  });

  it('classifies json, including a "+json" structured suffix', () => {
    expect(detectBodyFormat('application/json')).toBe('json');
    expect(detectBodyFormat('application/vnd.api+json')).toBe('json');
  });

  it('classifies xml, including a "+xml" structured suffix', () => {
    expect(detectBodyFormat('application/xml')).toBe('xml');
    expect(detectBodyFormat('text/xml')).toBe('xml');
    expect(detectBodyFormat('application/atom+xml')).toBe('xml');
  });

  it('classifies form-urlencoded and multipart', () => {
    expect(detectBodyFormat('application/x-www-form-urlencoded')).toBe('form-urlencoded');
    expect(detectBodyFormat('multipart/form-data; boundary=abc')).toBe('multipart');
  });

  it('falls back to text for anything else, including gRPC and absent content-type', () => {
    expect(detectBodyFormat('application/grpc+proto')).toBe('text');
    expect(detectBodyFormat(undefined)).toBe('text');
    expect(detectBodyFormat('text/plain')).toBe('text');
  });
});

describe('extractMultipartBoundary', () => {
  it('reads an unquoted boundary', () => {
    expect(extractMultipartBoundary('multipart/form-data; boundary=----WebKitBoundary123')).toBe(
      '----WebKitBoundary123',
    );
  });

  it('reads a quoted boundary', () => {
    expect(extractMultipartBoundary('multipart/form-data; boundary="abc def"')).toBe('abc def');
  });

  it('returns undefined when no boundary is present', () => {
    expect(extractMultipartBoundary('multipart/form-data')).toBeUndefined();
    expect(extractMultipartBoundary(undefined)).toBeUndefined();
  });
});

describe('parseMultipartFormData', () => {
  const boundary = '----boundary123';

  it('parses a plain text field', () => {
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="username"\r\n\r\n` +
      `alice\r\n` +
      `--${boundary}--\r\n`;
    expect(parseMultipartFormData(body, boundary)).toEqual([
      { name: 'username', value: 'alice', filename: undefined, contentType: undefined },
    ]);
  });

  it('parses a file field, leaving its value empty', () => {
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="avatar"; filename="cat.png"\r\n` +
      `Content-Type: image/png\r\n\r\n` +
      `\x89PNG...binary...\r\n` +
      `--${boundary}--\r\n`;
    const fields = parseMultipartFormData(body, boundary);
    expect(fields).toEqual([{ name: 'avatar', value: '', filename: 'cat.png', contentType: 'image/png' }]);
  });

  it('parses multiple fields in order', () => {
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="a"\r\n\r\n1\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="b"\r\n\r\n2\r\n` +
      `--${boundary}--\r\n`;
    expect(parseMultipartFormData(body, boundary).map((f) => [f.name, f.value])).toEqual([
      ['a', '1'],
      ['b', '2'],
    ]);
  });

  it('skips a malformed part with no header/body separator', () => {
    const body = `--${boundary}\r\ngarbage\r\n--${boundary}--\r\n`;
    expect(parseMultipartFormData(body, boundary)).toEqual([]);
  });
});

describe('parseFormUrlEncoded', () => {
  it('decodes key/value pairs, including percent-encoding', () => {
    expect(parseFormUrlEncoded('name=John+Doe&city=New%20York')).toEqual([
      ['name', 'John Doe'],
      ['city', 'New York'],
    ]);
  });

  it('preserves duplicate keys as separate rows', () => {
    expect(parseFormUrlEncoded('tag=a&tag=b')).toEqual([
      ['tag', 'a'],
      ['tag', 'b'],
    ]);
  });

  it('returns an empty array for an empty body', () => {
    expect(parseFormUrlEncoded('')).toEqual([]);
  });
});

describe('formatXml', () => {
  it('inserts a newline between adjacent tags', () => {
    expect(formatXml('<root><child>text</child></root>')).toBe('<root>\n  <child>text</child>\n</root>');
  });

  it('dedents a closing tag one level before printing it', () => {
    const formatted = formatXml('<a><b><c/></b></a>');
    expect(formatted).toBe('<a>\n  <b>\n    <c/>\n  </b>\n</a>');
  });

  it('leaves an already-single-element document unchanged in structure', () => {
    expect(formatXml('<root/>')).toBe('<root/>');
  });
});
