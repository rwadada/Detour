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

function assertFixtureShape(data: unknown, filePath: string): Fixture {
  const looksValid =
    typeof data === 'object' &&
    data !== null &&
    typeof (data as Partial<Fixture>).method === 'string' &&
    typeof (data as Partial<Fixture>).path === 'string' &&
    typeof (data as Partial<Fixture>).status === 'number' &&
    typeof (data as Partial<Fixture>).responseHeaders === 'object' &&
    (data as Partial<Fixture>).responseHeaders !== null;
  if (!looksValid) {
    throw new Error(
      `Fixture file is missing one of the required fields (method, path, status, responseHeaders): ${filePath}`,
    );
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
