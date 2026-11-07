import type { Rule } from '@/shared/api';
import { blankAction } from './actionFields';

/** A short, human-readable summary of what a rule matches, for the rule list row (e.g. `"GET https://api.example.com/*"`). */
export function describeMatch(rule: Rule): string {
  const method = Array.isArray(rule.match.method) ? rule.match.method.join(',') : (rule.match.method ?? 'ANY');
  const pattern =
    rule.match.url ?? (rule.match.urlRegex ? `/${rule.match.urlRegex}/${rule.match.urlRegexFlags ?? ''}` : '*');
  return `${method} ${pattern}`;
}

/** A fresh rule for the "+ Add rule" button — name is a placeholder the user is expected to change. */
export function blankRule(): Rule {
  return { name: 'new-rule', enabled: true, match: { url: '*' }, action: blankAction('mock') };
}

/** Parses the Method field's free-text input into `RuleMatch['method']`: blank means "any method", a comma splits into a list (dropping empty trailing entries so `"GET, "` never produces an invalid `""` element). */
export function parseMethodInput(value: string): string | string[] | undefined {
  const parts = value
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  if (parts.length === 0) return undefined;
  return parts.length === 1 ? parts[0] : parts;
}

/** The inverse of `parseMethodInput`, for seeding the Method field's local edit buffer. */
export function methodToEditableText(method: Rule['match']['method']): string {
  return Array.isArray(method) ? method.join(', ') : (method ?? '');
}
