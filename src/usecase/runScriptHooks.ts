import {
  applyScriptRequestResult,
  applyScriptResponseResult,
  type ScriptModule,
  type ScriptRequestInfo,
  type ScriptResponseInfo,
} from '../domain/rules/scriptAction';

/**
 * Runs a `script` rule's `beforeRequest` hook (if the module defines one)
 * and applies whatever partial changes it returns — see
 * `applyScriptRequestResult` for the merge semantics. A module with no
 * `beforeRequest` hook leaves the request untouched. A hook that throws (or
 * whose returned promise rejects) propagates that error to the caller —
 * deciding what happens to the exchange when that happens is
 * Infrastructure's job (see infra/proxy/proxyServer.ts's
 * `handleScriptRequestHook`).
 */
export async function runBeforeRequest(module: ScriptModule, req: ScriptRequestInfo): Promise<ScriptRequestInfo> {
  if (!module.beforeRequest) return req;
  const result = await module.beforeRequest({ ...req, headers: { ...req.headers } });
  return applyScriptRequestResult(req, result ?? undefined);
}

/** Same as `runBeforeRequest`, for the `beforeResponse` hook. */
export async function runBeforeResponse(
  module: ScriptModule,
  req: ScriptRequestInfo,
  res: ScriptResponseInfo,
): Promise<ScriptResponseInfo> {
  if (!module.beforeResponse) return res;
  const result = await module.beforeResponse(
    { ...req, headers: { ...req.headers } },
    { ...res, headers: { ...res.headers } },
  );
  return applyScriptResponseResult(res, result ?? undefined);
}
