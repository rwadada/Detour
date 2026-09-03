import type { Rule } from '@/shared/api';

/** A short, human-readable summary of what a rule matches, for the rule list row (e.g. `"GET https://api.example.com/*"`). */
export function describeMatch(rule: Rule): string {
  const method = Array.isArray(rule.match.method) ? rule.match.method.join(',') : (rule.match.method ?? 'ANY');
  const pattern =
    rule.match.url ?? (rule.match.urlRegex ? `/${rule.match.urlRegex}/${rule.match.urlRegexFlags ?? ''}` : '*');
  return `${method} ${pattern}`;
}

/** A fresh rule for the "+ Add rule" button — name is a placeholder the user is expected to change. */
export function blankRule(): Rule {
  return { name: 'new-rule', enabled: true, match: { url: '*' }, action: { type: 'mock', status: 200 } };
}

/** Parses the Method field's free-text input into `RuleMatch['method']`: blank means "any method", a comma splits into a list. */
export function parseMethodInput(value: string): string | string[] | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (!trimmed.includes(',')) return trimmed;
  return trimmed.split(',').map((m) => m.trim());
}
