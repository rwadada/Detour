import type { MockAction } from './types';

export interface MockResponse {
  status: number;
  statusMessage?: string;
  headers: Record<string, string>;
  body: Buffer;
}

/** A `bodyFile`'s contents, already read from disk by the caller — reading the file itself is Infrastructure's job (see `resolveMockResponse` in infra/proxy/actionsRuntime.ts). */
export interface MockBodyFile {
  bytes: Buffer;
  /** Whether the file's extension is `.json` — used to default Content-Type the same way an inline object body does. */
  looksLikeJson: boolean;
}

function hasHeaderNamed(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

/**
 * Builds a `mock` action's response status/headers/body, given the
 * already-resolved `bodyFile` bytes (if any). Pure — reading `bodyFile` off
 * disk is Infrastructure's job (see `resolveMockResponse`); this only
 * assembles the result, filling in Content-Type/-Length if absent.
 */
export function buildMockResponse(action: MockAction, bodyFile?: MockBodyFile): MockResponse {
  let body: Buffer;
  let looksLikeJson = false;

  if (bodyFile) {
    body = bodyFile.bytes;
    looksLikeJson = bodyFile.looksLikeJson;
  } else if (action.body === undefined) {
    body = Buffer.alloc(0);
  } else if (typeof action.body === 'string') {
    body = Buffer.from(action.body, 'utf8');
  } else {
    body = Buffer.from(JSON.stringify(action.body), 'utf8');
    looksLikeJson = true;
  }

  const headers: Record<string, string> = { ...(action.headers ?? {}) };
  if (looksLikeJson && !hasHeaderNamed(headers, 'content-type')) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
  }
  if (!hasHeaderNamed(headers, 'content-length')) {
    headers['Content-Length'] = String(body.length);
  }

  return { status: action.status ?? 200, statusMessage: action.statusMessage, headers, body };
}
