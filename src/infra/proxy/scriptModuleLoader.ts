import type { ScriptModule } from '../../domain/rules/scriptAction';
import type { Rule } from '../../domain/rules/types';
import { loadScriptModule, resolveMockResponse, type MockResponse } from './actionsRuntime';

/**
 * Resolves a `mock` rule's response, falling back to a 500 describing the
 * failure (e.g. an unreadable `bodyFile`) rather than crashing the proxy
 * or silently passing the request through.
 */
export function tryResolveMock(
  rule: Rule,
  basePath: string,
  allowExternalPaths: boolean,
  onError: (message: string) => void,
): MockResponse {
  try {
    return resolveMockResponse(rule.action as Extract<Rule['action'], { type: 'mock' }>, basePath, allowExternalPaths);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onError(message);
    return {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: Buffer.from(`detour: mock rule "${rule.name}" failed to build its response: ${message}`, 'utf8'),
    };
  }
}

/**
 * Loads a `script` rule's module, reporting (via `onError`) rather than
 * throwing if the file is missing/unreadable/malformed — a broken script
 * shouldn't take down the proxy, just fall back to forwarding the exchange
 * untouched (same philosophy as `tryResolveMock`'s 500 fallback, minus the
 * mock response since a script rule has no response of its own to fall
 * back to).
 */
export function tryLoadScriptModule(
  rule: Rule,
  basePath: string,
  allowExternalPaths: boolean,
  onError: (message: string) => void,
): ScriptModule | undefined {
  const action = rule.action as Extract<Rule['action'], { type: 'script' }>;
  try {
    return loadScriptModule(action, basePath, allowExternalPaths);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onError(`rule "${rule.name}": failed to load script "${action.path}": ${message}`);
    return undefined;
  }
}
