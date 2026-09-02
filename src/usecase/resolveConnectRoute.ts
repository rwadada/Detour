import { connectMatchUrl } from '../domain/focus/focusPolicy';
import type { RouteAction } from '../domain/rules/types';
import type { RuleEngine } from './ruleEngine';

/**
 * Resolves a `route` rule's redirect target for a CONNECT tunnel while
 * intercept is off for it (globally, or for this host via Focus) — the only
 * rule type that still applies in that case, matched on host/port only
 * since the tunnel is never decrypted (see
 * infra/proxy/proxyServer.ts's `handleInterceptOffConnect`).
 */
export function resolveConnectRoute(
  ruleEngine: RuleEngine | undefined,
  host: string,
  port: number,
): RouteAction | undefined {
  const rule = ruleEngine?.match({ method: 'CONNECT', url: connectMatchUrl(host, port) });
  return rule?.action.type === 'route' ? rule.action : undefined;
}
