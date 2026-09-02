import fs from 'node:fs';
import path from 'node:path';
import { validateRulesData } from '../../domain/rules/schema';
import type { RulesFile } from '../../domain/rules/types';
import type { FileWatcher } from '../../usecase/ports/fileWatcher';
import type { RulesFileReader } from '../../usecase/ports/rulesFileReader';

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

/** `RulesFileReader` (see usecase/ports/rulesFileReader.ts) backed by the real filesystem. */
export const fsRulesFileReader: RulesFileReader = { read: loadRulesFile };

/**
 * `FileWatcher` (see usecase/ports/fileWatcher.ts) backed by `fs.watch`.
 * Watches the containing directory (not the file itself): editors that save
 * atomically (write temp file + rename) replace the inode, which a watch on
 * the file itself can silently stop tracking.
 */
export const fsFileWatcher: FileWatcher = {
  watch(filePath, onChange, onError) {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const watcher = fs.watch(dir, (_eventType, filename) => {
      if (filename && filename !== base) return;
      onChange();
    });
    watcher.on('error', (err) => onError(err.message));
    return () => watcher.close();
  },
};
