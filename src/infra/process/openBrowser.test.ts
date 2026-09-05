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

  it('escapes & and ^ on Windows so cmd.exe treats a query string as literal, not a command separator', () => {
    expect(browserCommandFor('win32', 'http://localhost:9080/?a=1&b=2')).toEqual({
      command: 'cmd',
      args: ['/c', 'start', '""', 'http://localhost:9080/?a=1^&b=2'],
    });
    expect(browserCommandFor('win32', 'http://localhost:9080/?caret=^')).toEqual({
      command: 'cmd',
      args: ['/c', 'start', '""', 'http://localhost:9080/?caret=^^'],
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
