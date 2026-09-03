import type { ScriptModule } from '../../domain/rules/scriptAction';

/**
 * Loads a `script` rule's Node.js module off disk. Injected so UseCase code
 * never touches `require`/`fs` directly — see infra/fs/scriptModuleLoader.ts
 * for the real implementation.
 */
export interface ScriptModuleLoader {
  /** `filePath` is already resolved to an absolute path by the caller. */
  load(filePath: string): ScriptModule;
}
