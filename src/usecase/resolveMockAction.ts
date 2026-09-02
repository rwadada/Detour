import path from 'node:path';
import { buildMockResponse, type MockResponse } from '../domain/rules/mockResponse';
import type { MockAction } from '../domain/rules/types';
import type { MockBodyFileReader } from './ports/mockBodyFileReader';

/**
 * Resolves a `mock` action's `body`/`bodyFile` into a response, reading
 * `bodyFile` (if set) via the injected reader rather than touching `fs`
 * directly — see `buildMockResponse` for the pure assembly logic this
 * orchestrates.
 */
export function resolveMockAction(action: MockAction, basePath: string, fileReader: MockBodyFileReader): MockResponse {
  if (action.bodyFile === undefined) return buildMockResponse(action);
  const filePath = path.resolve(basePath, action.bodyFile);
  const bytes = fileReader.read(filePath);
  const looksLikeJson = filePath.toLowerCase().endsWith('.json');
  return buildMockResponse(action, { bytes, looksLikeJson });
}
