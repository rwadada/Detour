/**
 * How long Detour's local root CA is valid for, and how its remaining
 * lifetime is classified — pure policy, kept out of `CertAuthority`
 * (infra/proxy/engine) so `detour start`'s banner and `detour doctor` can
 * reuse the exact same wording and thresholds without reaching into the
 * cert machinery (issue #164).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Validity of a *newly generated* CA: 3 years.
 *
 * Was 1 year, which is short for a root a user has to install by hand on
 * every device — when it lapses, that whole (documented, fiddly) trust
 * dance has to be repeated. Existing CAs are never silently re-signed to
 * this: re-signing changes the fingerprint, so every device would have to
 * re-trust it anyway, which is exactly what this is trying to avoid.
 */
export const CA_VALIDITY_MS = 3 * 365 * DAY_MS;

/**
 * Validity of a per-host leaf cert: 1 year (unchanged).
 *
 * Do NOT raise this past 398 days. Apple's platforms reject server certs
 * with a validity period longer than that, and while certificates chaining
 * to a *user-installed* root are exempt from some of those rules, it isn't
 * worth finding out per OS release which ones. 365 leaves headroom.
 */
export const LEAF_VALIDITY_MS = 365 * DAY_MS;

/** How close to `notAfter` the CA has to be before `detour start`/`doctor` start nagging about it. */
export const CA_EXPIRY_WARNING_MS = 30 * DAY_MS;

export type CaValidityStatus = 'valid' | 'expiring-soon' | 'expired';

export interface CaValidity {
  status: CaValidityStatus;
  notAfter: Date;
  /** Whole days left, rounded up (negative once expired). */
  daysRemaining: number;
}

/** The command that mints a replacement CA — referenced by every message below, so it only has to be renamed in one place. */
export const CA_REGENERATE_COMMAND = 'detour cert regenerate';

function classify(msRemaining: number): CaValidityStatus {
  if (msRemaining <= 0) return 'expired';
  return msRemaining < CA_EXPIRY_WARNING_MS ? 'expiring-soon' : 'valid';
}

export function evaluateCaValidity(notAfter: Date, now: number = Date.now()): CaValidity {
  const msRemaining = notAfter.getTime() - now;
  const daysRemaining = Math.ceil(msRemaining / DAY_MS);
  return { status: classify(msRemaining), notAfter, daysRemaining };
}

/** `notAfter` as a plain UTC `YYYY-MM-DD` — a fixed, locale-independent rendering, since these strings are asserted on in tests and read in CI logs. */
function formatDate(notAfter: Date): string {
  return notAfter.toISOString().slice(0, 10);
}

/**
 * The `detour start` banner / `detour doctor` line for a CA that's close to
 * expiring, or undefined when there's nothing to say. Expiry itself isn't
 * handled here — `detour start` refuses to run at all by then (see
 * `caExpiredMessage`).
 */
export function caExpiryWarning(validity: CaValidity): string | undefined {
  if (validity.status !== 'expiring-soon') return undefined;
  const days = validity.daysRemaining === 1 ? '1 day' : `${validity.daysRemaining} days`;
  return `Root CA expires in ${days} (${formatDate(validity.notAfter)}) — run \`${CA_REGENERATE_COMMAND}\` and re-trust the new certificate on your devices before then.`;
}

/** Why `detour start` refuses to come up on an expired CA, and what to do about it. */
export function caExpiredMessage(validity: CaValidity): string {
  return `Detour's root CA expired on ${formatDate(validity.notAfter)} — certificates signed by it are rejected by every client. Run \`${CA_REGENERATE_COMMAND}\` to issue a new one, then re-trust it on your devices (\`detour setup\`).`;
}

export interface CaValidityReport {
  /**
   * Maps onto `detour doctor`'s step statuses: only an already-expired CA is
   * an outright failure (nothing can work until it's replaced). An expiry
   * that's still weeks away is a warning — everything works *today*, and
   * failing the readiness check over it would break `doctor`'s use as a CI
   * gate for a month before there's anything actually wrong.
   */
  severity: 'ok' | 'warning' | 'error';
  message: string;
}

/** `detour doctor`'s one-line verdict on the CA's remaining lifetime (issue #164). */
export function caValidityReport(validity: CaValidity): CaValidityReport {
  if (validity.status === 'expired') return { severity: 'error', message: caExpiredMessage(validity) };
  const warning = caExpiryWarning(validity);
  if (warning) return { severity: 'warning', message: warning };
  return {
    severity: 'ok',
    message: `Root CA valid for another ${validity.daysRemaining} days (until ${formatDate(validity.notAfter)}).`,
  };
}
