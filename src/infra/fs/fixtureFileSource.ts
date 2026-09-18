import fs from 'node:fs';
import path from 'node:path';
import type { Fixture } from '../../domain/record/types';

/** Writes one fixture (see `buildFixtureFromExchange`) as a JSON file under `dir`, creating the directory if it doesn't exist yet. */
export function writeFixtureFile(dir: string, filename: string, fixture: Fixture): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isHeaderValue(value: unknown): value is string | string[] {
  return typeof value === 'string' || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
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
  if (typeof candidate.path !== 'string') errors.push('"path" must be a string');
  if (typeof candidate.status !== 'number') errors.push('"status" must be a number');
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
