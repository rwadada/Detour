import type { RulesFile } from '../../domain/rules/types';

/**
 * Reads and validates `rules.json`. Implemented against the real filesystem
 * by `infra/fs/rulesFileSource.ts`'s `fsRulesFileReader` — kept as an
 * interface here so `RuleEngine` (a UseCase) never touches `fs` directly.
 */
export interface RulesFileReader {
  /** Throws (with a human-readable message covering every error found) on a missing file, invalid JSON, or a document that fails validation. */
  read(filePath: string): RulesFile;
}
