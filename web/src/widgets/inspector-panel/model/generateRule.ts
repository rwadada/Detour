import type { CapturedExchange, Rule, RuleAction } from '@/shared/api';
import { decodeCapturedBody } from '@/shared/lib/utils';

/** The rule types `CreateRuleButton` can generate a meaningful starting point for. `script` (no code to generate) isn't offered. */
export type GeneratableActionType = Extract<RuleAction['type'], 'mock' | 'route' | 'rewrite' | 'breakpoint'>;

/**
 * Response headers that describe the *transport*, not "what this endpoint's
 * response actually looks like" — freezing them into a `mock` rule would be
 * actively wrong (a stale `content-length` for a body that's about to be
 * re-serialized, a `set-cookie` from someone else's session) rather than
 * merely redundant, so these are dropped instead of carried over.
 */
const MOCK_HEADER_EXCLUDE = new Set([
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'date',
  'set-cookie',
]);

function mockActionFrom(exchange: CapturedExchange): RuleAction {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(exchange.responseHeaders ?? {})) {
    if (value === undefined || MOCK_HEADER_EXCLUDE.has(name.toLowerCase())) continue;
    headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }

  // A captured body decodes to text (JSON bodies included — MockAction.body
  // accepts a parsed value or a plain string, and re-serializes either the
  // same way a real response would); one that doesn't (binary, or none was
  // captured at all) leaves `body` unset rather than freezing mock rule.
  const bodyText = exchange.responseBody ? decodeCapturedBody(exchange.responseBody) : undefined;
  let body: unknown;
  if (bodyText !== undefined) {
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = bodyText;
    }
  }

  return {
    type: 'mock',
    status: exchange.statusCode ?? 200,
    statusMessage: exchange.statusMessage,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    body,
  };
}

/**
 * A fresh action of `type`, seeded from `exchange` where there's an obvious,
 * unambiguous default to seed (currently just `mock` — replaying the exact
 * response this exchange actually got). The rest start blank: there's no
 * safe way to guess *what* to route to, rewrite, or pause on from a single
 * captured exchange alone, unlike a response that already exists to freeze.
 */
function generatedAction(exchange: CapturedExchange, type: GeneratableActionType): RuleAction {
  switch (type) {
    case 'mock':
      return mockActionFrom(exchange);
    case 'route':
      return { type: 'route', host: '' };
    case 'rewrite':
      return { type: 'rewrite' };
    case 'breakpoint':
      return { type: 'breakpoint' };
  }
}

/** A short, unique-enough rule name derived from the exchange's host — sanitized to the same charset a hand-typed name would use, not because the schema requires it (it doesn't), just to stay readable in the rule list. */
function nameFor(exchange: CapturedExchange, type: GeneratableActionType): string {
  let host: string;
  try {
    host = new URL(exchange.url).hostname;
  } catch {
    host = exchange.host;
  }
  // Splitting on runs of non-alphanumeric characters and rejoining with a
  // single `-` collapses leading/trailing/repeated separators in one pass —
  // simpler (and, per a linter false-positive on the equivalent trim
  // regexes, faster to convince a static analyzer is safe) than chaining
  // more `replace()` calls to strip them separately.
  const slug = host
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join('-');
  return `${type}-${slug || 'rule'}`;
}

/**
 * Builds a new, unsaved `Rule` matching `exchange`'s exact method and URL —
 * deliberately exact rather than guessing which path segments are wildcard-
 * worthy IDs (a `/users/*` generalized from `/users/123` might be exactly
 * right, or might just as easily swallow requests it shouldn't); the editor
 * this opens into is exactly where that kind of judgment call belongs,
 * already reviewing everything else about the generated rule regardless.
 */
export function generateRuleFromExchange(exchange: CapturedExchange, type: GeneratableActionType): Rule {
  return {
    name: nameFor(exchange, type),
    enabled: true,
    match: { method: exchange.method, url: exchange.url },
    action: generatedAction(exchange, type),
  };
}
