/**
 * Reads a `mock` action's `bodyFile` off disk. Implemented against the real
 * filesystem by `infra/fs/mockBodyFileReader.ts` — kept as an interface here
 * so `resolveMockAction` (a UseCase) never touches `fs` directly.
 */
export interface MockBodyFileReader {
  read(filePath: string): Buffer;
}
