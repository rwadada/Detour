import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { SAMPLE_RULES_FILE } from '../domain/rules/sample';
import { findUnreachableRules } from '../domain/rules/unreachableRules';
import { loadRulesFile } from '../infra/fs/rulesFileSource';
import { logUnreachableRuleWarnings } from '../presentation/logger';

/** Wires `detour rules validate`/`detour rules init` into the CLI. */
export function registerRulesCommands(program: Command): void {
  const rules = program.command('rules').description('Manage rules.json (the declarative rule engine config)');

  rules
    .command('validate <path>')
    .description("Validates a rules file against the schema and Detour's semantic rules")
    .action((rulesPath: string) => {
      try {
        const { rules: loaded } = loadRulesFile(path.resolve(rulesPath));
        console.log(`✔ ${rulesPath} is valid (${loaded.length} rule(s))`);
        // Non-fatal: an unreachable rule is a real bug in the file, but not
        // a schema violation — doesn't affect this command's exit code.
        logUnreachableRuleWarnings(findUnreachableRules(loaded));
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  rules
    .command('init [path]')
    .description('Creates a sample rules file')
    .action((rulesPath = 'rules.json') => {
      const dest = path.resolve(rulesPath);
      if (fs.existsSync(dest)) {
        console.error(`✖ Already exists: ${dest}`);
        process.exitCode = 1;
        return;
      }
      fs.writeFileSync(dest, SAMPLE_RULES_FILE);
      console.log(`✔ Created sample rules file: ${dest}`);
    });
}
