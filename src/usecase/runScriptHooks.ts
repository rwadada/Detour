import {
  applyScriptRequestResult,
  applyScriptResponseResult,
  type ScriptModule,
  type ScriptRequestInfo,
  type ScriptResponseInfo,
} from '../domain/rules/scriptAction';

/** `--script-timeout-ms`'s default (issue #161) when the flag isn't passed. */
export const DEFAULT_SCRIPT_TIMEOUT_MS = 5000;

/**
 * Thrown when a `script` hook doesn't settle within its timeout. Both call
 * sites already treat a rejected `runBeforeRequest`/`runBeforeResponse` as
 * "log the error, forward the exchange untouched" (see
 * `infra/proxy/pipeline/scriptRequestHook.ts`/`scriptResponseHook.ts`'s
 * `.catch` handlers), so this reuses that existing fallback path rather
 * than needing one of its own.
 */
export class ScriptTimeoutError extends Error {
  constructor(hook: 'beforeRequest' | 'beforeResponse', timeoutMs: number) {
    super(`${hook} did not complete within ${timeoutMs}ms`);
    this.name = 'ScriptTimeoutError';
  }
}

/**
 * Races `value` (a hook's return value — a `ScriptModule` hook may return
 * its result either directly or as a `Promise`, so this always wraps it in
 * one via `Promise.resolve` first) against `timeoutMs`, rejecting with
 * `ScriptTimeoutError` if it fires first. Deliberately does not cancel or
 * otherwise stop whatever the hook itself is doing (there's no general way
 * to abort arbitrary user JS) — a slow/hung hook keeps running in the
 * background, but its own exchange stops waiting on it (issue #161).
 */
function withTimeout<T>(
  value: T | Promise<T>,
  hook: 'beforeRequest' | 'beforeResponse',
  timeoutMs: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ScriptTimeoutError(hook, timeoutMs)), timeoutMs);
    // `.unref()`: an in-flight hook that outlives the timeout (and therefore
    // this timer, since it's not cleared until the *original* promise also
    // settles) must never be the reason the process stays alive — matches
    // how every other transient/background timer in this codebase behaves.
    timer.unref();
    Promise.resolve(value).then(
      (resolved) => {
        clearTimeout(timer);
        resolve(resolved);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Runs a `script` rule's `beforeRequest` hook (if the module defines one)
 * and applies whatever partial changes it returns — see
 * `applyScriptRequestResult` for the merge semantics. A module with no
 * `beforeRequest` hook leaves the request untouched. A hook that throws (or
 * whose returned promise rejects, including from `timeoutMs` running out —
 * see `withTimeout`) propagates that error to the caller — deciding what
 * happens to the exchange when that happens is Infrastructure's job (see
 * infra/proxy/proxyServer.ts's `handleScriptRequestHook`).
 */
export async function runBeforeRequest(
  module: ScriptModule,
  req: ScriptRequestInfo,
  timeoutMs: number = DEFAULT_SCRIPT_TIMEOUT_MS,
): Promise<ScriptRequestInfo> {
  if (!module.beforeRequest) return req;
  const result = await withTimeout(
    module.beforeRequest({ ...req, headers: { ...req.headers } }),
    'beforeRequest',
    timeoutMs,
  );
  return applyScriptRequestResult(req, result ?? undefined);
}

/** Same as `runBeforeRequest`, for the `beforeResponse` hook. */
export async function runBeforeResponse(
  module: ScriptModule,
  req: ScriptRequestInfo,
  res: ScriptResponseInfo,
  timeoutMs: number = DEFAULT_SCRIPT_TIMEOUT_MS,
): Promise<ScriptResponseInfo> {
  if (!module.beforeResponse) return res;
  const result = await withTimeout(
    module.beforeResponse({ ...req, headers: { ...req.headers } }, { ...res, headers: { ...res.headers } }),
    'beforeResponse',
    timeoutMs,
  );
  return applyScriptResponseResult(res, result ?? undefined);
}
