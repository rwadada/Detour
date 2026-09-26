import { describe, expect, it } from 'vitest';
import {
  CA_EXPIRY_WARNING_MS,
  CA_VALIDITY_MS,
  caExpiredMessage,
  caExpiryWarning,
  caValidityReport,
  evaluateCaValidity,
  LEAF_VALIDITY_MS,
} from './caValidity';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-01-01T00:00:00Z');

function inDays(days: number): Date {
  return new Date(NOW + days * DAY);
}

describe('CA validity policy', () => {
  it('issues new CAs for 3 years', () => {
    expect(CA_VALIDITY_MS).toBe(3 * 365 * DAY);
  });

  it('keeps leaf certs at 1 year, well under the 398-day ceiling Apple enforces', () => {
    expect(LEAF_VALIDITY_MS).toBe(365 * DAY);
    expect(LEAF_VALIDITY_MS).toBeLessThanOrEqual(398 * DAY);
  });

  it('warns for the last 30 days', () => {
    expect(CA_EXPIRY_WARNING_MS).toBe(30 * DAY);
  });
});

describe('evaluateCaValidity', () => {
  it('is valid well before expiry', () => {
    expect(evaluateCaValidity(inDays(400), NOW)).toMatchObject({ status: 'valid', daysRemaining: 400 });
  });

  it('is expiring-soon inside the warning window', () => {
    expect(evaluateCaValidity(inDays(29), NOW).status).toBe('expiring-soon');
    expect(evaluateCaValidity(inDays(1), NOW)).toMatchObject({ status: 'expiring-soon', daysRemaining: 1 });
  });

  it('stays valid on the warning window boundary itself', () => {
    expect(evaluateCaValidity(inDays(30), NOW).status).toBe('valid');
  });

  it('is expired at (and after) notAfter', () => {
    expect(evaluateCaValidity(new Date(NOW), NOW).status).toBe('expired');
    expect(evaluateCaValidity(inDays(-5), NOW)).toMatchObject({ status: 'expired', daysRemaining: -5 });
  });

  it('rounds a partial day up, so "expires in 0 days" is never reported for a still-valid CA', () => {
    expect(evaluateCaValidity(new Date(NOW + 60 * 1000), NOW)).toMatchObject({
      status: 'expiring-soon',
      daysRemaining: 1,
    });
  });
});

describe('messages', () => {
  it('warns only while expiring-soon', () => {
    expect(caExpiryWarning(evaluateCaValidity(inDays(400), NOW))).toBeUndefined();
    expect(caExpiryWarning(evaluateCaValidity(inDays(-1), NOW))).toBeUndefined();
    const warning = caExpiryWarning(evaluateCaValidity(inDays(10), NOW));
    expect(warning).toContain('10 days');
    expect(warning).toContain('2026-01-11');
    expect(warning).toContain('detour cert regenerate');
  });

  it('uses the singular for the last day', () => {
    expect(caExpiryWarning(evaluateCaValidity(inDays(1), NOW))).toContain('in 1 day (');
  });

  it('the expiry error names the date and the command that fixes it', () => {
    const message = caExpiredMessage(evaluateCaValidity(inDays(-3), NOW));
    expect(message).toContain('2025-12-29');
    expect(message).toContain('detour cert regenerate');
    expect(message).toContain('detour setup');
  });
});

describe('caValidityReport', () => {
  it('passes for a healthy CA', () => {
    const report = caValidityReport(evaluateCaValidity(inDays(900), NOW));
    expect(report.severity).toBe('ok');
    expect(report.message).toContain('900 days');
  });

  it('warns — but does not fail — while expiring soon', () => {
    const report = caValidityReport(evaluateCaValidity(inDays(5), NOW));
    expect(report.severity).toBe('warning');
    expect(report.message).toContain('expires in 5 days');
  });

  it('fails once expired', () => {
    const report = caValidityReport(evaluateCaValidity(inDays(-1), NOW));
    expect(report.severity).toBe('error');
    expect(report.message).toContain('expired on');
  });
});
