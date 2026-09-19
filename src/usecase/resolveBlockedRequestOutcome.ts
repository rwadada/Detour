import type { MockResponse } from '../domain/rules/mockResponse';

export type BlockedRequestOutcome = { kind: 'reset'; errorMessage: string } | { kind: 'mock'; mock: MockResponse };

/**
 * Decides how a Block Hosts denial responds — the pure half of the
 * `isHostBlocked` branch in `proxyServer.ts`'s `onRequest` handler. Sending
 * the outcome (`sendMockSimulate`/`sendMockResponse`, socket-level) and
 * recording it on the exchange stay the caller's job; this only decides
 * what should happen, given the current mode and which host triggered it.
 */
export function resolveBlockedRequestOutcome(mode: 'forbidden' | 'reset', host: string): BlockedRequestOutcome {
  if (mode === 'reset') {
    return { kind: 'reset', errorMessage: `blocked host "${host}": simulated connection close (no response sent)` };
  }
  const mock: MockResponse = {
    status: 403,
    statusMessage: 'Forbidden',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body: Buffer.from(`detour: request to "${host}" blocked by Block Hosts\n`, 'utf8'),
  };
  return { kind: 'mock', mock };
}
