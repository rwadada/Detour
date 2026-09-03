import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetScriptModuleCacheForTests, fsScriptModuleLoader } from './scriptModuleLoader';

describe('fsScriptModuleLoader', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-script-loader-test-'));
    __resetScriptModuleCacheForTests();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('loads a CommonJS module exporting beforeRequest/beforeResponse', () => {
    const filePath = path.join(dir, 'rules.script.js');
    fs.writeFileSync(
      filePath,
      "module.exports = { beforeRequest(req) { return { headers: { ...req.headers, 'x-detour': '1' } }; } };",
    );
    const module = fsScriptModuleLoader.load(filePath);
    expect(typeof module.beforeRequest).toBe('function');
    expect(module.beforeResponse).toBeUndefined();
  });

  it('allows a module that only exports beforeResponse', () => {
    const filePath = path.join(dir, 'rules.script.js');
    fs.writeFileSync(filePath, 'module.exports = { beforeResponse() { return undefined; } };');
    const module = fsScriptModuleLoader.load(filePath);
    expect(module.beforeRequest).toBeUndefined();
    expect(typeof module.beforeResponse).toBe('function');
  });

  it('rejects a module that does not export an object', () => {
    const filePath = path.join(dir, 'rules.script.js');
    fs.writeFileSync(filePath, 'module.exports = 42;');
    expect(() => fsScriptModuleLoader.load(filePath)).toThrow(/must export an object/);
  });

  it('rejects a module whose beforeRequest/beforeResponse are not functions', () => {
    const filePath = path.join(dir, 'rules.script.js');
    fs.writeFileSync(filePath, 'module.exports = { beforeRequest: "nope" };');
    expect(() => fsScriptModuleLoader.load(filePath)).toThrow(/must export an object/);
  });

  it('propagates a syntax error in the script file', () => {
    const filePath = path.join(dir, 'rules.script.js');
    fs.writeFileSync(filePath, 'this is not valid javascript {{{');
    expect(() => fsScriptModuleLoader.load(filePath)).toThrow();
  });

  it('throws for a missing file', () => {
    expect(() => fsScriptModuleLoader.load(path.join(dir, 'nope.js'))).toThrow();
  });

  it('caches the module across calls while the file is unchanged', () => {
    const filePath = path.join(dir, 'rules.script.js');
    fs.writeFileSync(filePath, 'module.exports = { beforeRequest() { return undefined; } };');
    const first = fsScriptModuleLoader.load(filePath);
    const second = fsScriptModuleLoader.load(filePath);
    expect(second).toBe(first);
  });

  it('reloads once the file content (and thus its size) changes', () => {
    // Bodies deliberately differ in length (not just content) — the cache
    // keys off mtime *and* size, and two writes landing within the same
    // filesystem timestamp tick would otherwise leave mtime unchanged.
    const filePath = path.join(dir, 'rules.script.js');
    fs.writeFileSync(filePath, 'module.exports = { beforeRequest() { return { headers: { v: "1" } }; } };');
    const first = fsScriptModuleLoader.load(filePath);

    fs.writeFileSync(filePath, 'module.exports = { beforeRequest() { return { headers: { v: "2-reloaded" } }; } };');
    const second = fsScriptModuleLoader.load(filePath);

    expect(second).not.toBe(first);
    const firstResult = first.beforeRequest?.({ method: 'GET', url: 'x', headers: {}, body: Buffer.alloc(0) });
    const secondResult = second.beforeRequest?.({ method: 'GET', url: 'x', headers: {}, body: Buffer.alloc(0) });
    expect(firstResult).toEqual({ headers: { v: '1' } });
    expect(secondResult).toEqual({ headers: { v: '2-reloaded' } });
  });
});
