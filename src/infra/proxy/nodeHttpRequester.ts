import http, { type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http';
import https from 'node:https';
import type { HttpRequestOptions, HttpRequestResult, HttpRequester } from '../../usecase/ports/httpRequester';

/** `HttpRequester` (see usecase/ports/httpRequester.ts) backed by `node:http`/`node:https` — a real outbound request, chosen by the URL's scheme. */
export const nodeHttpRequester: HttpRequester = {
  request(options: HttpRequestOptions): Promise<HttpRequestResult> {
    return new Promise((resolve, reject) => {
      const url = new URL(options.url);
      const transport = url.protocol === 'https:' ? https : http;
      // The captured `content-length` is dropped upstream (it describes the
      // original bytes, and an edited body changes it), so state the real
      // length here. Without it Node sends the body chunked, which plenty of
      // servers and middleboxes read as an empty one.
      const headers: OutgoingHttpHeaders = { ...(options.headers as OutgoingHttpHeaders) };
      if (options.body) headers['content-length'] = options.body.length;
      const req = transport.request(url, { method: options.method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            statusMessage: res.statusMessage,
            headers: res.headers as IncomingHttpHeaders,
            body: Buffer.concat(chunks),
          });
        });
      });
      req.on('error', reject);
      req.end(options.body);
    });
  },
};
