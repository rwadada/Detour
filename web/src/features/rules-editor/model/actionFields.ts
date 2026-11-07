import type { BodyReplace, BodyRewrite, HeaderRewrite, PathRewrite, QueryRewrite, RuleAction } from '@/shared/api';
import { headersToEditableText, parseEditableHeaders } from '@/shared/lib/utils';

export const ACTION_TYPES: readonly RuleAction['type'][] = ['mock', 'route', 'rewrite', 'breakpoint', 'script'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A fresh action of the given type, with sensible defaults — used both as `blankRule()`'s starter action and when the editor's Type selector switches a rule to a different action type (the previous action's fields don't carry over; the shapes are too different to guess a mapping). */
export function blankAction(type: RuleAction['type']): RuleAction {
  switch (type) {
    case 'mock':
      return { type: 'mock', status: 200 };
    case 'route':
      return { type: 'route', host: '' };
    case 'rewrite':
      return { type: 'rewrite' };
    case 'breakpoint':
      return { type: 'breakpoint' };
    case 'script':
      return { type: 'script', path: '' };
  }
}

/** Renders a `HeaderRewrite`/`QueryRewrite`'s `set` map as `Name: value` lines — reuses the same convention the breakpoint editor's headers textarea already uses. */
export function setMapToText(map: Record<string, string> | undefined): string {
  return headersToEditableText(map ?? {});
}

/** The inverse of `setMapToText`. Returns `undefined` (rather than `{}`) when empty, so an untouched field doesn't add a no-op `set: {}` to the saved rule. */
export function textToSetMap(text: string): Record<string, string> | undefined {
  const map = parseEditableHeaders(text);
  return Object.keys(map).length > 0 ? map : undefined;
}

/** Renders a `remove` name list as a comma-separated line, matching the Method field's own convention. */
export function removeListToText(list: string[] | undefined): string {
  return (list ?? []).join(', ');
}

/** The inverse of `removeListToText`. Returns `undefined` (not `[]`) when empty. */
export function textToRemoveList(text: string): string[] | undefined {
  const list = text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

/** True when a `HeaderRewrite`/`QueryRewrite` has neither `set` nor `remove` entries — used to omit an empty `{}` from the saved action rather than a no-op object. */
export function isEmptySetRemove(value: HeaderRewrite | QueryRewrite | undefined): boolean {
  const noSet = !value?.set || Object.keys(value.set).length === 0;
  const noRemove = !value?.remove || value.remove.length === 0;
  return noSet && noRemove;
}

/**
 * Parses a body editor's free-text value the same way `MockAction.body`/
 * `BodyRewrite.set`/`.merge` accept either shape: valid JSON becomes the
 * parsed value (object/array/number/etc.), anything else is kept as a
 * plain string. Blank input is `undefined` (field untouched).
 */
export function parseBodyValue(text: string): unknown {
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The inverse of `parseBodyValue`, for seeding the editor from an already-saved action. */
export function bodyValueToText(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

/** `JsonBodyField`'s (ActionFields.tsx) status caption plus what a "Format" click would reformat to — pulled out here, alongside `parseBodyValue` itself, so the exact same "does this actually parse" question that field asks about has one pure, tested answer instead of the component re-deriving it inline. */
export interface JsonBodyStatus {
  /**
   * Whether `JSON.parse` succeeds on `text` (blank doesn't count) — this is
   * exactly the condition `parseBodyValue` itself branches on. Note this
   * isn't quite "will be saved as something other than a string": a
   * quoted JSON string literal (`"hello"`) is itself valid JSON and still
   * parses to a plain string (unquoted) — `validJson` only tells you
   * whether `text` was interpreted *as JSON* at all, not what type the
   * result happens to be.
   */
  validJson: boolean;
  /** The parsed value, present only when `validJson` is true. */
  parsed?: unknown;
  /** A short caption for display next to the editor. */
  status: string;
}

export function describeJsonBodyText(text: string): JsonBodyStatus {
  const trimmed = text.trim();
  if (trimmed === '') return { validJson: false, status: 'Empty' };
  try {
    return { validJson: true, parsed: JSON.parse(trimmed), status: '✓ Valid JSON' };
  } catch {
    return { validJson: false, status: 'Not valid JSON — will be sent as a literal string, as-is' };
  }
}

export interface JsonMergeStatus extends JsonBodyStatus {
  /** True when `text` is non-empty and does not parse to a plain JSON object (`{ ... }`), so saving would fail schema validation (`merge` must be an object per RFC 7396). */
  invalidMerge: boolean;
}

/**
 * Parses `BodyRewrite.merge`'s editor text (issue #282). Unlike `MockAction.body`
 * and `BodyRewrite.set` (`parseBodyValue`), `merge` is an RFC 7396 JSON Merge
 * Patch and the server schema requires a plain JSON object (`{ ... }`) —
 * falling back to a literal string on invalid JSON (or accepting an array/
 * primitive) produced a draft that failed validation on save. Returns
 * `undefined` when blank or invalid; callers pair this with
 * `describeJsonMergeText` to surface an inline error and block saving while
 * `invalidMerge` is true.
 */
export function parseMergeValue(text: string): Record<string, unknown> | undefined {
  if (text.trim() === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Status caption and validity check for `BodyRewrite.merge` (see `parseMergeValue`). */
export function describeJsonMergeText(text: string): JsonMergeStatus {
  const trimmed = text.trim();
  if (trimmed === '') return { validJson: false, invalidMerge: false, status: 'Empty' };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!isPlainObject(parsed)) {
      return {
        validJson: true,
        invalidMerge: true,
        parsed,
        status: 'Merge patch must be a JSON object (e.g. {"key": "value"}).',
      };
    }
    return { validJson: true, invalidMerge: false, parsed, status: '✓ Valid JSON object' };
  } catch {
    return {
      validJson: false,
      invalidMerge: true,
      status: 'Invalid JSON — merge patch must be a valid JSON object.',
    };
  }
}

export type ParsedActionJson = { ok: true; action: RuleAction } | { ok: false; error: string };

/**
 * Parses and validates the raw JSON text from `JsonActionField` ("Edit as
 * JSON", issue #282). Rejects both syntax errors and valid JSON that isn't a
 * `RuleAction` object with a recognized `type` — previously `JSON.parse("null")`
 * or a pasted response body (`{"id": 1}`, no `type`) was committed straight
 * into `rule.action`, crashing `rule.action.type` reads or leaving `ActionFields`
 * blank on switching back to form mode.
 */
export function parseActionJson(text: string): ParsedActionJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Invalid JSON — fix syntax errors before saving.' };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, error: 'Action JSON must be a JSON object.' };
  }
  if (typeof parsed.type !== 'string' || !ACTION_TYPES.includes(parsed.type as RuleAction['type'])) {
    return {
      ok: false,
      error: 'Action JSON must have a valid "type" ("mock", "route", "rewrite", "breakpoint", or "script").',
    };
  }
  return { ok: true, action: parsed as unknown as RuleAction };
}

/**
 * `set` wins outright and skips the rest (mutually exclusive with the
 * other two, per `BodyRewrite`'s own doc comment) — but `replace` and
 * `merge` compose (`replace` runs first, then `merge` applies to the
 * result), so the editor treats them as one combined "transform" mode
 * rather than two separate ones. Modeling them as mutually exclusive here
 * would silently drop whichever one the form doesn't show the moment the
 * user edits the other.
 */
export type BodyRewriteMode = 'none' | 'set' | 'transform';

/** Which of `BodyRewrite`'s shapes a value currently uses, for seeding the mode selector. */
export function bodyRewriteMode(body: BodyRewrite | undefined): BodyRewriteMode {
  if (!body) return 'none';
  if (body.set !== undefined) return 'set';
  if ((body.replace && body.replace.length > 0) || body.merge !== undefined) return 'transform';
  return 'none';
}

/** A blank row for a `replace` list's find/replacement editor. */
export function blankBodyReplace(): BodyReplace {
  return { find: '', replacement: '' };
}

/**
 * `PathRewrite` has no `merge` (unlike `BodyRewrite`) — `set` and `replace`
 * are the only two shapes, and `set` still wins outright per its own doc
 * comment, so this only ever needs two non-`'none'` modes rather than
 * `BodyRewriteMode`'s three.
 */
export type PathRewriteMode = 'none' | 'set' | 'replace';

/** Which of `PathRewrite`'s shapes a value currently uses, for seeding the mode selector. */
export function pathRewriteMode(path: PathRewrite | undefined): PathRewriteMode {
  if (!path) return 'none';
  if (path.set !== undefined) return 'set';
  if (path.replace && path.replace.length > 0) return 'replace';
  return 'none';
}

/** Parses a number field's text, treating blank as "unset" rather than `NaN`/`0` — e.g. a delay/port/status input the user cleared out. */
export function parseOptionalInt(text: string): number | undefined {
  if (text.trim() === '') return undefined;
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) ? n : undefined;
}
