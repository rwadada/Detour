import fs from 'node:fs';
import { validateRulesData } from './schema';
import type { RulesFile } from './types';

/**
 * Reads and validates a `rules.json` file from disk.
 *
 * Throws (with a human-readable message covering every error found — not
 * just the first) on a missing file, invalid JSON, or a document that
 * fails schema/semantic validation.
 */
export function loadRulesFile(filePath: string): RulesFile {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Could not read rules file: ${filePath}\n  ${describeError(err)}`, { cause: err });
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Rules file contains invalid JSON: ${filePath}\n  ${describeError(err)}`, { cause: err });
  }

  const result = validateRulesData(data);
  if (!result.valid) {
    const details = result.errors.map((e) => `  - ${e}`).join('\n');
    throw new Error(`Rules file failed validation: ${filePath}\n${details}`);
  }

  return data as RulesFile;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
