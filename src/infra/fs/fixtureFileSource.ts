import fs from 'node:fs';
import path from 'node:path';
import type { Fixture } from '../../domain/record/types';

const ensuredDirs = new Set<string>();

function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Writes one fixture (see `buildFixtureFromExchange`) as a JSON file under
 * `dir`, creating the directory if it doesn't exist yet. Memoizes which
 * directories it has already created — `detour record` calls this once per
 * captured exchange, and `mkdirSync` on every one of those would be a
 * needless syscall on the hot path once the directory is already there —
 * but if the write still fails with `ENOENT` (the directory was removed
 * after being memoized, e.g. deleted mid-run by something else), forgets
 * that memo and retries once, actually recreating the directory, so the
 * function still keeps its contract of creating `dir` when it's missing.
 */
export function writeFixtureFile(dir: string, filename: string, fixture: Fixture): void {
  const filePath = path.join(dir, filename);
  const content = `${JSON.stringify(fixture, null, 2)}\n`;
  if (!ensuredDirs.has(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    ensuredDirs.add(dir);
  }
  try {
    fs.writeFileSync(filePath, content, 'utf8');
  } catch (err) {
    if (!isEnoent(err)) throw err;
    ensuredDirs.delete(dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isHeaderValue(value: unknown): value is string | string[] {
  return typeof value === 'string' || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
}

// `Buffer.from(str, 'base64')` is permissive — it silently ignores invalid
// characters and padding instead of throwing — so a hand-edited or garbled
// `responseBody` would otherwise decode to the wrong bytes instead of
// failing fast here as this loader's whole point is to do.
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
function isValidBase64(value: string): boolean {
  return value.length % 4 === 0 && BASE64_PATTERN.test(value);
}

/**
 * Checked thoroughly enough that a corrupted or hand-edited fixture fails
 * here, naming exactly what's wrong, rather than surfacing later as e.g.
 * `writeHead` throwing over a non-string header value deep inside handling
 * a live request `detour serve` is in the middle of.
 */
function assertFixtureShape(data: unknown, filePath: string): Fixture {
  const errors: string[] = [];
  if (typeof data !== 'object' || data === null) {
    throw new Error(`Fixture file is not a JSON object: ${filePath}`);
  }
  const candidate = data as Partial<Fixture>;

  if (typeof candidate.method !== 'string') errors.push('"method" must be a string');
  if (typeof candidate.path !== 'string') {
    errors.push('"path" must be a string');
  } else if (!candidate.path.startsWith('/')) {
    // Node's `req.url` for an origin-form request always starts with '/' —
    // a fixture path without it can never match a live request and would
    // only ever surface later as a confusing 404.
    errors.push('"path" must start with "/"');
  }
  if (
    typeof candidate.status !== 'number' ||
    !Number.isInteger(candidate.status) ||
    candidate.status < 100 ||
    candidate.status > 599
  ) {
    errors.push('"status" must be an integer HTTP status code (100-599)');
  }
  if (
    typeof candidate.responseHeaders !== 'object' ||
    candidate.responseHeaders === null ||
    // `typeof [] === 'object'` — without this, `responseHeaders: []` would
    // pass the check above and only fail later, confusingly, when
    // `detour serve` iterates it expecting string-keyed header entries.
    Array.isArray(candidate.responseHeaders)
  ) {
    errors.push('"responseHeaders" must be an object (not an array)');
  } else {
    for (const [key, value] of Object.entries(candidate.responseHeaders)) {
      if (!isHeaderValue(value)) errors.push(`"responseHeaders.${key}" must be a string or an array of strings`);
    }
  }
  if (candidate.statusMessage !== undefined && typeof candidate.statusMessage !== 'string') {
    errors.push('"statusMessage" must be a string if present');
  }
  if (candidate.responseBody !== undefined && typeof candidate.responseBody !== 'string') {
    errors.push('"responseBody" must be a string if present');
  }
  if (candidate.responseBodyEncoding !== undefined && candidate.responseBodyEncoding !== 'base64') {
    errors.push('"responseBodyEncoding" must be "base64" if present');
  }
  if (candidate.responseBodyEncoding !== undefined && candidate.responseBody === undefined) {
    errors.push('"responseBodyEncoding" must not be set without a "responseBody"');
  }
  if (
    candidate.responseBodyEncoding === 'base64' &&
    typeof candidate.responseBody === 'string' &&
    !isValidBase64(candidate.responseBody)
  ) {
    errors.push('"responseBody" is not valid base64 despite "responseBodyEncoding" being "base64"');
  }

  if (errors.length > 0) {
    const details = errors.map((e) => `  - ${e}`).join('\n');
    throw new Error(`Fixture file is invalid: ${filePath}\n${details}`);
  }
  return data as Fixture;
}

/**
 * Loads every `*.json` fixture file directly under `dir` (not recursive),
 * sorted by filename — `buildFixtureFromExchange`'s zero-padded sequence
 * prefix makes that the same as recording order, which `FixtureStore`'s
 * round-robin replay relies on. Throws (naming the specific file) on a
 * missing directory, invalid JSON, or a document missing fields `detour
 * serve` needs — rather than failing confusingly partway through matching
 * a live request later.
 */
export function loadFixtureFiles(dir: string): Fixture[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch (err) {
    throw new Error(`Could not read fixtures directory: ${dir}\n  ${describeError(err)}`, { cause: err });
  }
  entries.sort();

  return entries.map((name) => {
    const filePath = path.join(dir, name);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      throw new Error(`Could not read fixture file: ${filePath}\n  ${describeError(err)}`, { cause: err });
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Fixture file contains invalid JSON: ${filePath}\n  ${describeError(err)}`, { cause: err });
    }
    return assertFixtureShape(data, filePath);
  });
}
