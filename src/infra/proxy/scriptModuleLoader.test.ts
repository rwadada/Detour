import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Rule } from '../../domain/rules/types';
import { __resetScriptModuleCacheForTests } from '../fs/scriptModuleLoader';
import { tryLoadScriptModule } from './scriptModuleLoader';

const scriptRule = (path: string): Rule => ({
  name: 'r',
  match: { url: 'https://api.example.com/*' },
  action: { type: 'script', path },
});

describe('tryLoadScriptModule (issue #161)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-script-gate-test-'));
    fs.writeFileSync(path.join(dir, 'hook.js'), 'module.exports = { beforeRequest: (req) => req };');
    __resetScriptModuleCacheForTests();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to load the module (and never touches the filesystem) when allowScripts is off', () => {
    const onError = vi.fn();
    const statSpy = vi.spyOn(fs, 'statSync');
    const result = tryLoadScriptModule(scriptRule('hook.js'), {
      basePath: dir,
      allowExternalPaths: false,
      allowScripts: false,
      onError,
    });
    expect(result).toBeUndefined();
    expect(statSpy).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('script actions are disabled'));
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('--allow-scripts'));
    statSpy.mockRestore();
  });

  it('loads the module normally when allowScripts is on', () => {
    const onError = vi.fn();
    const result = tryLoadScriptModule(scriptRule('hook.js'), {
      basePath: dir,
      allowExternalPaths: false,
      allowScripts: true,
      onError,
    });
    expect(result).toBeDefined();
    expect(typeof result?.beforeRequest).toBe('function');
    expect(onError).not.toHaveBeenCalled();
  });

  it('still reports a load failure (missing file) when allowScripts is on', () => {
    const onError = vi.fn();
    const result = tryLoadScriptModule(scriptRule('missing.js'), {
      basePath: dir,
      allowExternalPaths: false,
      allowScripts: true,
      onError,
    });
    expect(result).toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('failed to load script'));
  });
});
