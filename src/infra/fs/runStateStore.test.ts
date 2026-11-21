import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunState } from '../../domain/daemon/types';
import { findLiveRunState, reserveRunState, writeRunState } from './runStateStore';

describe('runStateStore', () => {
  let home: string;
  let runDir: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-run-state-test-'));
    runDir = path.join(home, '.detour', 'run');
    vi.spyOn(os, 'homedir').mockReturnValue(home);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const state = (overrides: Partial<RunState> = {}): RunState => ({
    pid: process.pid,
    requestedPort: 18080,
    proxyPort: 18080,
    headless: true,
    detached: false,
    startedAt: 1,
    ...overrides,
  });

  describe('reserveRunState', () => {
    it('lets exactly one reservation for a port win while its holder is alive', () => {
      expect(reserveRunState(state())).toBe(true);
      expect(reserveRunState(state())).toBe(false);
      expect(findLiveRunState(18080)?.pid).toBe(process.pid);
    });

    it('never makes the file visible without its content, and leaves no temporary file behind', () => {
      // The old `wx` write created the file empty and filled it afterwards; a loser reading in between took it
      // for a corrupt leftover, deleted it and won too. Whatever appears under the real name must already be whole.
      const linkSync = fs.linkSync;
      const seenAtLink: string[] = [];
      vi.spyOn(fs, 'linkSync').mockImplementation((existing, target) => {
        seenAtLink.push(fs.readFileSync(existing, 'utf8'));
        linkSync(existing, target);
      });

      expect(reserveRunState(state())).toBe(true);

      expect(JSON.parse(seenAtLink[0]!)).toMatchObject({ pid: process.pid, requestedPort: 18080 });
      expect(fs.readdirSync(runDir)).toEqual(['18080.json']);
    });

    it('takes over a reservation whose holder is gone', () => {
      fs.mkdirSync(runDir, { recursive: true });
      // A PID that can't belong to a live process (beyond any real pid_max).
      fs.writeFileSync(path.join(runDir, '18080.json'), JSON.stringify(state({ pid: 2 ** 30 })));
      expect(reserveRunState(state())).toBe(true);
      expect(findLiveRunState(18080)?.pid).toBe(process.pid);
    });
  });

  describe('writeRunState', () => {
    it('replaces the file in one step, owner-only, without leaving a temporary file', () => {
      expect(reserveRunState(state())).toBe(true);
      writeRunState(state({ proxyPort: 18081, startedAt: 2 }));

      expect(findLiveRunState(18080)).toMatchObject({ proxyPort: 18081, startedAt: 2 });
      expect(fs.readdirSync(runDir)).toEqual(['18080.json']);
      if (process.platform !== 'win32') {
        expect(fs.statSync(path.join(runDir, '18080.json')).mode & 0o777).toBe(0o600);
      }
    });
  });
});
