import { afterEach, describe, expect, it, vi } from 'vitest';
import { shouldSkipSplash } from './SplashScreen';

describe('shouldSkipSplash', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not skip when neither navigator.webdriver nor window exist (this test suite's own node environment)", () => {
    expect(shouldSkipSplash()).toBe(false);
  });

  it('skips when navigator.webdriver is true (Playwright/Selenium/Puppeteer)', () => {
    vi.stubGlobal('navigator', { webdriver: true });
    expect(shouldSkipSplash()).toBe(true);
  });

  it('does not skip when navigator.webdriver is false', () => {
    vi.stubGlobal('navigator', { webdriver: false });
    expect(shouldSkipSplash()).toBe(false);
  });

  it('skips when the URL has a ?no-animation query param', () => {
    vi.stubGlobal('navigator', { webdriver: false });
    vi.stubGlobal('window', { location: { search: '?no-animation' } });
    expect(shouldSkipSplash()).toBe(true);
  });

  it('does not skip for an unrelated query string', () => {
    vi.stubGlobal('navigator', { webdriver: false });
    vi.stubGlobal('window', { location: { search: '?foo=bar' } });
    expect(shouldSkipSplash()).toBe(false);
  });
});
