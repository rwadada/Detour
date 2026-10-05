import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeHttpRequester } from './nodeHttpRequester';

describe('nodeHttpRequester', () => {
  let server: http.Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  /** Echoes back what the server actually saw of the request — headers as received, and the body. */
  async function startEcho(): Promise<string> {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ headers: req.headers, body: Buffer.concat(chunks).toString() }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  }

  async function send(body?: Buffer) {
    const url = await startEcho();
    const result = await nodeHttpRequester.request({ method: 'POST', url, headers: {}, body });
    return JSON.parse(result.body.toString()) as { headers: Record<string, string>; body: string };
  }

  it('states the body length instead of sending it chunked (a chunked body reads as empty to many servers)', async () => {
    const seen = await send(Buffer.from('{"name":"日本語"}'));
    expect(seen.body).toBe('{"name":"日本語"}');
    expect(seen.headers['content-length']).toBe(String(Buffer.byteLength('{"name":"日本語"}')));
    expect(seen.headers['transfer-encoding']).toBeUndefined();
  });

  it('sends a request with no body as an empty, non-chunked one', async () => {
    const seen = await send(undefined);
    expect(seen.body).toBe('');
    expect(seen.headers['transfer-encoding']).toBeUndefined();
  });
});
