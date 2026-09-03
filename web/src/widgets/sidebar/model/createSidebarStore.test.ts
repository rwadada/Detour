import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSidebarStore } from './createSidebarStore';

function fakeLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

describe('createSidebarStore', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage());
  });

  it('starts expanded when nothing is persisted', () => {
    expect(createSidebarStore().getState().collapsed).toBe(false);
  });

  it('toggleCollapsed flips the flag and persists it for the next store instance (e.g. a page reload)', () => {
    const first = createSidebarStore();
    first.getState().toggleCollapsed();
    expect(first.getState().collapsed).toBe(true);

    const second = createSidebarStore();
    expect(second.getState().collapsed).toBe(true);
  });
});
