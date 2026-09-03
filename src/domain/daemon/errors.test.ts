import { describe, expect, it } from 'vitest';
import { CliExitError } from './errors';

describe('CliExitError (issue #20)', () => {
  it('carries the message and exit code through to the thrown error', () => {
    const err = new CliExitError('detour is already running on port 8080', 3);
    expect(err.message).toBe('detour is already running on port 8080');
    expect(err.exitCode).toBe(3);
    expect(err.name).toBe('CliExitError');
    expect(err).toBeInstanceOf(Error);
  });
});
