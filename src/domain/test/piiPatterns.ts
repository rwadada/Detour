import type { PiiPatternName } from './types';

/**
 * Best-effort PII detectors for `noPiiLeak` (issue #148). Intentionally
 * simple, readable regexes rather than a full validating parser (e.g. a
 * real credit-card check would verify the Luhn digit) — this is a
 * CI smoke check for "did this obviously-shaped value leak to a domain it
 * shouldn't have", not a compliance-grade PII scanner. Deliberately not
 * `g`-flagged — `evaluate.ts` only ever needs a yes/no `.test()` per field,
 * and a shared global RegExp's mutable `lastIndex` would silently skip
 * matches across the many `.test()` calls a single run makes against it.
 */
export const PII_PATTERNS: Record<PiiPatternName, RegExp> = {
  // Deliberately matches only a single domain label before the TLD
  // ("user@example.com", not "user@mail.example.com"), and every quantifier
  // is bounded (`{1,64}`, not `+`/`*`) rather than open-ended — an unbounded
  // repetition immediately followed by more required content is the classic
  // catastrophic-backtracking shape, and `sonarjs/super-linear-regex` flags
  // it as such regardless of whether this particular character class is
  // actually ambiguous with what follows. The bounds themselves come from
  // RFC 5321/5322's real length limits (64 octets for the local part, 63
  // for a domain label), so this doesn't just paper over the lint rule.
  email: /[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}\.[a-z]{2,24}/i,
  // A bare 13–19 digit run (covers common card lengths) — deliberately not
  // trying to also tolerate dash/space-grouped input (e.g. "4111-1111-...")
  // the way a human-typed form field would: a request/response body is
  // almost always JSON carrying the digits as a plain string, and a fixed
  // digit count with no optional separator avoids the backtracking risk a
  // quantified separator between quantified digit groups can introduce.
  creditCard: /\b\d{13,19}\b/,
  ssn: /\b\d{3}-\d{2}-\d{4}\b/,
};
