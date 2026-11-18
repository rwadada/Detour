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
  /**
   * Refusals already logged that weren't recorded for passthrough (it's off,
   * or the record is full), so a client retrying the same target doesn't add a
   * row per attempt. The owner clears it together with `autoPassthroughHosts`;
   * omitted, the handler keeps its own.
   */
  loggedRefusals?: AutoPassthroughHosts;
}

type Outcome = 'passthrough' | 'focused' | 'full' | 'off' | 'untracked';

/** How to relay a host untouched by hand. Focus is the list of hosts that *are* MITM'd, so it helps only by leaving this one out. */
const RELAY_HINT = 'to relay it untouched, turn Intercept off or set Focus to other hosts only';

/** What happens next for a refusing target, worded for the row's error text. */
function describeOutcome(outcome: Outcome, hostPort: string): string {
  switch (outcome) {
    case 'passthrough':
      return `for the next ${AUTO_PASSTHROUGH_TTL_MINUTES} minutes, connections from this client address to ${hostPort} are relayed untouched (auto TLS passthrough) so it keeps working, without decryption — toggle Intercept off and on to MITM it again sooner`;
    case 'focused':
      return `${hostPort} is in Focus, so it stays MITM'd rather than being relayed untouched`;
    case 'full':
      return `auto TLS passthrough already remembers its maximum number of hosts, so ${hostPort} stays MITM'd; ${RELAY_HINT}`;
    case 'off':
      return `auto TLS passthrough is off (--auto-passthrough, or \`detour config --auto-passthrough on\`, turns it on); ${RELAY_HINT}`;
    case 'untracked':
      return `the connection it came through could no longer be told, so it stays MITM'd; ${RELAY_HINT}`;
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
 * Refusals that can't be passed through (Focus, the cap, an unknown tunnel)
 * get a row every time: each is a failed connection.
 */
export function createClientCertRejectionHandler(deps: ClientCertRejectionDeps): OnTlsClientErrorParams {
  const { eventBus, runtimeState, autoPassthroughHosts } = deps;
  const loggedRefusals = deps.loggedRefusals ?? createAutoPassthroughHosts();
  /** Whether this refusal (not recorded for passthrough) was already logged; records it if not. A full set stops deduplicating rather than swallowing a refusal. */
  const alreadyLogged = (tunnel: MitmTunnelInfo | undefined): boolean => {
    if (!tunnel) return false;
    if (loggedRefusals.has(tunnel)) return true;
    loggedRefusals.add(tunnel);
    return false;
  };
  return function handleTlsClientError(err, { servername, tunnel }) {
    const alert = clientCertRejectionAlert(err);
    if (!alert) return;
    const target: MitmTunnelInfo | undefined =
      tunnel ?? (servername ? { host: servername, port: 443, clientAddress: undefined } : undefined);
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
      if (alreadyLogged(tunnel)) return;
      outcome = 'off';
    } else if (isHostExplicitlyFocused(runtimeState.getSnapshot().focusHosts, hostPort)) outcome = 'focused';
    // Without a client address there's no client to scope the record to, and
    // every such connection would share one key.
    else if (!tunnel?.clientAddress) outcome = 'untracked';
    else if (autoPassthroughHosts.has(tunnel)) return;
    else if (autoPassthroughHosts.add(tunnel)) outcome = 'passthrough';
    else {
      if (alreadyLogged(tunnel)) return;
      outcome = 'full';
    }

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
