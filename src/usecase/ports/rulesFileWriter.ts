import type { RulesFile } from '../../domain/rules/types';

/**
 * Writes `rules.json` (issue #19's Rules editor: edits made from the
 * dashboard are saved back to disk). Implemented against the real
 * filesystem by `infra/fs/rulesFileSource.ts`'s `fsRulesFileWriter` — kept
 * as an interface here so `RuleEngine` (a UseCase) never touches `fs`
 * directly, mirroring `RulesFileReader`.
 */
export interface RulesFileWriter {
  /** Throws (with a human-readable message covering every error found) if `data` fails validation. Leaves the file untouched in that case. */
  write(filePath: string, data: RulesFile): void;
}
