import type { BodyRewrite } from './types';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** JSON Merge Patch (RFC 7396): recursively applies `patch` onto `target`, `null` deleting a key. */
function jsonMergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return patch;
  const result: Record<string, unknown> = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
    } else {
      result[key] = jsonMergePatch(result[key], value);
    }
  }
  return result;
}

/**
 * Applies a `BodyRewrite`'s `set`/`replace`/`merge` steps to a body buffer,
 * per the ordering described on `BodyRewrite`'s doc comment. Pure — takes
 * and returns plain buffers, with no notion of a request/response stream.
 */
export function applyBodyRewrite(original: Buffer, rewrite: BodyRewrite): Buffer {
  if (rewrite.set !== undefined) {
    return typeof rewrite.set === 'string'
      ? Buffer.from(rewrite.set, 'utf8')
      : Buffer.from(JSON.stringify(rewrite.set), 'utf8');
  }
  let text = original.toString('utf8');
  for (const step of rewrite.replace ?? []) {
    text = step.regex
      ? text.replace(new RegExp(step.find, step.flags ?? 'g'), step.replacement)
      : text.split(step.find).join(step.replacement);
  }
  if (rewrite.merge !== undefined) {
    // A body that isn't valid JSON (or is empty) merges onto an empty
    // object rather than throwing — see the `merge` doc comment on BodyRewrite.
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    text = JSON.stringify(jsonMergePatch(parsed, rewrite.merge));
  }
  return Buffer.from(text, 'utf8');
}
