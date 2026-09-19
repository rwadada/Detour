import { describe, expect, it } from 'vitest';
import { runCommandUnderProxy } from './commandUnderProxy';

describe('runCommandUnderProxy', () => {
  it('rejects an empty command instead of crashing inside spawn() with a non-obvious error', () => {
    // Every current caller (runTestCommand/runRecordCommand) validates this
    // first, but this is exported infra/ code reusable outside those call
    // sites — a bare `spawn(undefined, [])` failing deep inside a promise
    // executor is a much worse error than one that names what's wrong.
    expect(() => runCommandUnderProxy([], 'http://localhost:8080', '/does/not/matter/ca.pem')).toThrow(
      'runCommandUnderProxy requires a non-empty command',
    );
  });
});
