import crypto from 'node:crypto';
import {
  type AutoPassthroughHosts,
  clientCertRejectionAlert,
} from '../../../domain/autoPassthrough/clientCertRejection';
import type { CapturedExchange } from '../../../domain/exchange/types';
import { connectMatchUrl } from '../../../domain/focus/focusPolicy';
import type { DetourEventBus } from '../../eventBus';
import type { OnTlsClientErrorParams } from '../engine/types';

export interface ClientCertRejectionDeps {
  eventBus: DetourEventBus;
  /** Where refusing hosts are recorded for auto TLS passthrough; omitted when that's turned off (`--no-auto-passthrough`). */
  autoPassthroughHosts?: AutoPassthroughHosts;
}

/**
 * Makes a client refusing Detour's certificate visible, and — with auto TLS
 * passthrough on — survivable.
 *
 * Without this, a refused handshake left nothing in the log table and no
 * hostname anywhere (it fails before any request exists), so an app that
 * doesn't trust user-installed CAs just looked broken. Now the refusal shows
 * up as a CONNECT row for the host it asked for (its SNI), saying why, and
 * the host is recorded so later CONNECTs to it are relayed as raw TLS
 * (`connectHandler.ts`) — the app keeps working through the proxy, as it
 * would through a proxy that doesn't MITM that host, just without
 * decryption. The first connection is still lost: the client already
 * rejected it.
 *
 * With auto passthrough on, only the first refusal per host makes a row —
 * the ones racing it on other connections say nothing new, and later
 * connections are passthrough rows of their own. With it off, every refusal
 * does, since each is a connection that failed.
 */
export function createClientCertRejectionHandler(deps: ClientCertRejectionDeps): OnTlsClientErrorParams {
  const { eventBus, autoPassthroughHosts } = deps;
  return function handleTlsClientError(err, servername) {
    const alert = clientCertRejectionAlert(err);
    if (!alert || !servername) return;
    const host = servername.toLowerCase();
    if (autoPassthroughHosts && !autoPassthroughHosts.add(host)) return;

    const why = `the client refused Detour's certificate for ${host} (TLS alert: ${alert}) — it doesn't trust the Detour CA (e.g. an Android 7+ app that ignores user-installed CAs) or pins its own certificate`;
    const what = autoPassthroughHosts
      ? `later connections to ${host} are relayed untouched (auto TLS passthrough) so it keeps working, without decryption`
      : `relay it untouched instead with auto TLS passthrough (on unless --no-auto-passthrough), Intercept Off or Focus`;
    const message = `${why}; ${what}`;

    const now = Date.now();
    const exchange: CapturedExchange = {
      id: crypto.randomUUID(),
      method: 'CONNECT',
      url: connectMatchUrl(host, 443),
      host,
      isSSL: true,
      protocol: 'HTTP/1.1',
      requestHeaders: {},
      requestBodySize: 0,
      responseBodySize: 0,
      startedAt: now,
    };
    eventBus.emit('request', exchange);
    eventBus.emit('response', { ...exchange, finishedAt: now, durationMs: 0, error: message });
    eventBus.emit('error', { errorKind: 'CLIENT_REJECTED_CERTIFICATE', message });
  };
}
