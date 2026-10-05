import type { DashboardClientMessage } from './protocol';

/**
 * Runtime validation of what a browser sends over the dashboard's `/ws`
 * (issue #209). The wire type used to be a bare `JSON.parse(...) as
 * DashboardClientMessage` cast, so a malformed `setThrottle` (say) reached the
 * proxy as-is. The socket is a trust boundary — over `--lan` any device that
 * got past the password can write to it — so each message's own shape is
 * checked before anything acts on it.
 *
 * `VALIDATORS` is keyed by every `DashboardClientMessage['type']`, so adding a
 * message to the union without a validator fails to compile.
 *
 * Depth: the fields the server reads directly are checked. Large nested
 * payloads that a downstream owner already validates in full (the `rules`
 * array in `setRules`, which `RuleEngine.write` runs through its schema; the
 * edits object of a `breakpointResume`) are only checked to be the right
 * kind of value here.
 */

type Json = Record<string, unknown>;
/** A message-specific check: `null` when valid, else a short reason. */
type Validator = (m: Json) => string | null;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);
const isStringRecord = (v: unknown): boolean => isObject(v) && Object.values(v).every(isString);

/** Returns the first failing `[condition, reason]`'s reason, or `null`. */
function check(...rules: Array<[boolean, string]>): string | null {
  for (const [ok, reason] of rules) if (!ok) return reason;
  return null;
}

const MAX_NAME_LENGTH = 256;

function validateThrottle(state: unknown): string | null {
  if (!isObject(state)) return 'state must be an object';
  return check(
    [typeof state.enabled === 'boolean', 'state.enabled must be a boolean'],
    [isNumber(state.downKbps), 'state.downKbps must be a number'],
    [isNumber(state.upKbps), 'state.upKbps must be a number'],
    [isNumber(state.latencyMs), 'state.latencyMs must be a number'],
    [isNumber(state.packetLossPct), 'state.packetLossPct must be a number'],
  );
}

function validateBlockHosts(state: unknown): string | null {
  if (!isObject(state)) return 'state must be an object';
  return check(
    [isStringArray(state.hosts), 'state.hosts must be an array of strings'],
    [state.mode === 'forbidden' || state.mode === 'reset', "state.mode must be 'forbidden' or 'reset'"],
  );
}

function validateBreakpointResume(command: unknown): string | null {
  if (!isObject(command)) return 'command must be an object';
  const { edits } = command;
  return check(
    [isString(command.id), 'command.id must be a string'],
    [command.phase === 'request' || command.phase === 'response', "command.phase must be 'request' or 'response'"],
    [command.action === 'resume' || command.action === 'abort', "command.action must be 'resume' or 'abort'"],
    [edits === undefined || isObject(edits), 'command.edits must be an object'],
    [
      !isObject(edits) || edits.headers === undefined || isStringRecord(edits.headers),
      'command.edits.headers must map strings to strings',
    ],
    [!isObject(edits) || edits.body === undefined || isString(edits.body), 'command.edits.body must be a string'],
  );
}

function validateReplay(m: Json): string | null {
  const ex = m.exchange;
  if (!isObject(ex)) return 'exchange must be an object';
  return check(
    [isString(ex.method), 'exchange.method must be a string'],
    [isString(ex.url), 'exchange.url must be a string'],
    [isString(ex.host), 'exchange.host must be a string'],
    [typeof ex.isSSL === 'boolean', 'exchange.isSSL must be a boolean'],
    [isStringRecord(ex.requestHeaders), 'exchange.requestHeaders must map strings to strings'],
    [ex.requestBody === undefined || isString(ex.requestBody), 'exchange.requestBody must be a string'],
  );
}

function validateHistoryQuery(m: Json): string | null {
  const q = m.query;
  if (!isObject(q)) return 'query must be an object';
  const optionalString = (v: unknown) => v === undefined || isString(v);
  const optionalNumber = (v: unknown) => v === undefined || isNumber(v);
  return check(
    [isString(m.requestId), 'requestId must be a string'],
    [isNumber(q.limit), 'query.limit must be a number'],
    [optionalNumber(q.before), 'query.before must be a number'],
    [optionalString(q.beforeId), 'query.beforeId must be a string'],
    [optionalString(q.method), 'query.method must be a string'],
    [optionalString(q.host), 'query.host must be a string'],
    [optionalString(q.urlContains), 'query.urlContains must be a string'],
    [optionalNumber(q.statusMin), 'query.statusMin must be a number'],
    [optionalNumber(q.statusMax), 'query.statusMax must be a number'],
  );
}

const validName = (v: unknown): boolean => isString(v) && v.length <= MAX_NAME_LENGTH;

const VALIDATORS: { [T in DashboardClientMessage['type']]: Validator } = {
  login: (m) => check([isString(m.password), 'password must be a string']),
  breakpointResume: (m) => validateBreakpointResume(m.command),
  setIntercept: (m) => check([typeof m.enabled === 'boolean', 'enabled must be a boolean']),
  setFocus: (m) => check([isStringArray(m.hosts), 'hosts must be an array of strings']),
  setThrottle: (m) => validateThrottle(m.state),
  setBlockHosts: (m) => validateBlockHosts(m.state),
  setRules: (m) =>
    check([isObject(m.data) && Array.isArray(m.data.rules), 'data must be an object with a rules array']),
  createRuleProfile: (m) =>
    check(
      [validName(m.name), 'name must be a string'],
      [m.template === 'blank' || m.template === 'sample', "template must be 'blank' or 'sample'"],
    ),
  saveActiveRulesAsProfile: (m) => check([validName(m.name), 'name must be a string']),
  applyRuleProfile: (m) => check([validName(m.name), 'name must be a string']),
  replay: validateReplay,
  // The fields themselves are validated (and reported as USER_CONFIG_WRITE_ERROR) by `writeUserConfig`.
  setUserConfig: (m) => check([isObject(m.state), 'state must be an object']),
  setDashboardPassword: (m) =>
    check([m.password === null || isString(m.password), 'password must be a string or null']),
  queryHistory: validateHistoryQuery,
  startUpdate: () => null,
  checkUpdate: () => null,
};

export type ParsedClientMessage = { ok: true; message: DashboardClientMessage } | { ok: false; reason: string };

/** Parses and validates one raw `/ws` frame from a browser. Never throws. */
export function parseClientMessage(raw: string): ParsedClientMessage {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'not valid JSON' };
  }
  if (!isObject(value)) return { ok: false, reason: 'not a JSON object' };
  const type = value.type;
  if (!isString(type) || !Object.hasOwn(VALIDATORS, type)) {
    return { ok: false, reason: `unknown message type ${JSON.stringify(type)}` };
  }
  const problem = VALIDATORS[type as DashboardClientMessage['type']](value);
  if (problem) return { ok: false, reason: `${type}: ${problem}` };
  return { ok: true, message: value as unknown as DashboardClientMessage };
}
