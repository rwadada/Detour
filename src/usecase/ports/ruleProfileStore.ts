import type { RuleProfileSummary } from '../../domain/rules/profile';
import type { RulesFile } from '../../domain/rules/types';

/**
 * Manages saved rule profiles (issue #19's Rules Profiles). Implemented
 * against the real filesystem by `infra/fs/ruleProfileStore.ts`'s
 * `fsRuleProfileStore` — kept as an interface so callers (dashboardServer)
 * don't touch `fs` directly, mirroring `RulesFileReader`/`RulesFileWriter`.
 */
export interface RuleProfileStore {
  list(): RuleProfileSummary[];
  /** Throws if no profile named `name` exists, or it fails validation. */
  read(name: string): RulesFile;
  /** Creates `name` (or overwrites it if it already exists). Throws (without writing) if `data` fails validation or `name` is invalid. */
  write(name: string, data: RulesFile): void;
}
