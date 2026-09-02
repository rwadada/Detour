import fs from 'node:fs';
import type { MockBodyFileReader } from '../../usecase/ports/mockBodyFileReader';

/** `MockBodyFileReader` (see usecase/ports/mockBodyFileReader.ts) backed by the real filesystem. */
export const fsMockBodyFileReader: MockBodyFileReader = {
  read: (filePath) => fs.readFileSync(filePath),
};
