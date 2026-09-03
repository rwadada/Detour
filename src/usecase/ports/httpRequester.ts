import type { IncomingHttpHeaders } from 'node:http';

export interface HttpRequestOptions {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body?: Buffer;
}

export interface HttpRequestResult {
  statusCode: number;
  statusMessage?: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/**
 * Performs a real outbound HTTP(S) request — injected so replay logic
 * (`usecase/replayExchange.ts`, issue #19's Replay) never touches
 * `node:http`/`node:https` directly. Implemented against the real network
 * by `infra/proxy/nodeHttpRequester.ts`.
 */
export interface HttpRequester {
  request(options: HttpRequestOptions): Promise<HttpRequestResult>;
}
