import type { RouteAction } from './types';

export interface RouteTarget {
  host: string;
  port?: number;
  /** Set only when the Host header should be overwritten (`preserveHostHeader === false`). */
  hostHeader?: string;
}

/**
 * Decides the outbound host/port (and, if requested, the Host header
 * override) for a `route` action. Pure — applying it to a live connection
 * (an `http-mitm-proxy` `IContext`, or a raw CONNECT tunnel) is
 * Infrastructure's job.
 */
export function computeRouteTarget(
  action: RouteAction,
  current: { port: string | number | null | undefined; isSSL: boolean },
): RouteTarget {
  const target: RouteTarget = { host: action.host, port: action.port };
  if (action.preserveHostHeader === false) {
    const defaultPort = current.isSSL ? 443 : 80;
    const port = action.port ?? current.port;
    const portSuffix = port && Number(port) !== defaultPort ? `:${port}` : '';
    target.hostHeader = `${action.host}${portSuffix}`;
  }
  return target;
}
