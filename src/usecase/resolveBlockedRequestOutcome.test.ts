import { describe, expect, it } from 'vitest';
import { resolveBlockedRequestOutcome } from './resolveBlockedRequestOutcome';

describe('resolveBlockedRequestOutcome', () => {
  it('resets the connection in "reset" mode, naming the blocked host in the error', () => {
    const outcome = resolveBlockedRequestOutcome('reset', 'evil.example.com');
    expect(outcome).toEqual({
      kind: 'reset',
      errorMessage: 'blocked host "evil.example.com": simulated connection close (no response sent)',
    });
  });

  it('returns a 403 mock naming the host in "forbidden" mode', () => {
    const outcome = resolveBlockedRequestOutcome('forbidden', 'evil.example.com');
    expect(outcome.kind).toBe('mock');
    if (outcome.kind !== 'mock') throw new Error('unreachable');
    expect(outcome.mock.status).toBe(403);
    expect(outcome.mock.statusMessage).toBe('Forbidden');
    expect(outcome.mock.body.toString('utf8')).toContain('evil.example.com');
  });
});
