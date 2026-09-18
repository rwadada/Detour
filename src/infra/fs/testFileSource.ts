import fs from 'node:fs';
import { validateTestData } from '../../domain/test/schema';
import type { TestFile } from '../../domain/test/types';

/**
 * Reads and validates a `detour test` assertions file from disk — same
 * shape of contract as `loadRulesFile` (infra/fs/rulesFileSource.ts):
 * throws with every error found, not just the first, on a missing file,
 * invalid JSON, or a document that fails schema/semantic validation.
 */
export function loadTestFile(filePath: string): TestFile {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Could not read test assertions file: ${filePath}\n  ${describeError(err)}`, { cause: err });
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Test assertions file contains invalid JSON: ${filePath}\n  ${describeError(err)}`, {
      cause: err,
    });
  }

  const result = validateTestData(data);
  if (!result.valid) {
    const details = result.errors.map((e) => `  - ${e}`).join('\n');
    throw new Error(`Test assertions file failed validation: ${filePath}\n${details}`);
  }

  return data as TestFile;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
