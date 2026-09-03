import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RuleProfileSummary } from '../../domain/rules/profile';
import { validateRulesData } from '../../domain/rules/schema';
import type { RulesFile } from '../../domain/rules/types';
import type { RuleProfileStore } from '../../usecase/ports/ruleProfileStore';

const PROFILE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/** Directory Detour keeps saved rule profiles in (`~/.detour/rule-profiles`), mirroring `certStore.ts`'s `resolveCertDir()`. Created on first use. */
export function resolveRuleProfilesDir(): string {
  const dir = path.join(os.homedir(), '.detour', 'rule-profiles');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function assertValidProfileName(name: string): void {
  if (!PROFILE_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid profile name: ${JSON.stringify(name)} (use letters, digits, ".", "_", "-", up to 64 characters, not starting with one of the symbols)`,
    );
  }
}

function profileFilePath(dir: string, name: string): string {
  assertValidProfileName(name);
  return path.join(dir, `${name}.json`);
}

/** Lists saved profiles, newest concerns aside — sorted by name for a stable dashboard listing. */
export function listRuleProfiles(dir: string = resolveRuleProfilesDir()): RuleProfileSummary[] {
  return fs
    .readdirSync(dir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => summarize(dir, entry))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function summarize(dir: string, entry: string): RuleProfileSummary {
  const full = path.join(dir, entry);
  const stat = fs.statSync(full);
  const ruleCount = countRules(full);
  return { name: entry.slice(0, -'.json'.length), ruleCount, updatedAt: stat.mtimeMs };
}

function countRules(filePath: string): number {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { rules?: unknown };
    return Array.isArray(data.rules) ? data.rules.length : 0;
  } catch {
    return 0; // Corrupt profile file — still listed (so it's visible to fix/remove), just with a 0 count.
  }
}

export function readRuleProfile(name: string, dir: string = resolveRuleProfilesDir()): RulesFile {
  const full = profileFilePath(dir, name);
  let raw: string;
  try {
    raw = fs.readFileSync(full, 'utf8');
  } catch (err) {
    throw new Error(`Could not read rule profile "${name}": ${full}`, { cause: err });
  }
  const data = JSON.parse(raw);
  const result = validateRulesData(data);
  if (!result.valid) {
    const details = result.errors.map((e) => `  - ${e}`).join('\n');
    throw new Error(`Rule profile "${name}" failed validation:\n${details}`);
  }
  return data as RulesFile;
}

export function writeRuleProfile(name: string, data: RulesFile, dir: string = resolveRuleProfilesDir()): void {
  const result = validateRulesData(data);
  if (!result.valid) {
    const details = result.errors.map((e) => `  - ${e}`).join('\n');
    throw new Error(`Rule profile "${name}" failed validation, not saved:\n${details}`);
  }
  fs.writeFileSync(profileFilePath(dir, name), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/** `RuleProfileStore` (see usecase/ports/ruleProfileStore.ts) backed by the real filesystem, rooted at `resolveRuleProfilesDir()`. */
export const fsRuleProfileStore: RuleProfileStore = {
  list: () => listRuleProfiles(),
  read: (name) => readRuleProfile(name),
  write: (name, data) => writeRuleProfile(name, data),
};
