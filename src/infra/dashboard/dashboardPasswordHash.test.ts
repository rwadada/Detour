import { describe, expect, it } from 'vitest';
import { hashDashboardPassword, verifyDashboardPassword } from './dashboardPasswordHash';

describe('dashboardPasswordHash (issue #66)', () => {
  it('verifies the correct password against its own hash', async () => {
    const hash = await hashDashboardPassword('hunter2');
    expect(await verifyDashboardPassword('hunter2', hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashDashboardPassword('hunter2');
    expect(await verifyDashboardPassword('wrong-guess', hash)).toBe(false);
  });

  it('never stores the plaintext password in the hash', async () => {
    const hash = await hashDashboardPassword('hunter2');
    expect(hash).not.toContain('hunter2');
  });

  it('produces a different hash for the same password each time (random salt)', async () => {
    expect(await hashDashboardPassword('hunter2')).not.toBe(await hashDashboardPassword('hunter2'));
  });

  it('rejects rather than throws on a malformed stored hash', async () => {
    expect(await verifyDashboardPassword('hunter2', 'not-a-valid-hash')).toBe(false);
    expect(await verifyDashboardPassword('hunter2', '')).toBe(false);
    expect(await verifyDashboardPassword('hunter2', 'salthex:')).toBe(false);
    expect(await verifyDashboardPassword('hunter2', 'not-hex:also-not-hex')).toBe(false);
  });

  // The whole point of the async form (see the module's own doc comment on
  // `scryptAsync`) — a synchronous `scryptSync` call would block this same
  // assertion's event loop turn just as much as anything else's.
  it('does not block the event loop while hashing', async () => {
    let ticked = false;
    setImmediate(() => {
      ticked = true;
    });
    await hashDashboardPassword('hunter2');
    expect(ticked).toBe(true);
  });
});
