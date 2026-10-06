import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openPrivateLogFile } from './daemonize';

describe.skipIf(process.platform === 'win32')(
  'openPrivateLogFile (issue #205 — the log holds the access token)',
  () => {
    let dir: string;
    let logFile: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-daemonize-test-'));
      logFile = path.join(dir, 'logs', '4040.log');
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const mode = (target: string) => fs.statSync(target).mode & 0o777;

    it('creates the log file owner-only, and its directory too', () => {
      const fd = openPrivateLogFile(logFile);
      fs.closeSync(fd);

      expect(mode(logFile)).toBe(0o600);
      expect(mode(path.dirname(logFile))).toBe(0o700);
    });

    it('tightens a log (and its directory) that an earlier version left readable by everyone', () => {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.writeFileSync(logFile, 'earlier output\n');
      // Deliberately loose: this is the state the code under test must repair.
      // eslint-disable-next-line sonarjs/file-permissions
      fs.chmodSync(logFile, 0o644);
      // eslint-disable-next-line sonarjs/file-permissions
      fs.chmodSync(path.dirname(logFile), 0o755);

      fs.closeSync(openPrivateLogFile(logFile));

      expect(mode(logFile)).toBe(0o600);
      expect(mode(path.dirname(logFile))).toBe(0o700);
    });

    it('appends rather than truncating, so earlier output survives a restart', () => {
      fs.closeSync(openPrivateLogFile(logFile));
      fs.appendFileSync(logFile, 'first run\n');

      const fd = openPrivateLogFile(logFile);
      fs.writeSync(fd, 'second run\n');
      fs.closeSync(fd);

      expect(fs.readFileSync(logFile, 'utf8')).toBe('first run\nsecond run\n');
    });
  },
);
