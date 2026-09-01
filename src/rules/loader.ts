import fs from 'node:fs';
import { validateRulesData } from './schema';
import type { RulesFile } from './types';

/**
 * Reads and validates a `rules.json` file from disk.
 *
 * Throws (with a Japanese, human-readable message covering every error
 * found — not just the first) on a missing file, invalid JSON, or a
 * document that fails schema/semantic validation.
 */
export function loadRulesFile(filePath: string): RulesFile {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`ルールファイルを読み込めません: ${filePath}\n  ${describeError(err)}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`ルールファイルのJSONが不正です: ${filePath}\n  ${describeError(err)}`);
  }

  const result = validateRulesData(data);
  if (!result.valid) {
    const details = result.errors.map((e) => `  - ${e}`).join('\n');
    throw new Error(`ルールファイルの検証に失敗しました: ${filePath}\n${details}`);
  }

  return data as RulesFile;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
