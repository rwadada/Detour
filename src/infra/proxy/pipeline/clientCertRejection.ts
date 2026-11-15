import crypto from 'node:crypto';
import {
  AUTO_PASSTHROUGH_TTL_MS,
  type AutoPassthroughHosts,
  clientCertRejectionAlert,
} from '../../../domain/autoPassthrough/clientCertRejection';
import type { CapturedExchange } from '../../../domain/exchange/types';
import { connectMatchUrl, formatHostPort, isHostFocused } from '../../../domain/focus/focusPolicy';
import type { ProxyRuntimeState } from '../../../usecase/proxyRuntimeState';
import type { DetourEventBus } from '../../eventBus';
import type { MitmTunnelInfo, OnTlsClientErrorParams } from '../engine/types';

export interface ClientCertRejectionDeps {
  eventBus: DetourEventBus;
  runtimeState: ProxyRuntimeState;
  /** Where refusals are recorded for auto TLS passthrough; omitted when that's turned off (`--no-auto-passthrough`). */
  autoPassthroughHosts?: AutoPassthroughHosts;
}

/**
 * Whether a host was explicitly put in Focus. An empty Focus list means "no
 * restriction" (`isHostFocused` is then true for everything), which is not a
 * request to intercept this host in particular.
 */
function isExplicitlyFocused(runtimeState: ProxyRuntimeState, hostPort: string): boolean {
  const { focusHosts } = runtimeState.getSnapshot();
  return focusHosts.length > 0 && isHostFocused(focusHosts, hostPort);
}

/** What happens next for a refusing target, worded for the row's error text. */
function describeOutcome(outcome: 'passthrough' | 'focused' | 'full' | 'off' | 'untracked', hostPort: string): string {
  const minutes = Math.round(AUTO_PASSTHROUGH_TTL_MS / 60_000);
  switch (outcome) {
    case 'passthrough':
      return `for the next ${minutes} minutes, connections from this client to ${hostPort} are relayed untouched (auto TLS passthrough) so it keeps working, without decryption`;
    case 'focused':
      return `${hostPort} is in Focus, so it stays MITM'd rather than being relayed untouched`;
    case 'full':
      return `auto TLS passthrough already remembers its maximum number of hosts, so ${hostPort} stays MITM'd; use Intercept Off or Focus to relay it`;
    case 'off':
      return 'relay it untouched instead with auto TLS passthrough (on unless --no-auto-passthrough), Intercept Off or Focus';
    case 'untracked':
      return "the connection it came through could no longer be told, so it stays MITM'd; use Intercept Off or Focus to relay it";
  }
}

/**
 * Makes a client refusing Detour's certificate visible, and — with auto TLS
 * passthrough on — survivable.
 *
 * Without this, a refused handshake left nothing in the log table and no
 * hostname anywhere (it fails before any request exists), so an app that
 * doesn't trust user-installed CAs just looked broken. Now the refusal shows
 * up as a CONNECT row for the target it came through, saying why, and the
 * target is recorded so that client's later CONNECTs to it are relayed as
 * raw TLS for a while (`connectHandler.ts`) — the app keeps working through
 * the proxy, as it would through a proxy that doesn't MITM that host, just
 * without decryption. The first connection is still lost: the client already
 * rejected it.
 *
 * Only a refusal by TLS alert counts (see `clientCertRejectionAlert`). An app
 * that checks its pins only after the handshake succeeds (OkHttp's
 * `CertificatePinner`) completes the handshake and then hangs up, which
 * looks like nothing here.
 *
 * With auto passthrough on, only the first refusal per target makes a row —
 * the ones racing it on other connections say nothing new, and later
 * connections are passthrough rows of their own. With it off, every refusal
 * does, since each is a connection that failed.
 */
export function createClientCertRejectionHandler(deps: ClientCertRejectionDeps): OnTlsClientErrorParams {
  const { eventBus, runtimeState, autoPassthroughHosts } = deps;
  return function handleTlsClientError(err, { servername, tunnel }) {
    const alert = clientCertRejectionAlert(err);
    if (!alert) return;
    const target: MitmTunnelInfo | undefined =
      tunnel ?? (servername ? { host: servername, port: 443, clientAddress: undefined } : undefined);
    if (!target) return;
    const hostPort = formatHostPort(target.host.toLowerCase(), target.port, 443);

    let outcome: Parameters<typeof describeOutcome>[0];
    if (!autoPassthroughHosts) outcome = 'off';
    else if (!tunnel) outcome = 'untracked';
    else if (autoPassthroughHosts.has(tunnel)) return;
    else if (isExplicitlyFocused(runtimeState, hostPort)) outcome = 'focused';
    else outcome = autoPassthroughHosts.add(tunnel) ? 'passthrough' : 'full';

    const sni = servername && servername.toLowerCase() !== target.host.toLowerCase() ? ` (SNI ${servername})` : '';
    const message = `the client refused Detour's certificate for ${hostPort}${sni} (TLS alert: ${alert}) — it doesn't trust the Detour CA (e.g. an Android 7+ app that ignores user-installed CAs) or pins its own certificate; ${describeOutcome(outcome, hostPort)}`;

    const now = Date.now();
    const exchange: CapturedExchange = {
      id: crypto.randomUUID(),
      method: 'CONNECT',
      url: connectMatchUrl(target.host.toLowerCase(), target.port),
      host: hostPort,
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
