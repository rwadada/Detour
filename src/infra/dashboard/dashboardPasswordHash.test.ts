import { describe, expect, it } from 'vitest';
import { hashDashboardPassword, verifyDashboardPassword } from './dashboardPasswordHash';

describe('dashboardPasswordHash (issue #66)', () => {
  it('verifies the correct password against its own hash', () => {
    const hash = hashDashboardPassword('hunter2');
    expect(verifyDashboardPassword('hunter2', hash)).toBe(true);
  });

  it('rejects a wrong password', () => {
    const hash = hashDashboardPassword('hunter2');
    expect(verifyDashboardPassword('wrong-guess', hash)).toBe(false);
  });

  it('never stores the plaintext password in the hash', () => {
    const hash = hashDashboardPassword('hunter2');
    expect(hash).not.toContain('hunter2');
  });

  it('produces a different hash for the same password each time (random salt)', () => {
    expect(hashDashboardPassword('hunter2')).not.toBe(hashDashboardPassword('hunter2'));
  });

  it('rejects rather than throws on a malformed stored hash', () => {
    expect(verifyDashboardPassword('hunter2', 'not-a-valid-hash')).toBe(false);
    expect(verifyDashboardPassword('hunter2', '')).toBe(false);
    expect(verifyDashboardPassword('hunter2', 'salthex:')).toBe(false);
    expect(verifyDashboardPassword('hunter2', 'not-hex:also-not-hex')).toBe(false);
  });
});
