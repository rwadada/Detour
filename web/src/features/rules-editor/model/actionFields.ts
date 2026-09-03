import type { BodyReplace, BodyRewrite, HeaderRewrite, QueryRewrite, RuleAction } from '@/shared/api';
import { headersToEditableText, parseEditableHeaders } from '@/shared/lib/utils';

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

/** Parses a number field's text, treating blank as "unset" rather than `NaN`/`0` — e.g. a delay/port/status input the user cleared out. */
export function parseOptionalInt(text: string): number | undefined {
  if (text.trim() === '') return undefined;
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) ? n : undefined;
}
