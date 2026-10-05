import { describe, expect, it } from 'vitest';
import { buildRestartArgs, extractStartArgs } from './restartArgs';

describe('restart args', () => {
  it('drops foreground/background selectors', () => {
    expect(extractStartArgs(['--port', '8080', '--detach', '--foreground', '--rules', 'r.json'])).toEqual([
      '--port',
      '8080',
      '--rules',
      'r.json',
    ]);
  });

  it('relaunches detached without opening a browser tab', () => {
    expect(buildRestartArgs(['--port', '8080'])).toEqual([
      'start',
      '--port',
      '8080',
      '--no-open',
      '--resume-backlog',
      '--detach',
    ]);
  });

  it('does not duplicate an existing --no-open', () => {
    expect(buildRestartArgs(['--no-open', '--port', '8080'])).toEqual([
      'start',
      '--no-open',
      '--port',
      '8080',
      '--resume-backlog',
      '--detach',
    ]);
  });

  it('never replays --resume-backlog from an earlier restart', () => {
    expect(extractStartArgs(['--port', '8080', '--resume-backlog', '--detach'])).toEqual(['--port', '8080']);
    const restart = buildRestartArgs(['--resume-backlog', '--port', '8080']);
    expect(restart.filter((arg) => arg === '--resume-backlog')).toHaveLength(1);
  });
});
