import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { SetupStep, StepStatus } from '../usecase/setup/types';
import { printStep } from './setupReport';

describe('printStep (stepIcon)', () => {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

  afterEach(() => {
    spy.mockClear();
  });

  // Restored, not just cleared: vitest runs several test files per worker
  // process, so a `console.log` left mocked here would silently swallow
  // every other file's output for the rest of that worker's life.
  afterAll(() => {
    spy.mockRestore();
  });

  it.each([
    ['done', '✔'],
    ['failed', '✖'],
    ['skipped', '⚠'],
    ['manual', 'ℹ'],
  ] satisfies [StepStatus, string][])('prints the %s icon', async (status, icon) => {
    await printStep({ status, message: 'a step' });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining(icon));
  });

  it('throws rather than silently printing "undefined" for a status outside StepStatus', async () => {
    // Unreachable from valid TypeScript — this exercises the runtime guard
    // for a value that got here some other way (a stale build against a
    // newer StepStatus, a non-type-checked JS caller).
    const bogus = { status: 'bogus', message: 'a step' } as unknown as SetupStep;
    await expect(printStep(bogus)).rejects.toThrow('stepIcon: unhandled SetupStep status: bogus');
  });
});
