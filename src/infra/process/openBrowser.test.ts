import { describe, expect, it } from 'vitest';
import { browserCommandFor } from './openBrowser';

describe('browserCommandFor', () => {
  it('uses `open` on macOS', () => {
    expect(browserCommandFor('darwin', 'http://localhost:9080')).toEqual({
      command: 'open',
      args: ['http://localhost:9080'],
    });
  });

  it('uses `cmd /c start` with an empty title on Windows', () => {
    expect(browserCommandFor('win32', 'http://localhost:9080')).toEqual({
      command: 'cmd',
      args: ['/c', 'start', '""', 'http://localhost:9080'],
    });
  });

  it('falls back to `xdg-open` on Linux and everywhere else', () => {
    expect(browserCommandFor('linux', 'http://localhost:9080')).toEqual({
      command: 'xdg-open',
      args: ['http://localhost:9080'],
    });
    expect(browserCommandFor('freebsd', 'http://localhost:9080')).toEqual({
      command: 'xdg-open',
      args: ['http://localhost:9080'],
    });
  });
});
