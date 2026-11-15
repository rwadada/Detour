import crypto from 'node:crypto';
import {
  AUTO_PASSTHROUGH_TTL_MINUTES,
  type AutoPassthroughHosts,
  clientCertRejectionAlert,
  createAutoPassthroughHosts,
} from '../../../domain/autoPassthrough/clientCertRejection';
import type { CapturedExchange } from '../../../domain/exchange/types';
import { connectMatchUrl, formatHostPort, isHostExplicitlyFocused } from '../../../domain/focus/focusPolicy';
import type { ProxyRuntimeState } from '../../../usecase/proxyRuntimeState';
import type { DetourEventBus } from '../../eventBus';
import type { MitmTunnelInfo, OnTlsClientErrorParams } from '../engine/types';

export interface ClientCertRejectionDeps {
  eventBus: DetourEventBus;
  runtimeState: ProxyRuntimeState;
  /** Where refusals are recorded for auto TLS passthrough; omitted when that's turned off (`--no-auto-passthrough`). */
  autoPassthroughHosts?: AutoPassthroughHosts;
}

type Outcome = 'passthrough' | 'focused' | 'full' | 'off' | 'untracked' | 'unrelayable';

/** What happens next for a refusing target, worded for the row's error text. */
function describeOutcome(outcome: Outcome, hostPort: string): string {
  switch (outcome) {
    case 'passthrough':
      return `for the next ${AUTO_PASSTHROUGH_TTL_MINUTES} minutes, connections from this client address to ${hostPort} are relayed untouched (auto TLS passthrough) so it keeps working, without decryption — toggle Intercept off and on to MITM it again sooner`;
    case 'unrelayable':
      return "its CONNECT's Host header names another target than the CONNECT itself, so it can't be relayed untouched to the one refused and stays MITM'd";
    case 'focused':
      return `${hostPort} is in Focus, so it stays MITM'd rather than being relayed untouched`;
    case 'full':
      return `auto TLS passthrough already remembers its maximum number of hosts, so ${hostPort} stays MITM'd; use Intercept Off or Focus to relay it`;
    case 'off':
      return 'auto TLS passthrough is off (--auto-passthrough, or `detour config --auto-passthrough on`, turns it on); Intercept Off or Focus can relay it untouched meanwhile';
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
 * Only the first refusal per target within the TTL makes a row — the ones
 * racing it on other connections say nothing new, and later connections are
 * passthrough rows of their own. With passthrough off, a client retrying a
 * host it will never accept would otherwise flood the log the same way.
 * Refusals that can't be passed through (Focus, the cap, an unknown or
 * Host-mismatched tunnel) get a row every time: each is a failed connection.
 */
export function createClientCertRejectionHandler(deps: ClientCertRejectionDeps): OnTlsClientErrorParams {
  const { eventBus, runtimeState, autoPassthroughHosts } = deps;
  // With passthrough off, refusals already logged within the TTL, so a
  // retrying client doesn't add a row per attempt.
  const loggedWhileOff = autoPassthroughHosts ? undefined : createAutoPassthroughHosts();
  return function handleTlsClientError(err, { servername, tunnel }) {
    const alert = clientCertRejectionAlert(err);
    if (!alert) return;
    const target: MitmTunnelInfo | undefined =
      tunnel ?? (servername ? { host: servername, port: 443, clientAddress: undefined, relayable: false } : undefined);
    if (!target) {
      // Nothing names the host (no SNI, and the tunnel is gone): no row to
      // attach it to, but the refusal itself still gets reported.
      eventBus.emit('error', {
        errorKind: 'CLIENT_REJECTED_CERTIFICATE',
        message: `a client refused Detour's certificate (TLS alert: ${alert}) for a host it didn't name`,
      });
      return;
    }
    const hostPort = formatHostPort(target.host.toLowerCase(), target.port, 443);

    // Focus comes first: connectHandler MITMs an explicitly focused host even
    // while it's recorded, so each of its refusals is news and gets a row.
    let outcome: Outcome;
    if (!autoPassthroughHosts) {
      if (tunnel && !loggedWhileOff?.add(tunnel)) return;
      outcome = 'off';
    } else if (isHostExplicitlyFocused(runtimeState.getSnapshot().focusHosts, hostPort)) outcome = 'focused';
    else if (!tunnel) outcome = 'untracked';
    else if (!tunnel.relayable) outcome = 'unrelayable';
    else if (autoPassthroughHosts.has(tunnel)) return;
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
      // Never parsed as HTTP, like a passthrough tunnel: the dashboard shows
      // the error instead of an empty HTTP inspector with Replay/Edit & Send.
      passthrough: true,
    };
    eventBus.emit('request', exchange);
    eventBus.emit('response', { ...exchange, finishedAt: now, durationMs: 0, error: message });
    eventBus.emit('error', { errorKind: 'CLIENT_REJECTED_CERTIFICATE', message });
  };
}
