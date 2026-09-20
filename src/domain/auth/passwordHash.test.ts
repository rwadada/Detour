import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './passwordHash';

describe('passwordHash (issues #66, #158)', () => {
  it('verifies the correct password against its own hash', async () => {
    const hash = await hashPassword('hunter2');
    expect(await verifyPassword('hunter2', hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('hunter2');
    expect(await verifyPassword('wrong-guess', hash)).toBe(false);
  });

  it('never stores the plaintext password in the hash', async () => {
    const hash = await hashPassword('hunter2');
    expect(hash).not.toContain('hunter2');
  });

  it('produces a different hash for the same password each time (random salt)', async () => {
    expect(await hashPassword('hunter2')).not.toBe(await hashPassword('hunter2'));
  });

  it('rejects rather than throws on a malformed stored hash', async () => {
    expect(await verifyPassword('hunter2', 'not-a-valid-hash')).toBe(false);
    expect(await verifyPassword('hunter2', '')).toBe(false);
    expect(await verifyPassword('hunter2', 'salthex:')).toBe(false);
    expect(await verifyPassword('hunter2', 'not-hex:also-not-hex')).toBe(false);
  });

  // `Buffer.from(str, 'hex')` doesn't reliably throw on invalid input — it
  // silently truncates at the first bad character instead, which can still
  // decode to a non-empty buffer. Both halves must match the *exact* shape
  // `hashPassword` produces, checked before either is ever decoded.
  it('rejects a hash whose halves are the right length but contain non-hex characters', async () => {
    const rightLengthButNotHex = `${'g'.repeat(32)}:${'h'.repeat(128)}`;
    expect(await verifyPassword('hunter2', rightLengthButNotHex)).toBe(false);
  });

  // Also guards against an oversized on-disk hash forcing an equally
  // oversized (and expensive) scrypt derivation — a maliciously large
  // `hashHex` is rejected outright rather than decoded and handed to scrypt.
  it('rejects a hash whose halves are valid hex but the wrong length', async () => {
    const validHexWrongLength = `${'ab'.repeat(16)}:${'cd'.repeat(1000)}`;
    expect(await verifyPassword('hunter2', validHexWrongLength)).toBe(false);
  });

  // The whole point of the async form (see the module's own doc comment on
  // `scryptAsync`) — a synchronous `scryptSync` call would block this same
  // assertion's event loop turn just as much as anything else's.
  it('does not block the event loop while hashing', async () => {
    let ticked = false;
    setImmediate(() => {
      ticked = true;
    });
    await hashPassword('hunter2');
    expect(ticked).toBe(true);
  });
});
