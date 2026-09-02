import { describe, expect, it } from 'vitest';
import { BreakpointCoordinator } from './breakpointCoordinator';

describe('BreakpointCoordinator', () => {
  it('resolves a pending wait when a matching command arrives', async () => {
    const coordinator = new BreakpointCoordinator();
    const promise = coordinator.wait('id-1', 'request');
    coordinator.resolve({ id: 'id-1', phase: 'request', action: 'abort' });
    await expect(promise).resolves.toEqual({ id: 'id-1', phase: 'request', action: 'abort' });
  });

  it('keeps request and response phases independent for the same id', async () => {
    const coordinator = new BreakpointCoordinator();
    const requestWait = coordinator.wait('id-1', 'request');
    const responseWait = coordinator.wait('id-1', 'response');
    coordinator.resolve({ id: 'id-1', phase: 'response', action: 'resume' });
    await expect(responseWait).resolves.toEqual({ id: 'id-1', phase: 'response', action: 'resume' });
    coordinator.resolve({ id: 'id-1', phase: 'request', action: 'resume' });
    await expect(requestWait).resolves.toEqual({ id: 'id-1', phase: 'request', action: 'resume' });
  });

  it('is a no-op resolving an id/phase with no pending wait', () => {
    const coordinator = new BreakpointCoordinator();
    expect(() => coordinator.resolve({ id: 'nope', phase: 'request', action: 'abort' })).not.toThrow();
  });
});
