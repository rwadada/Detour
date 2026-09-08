import { buildMockResponse, type MockResponse } from '../domain/rules/mockResponse';
import { resolveRulePath } from '../domain/rules/safeRulePath';
import type { MockAction } from '../domain/rules/types';
import type { MockBodyFileReader } from './ports/mockBodyFileReader';

/**
 * Resolves a `mock` action's `body`/`bodyFile` into a response, reading
 * `bodyFile` (if set) via the injected reader rather than touching `fs`
 * directly — see `buildMockResponse` for the pure assembly logic this
 * orchestrates.
 *
 * `bodyFile` is rejected (before ever reaching `fileReader`) if it resolves
 * outside `basePath` — an absolute path or `../` traversal — unless
 * `allowExternalPaths` is set. See `resolveRulePath`'s doc comment for why
 * (issue #98).
 */
export function resolveMockAction(
  action: MockAction,
  basePath: string,
  fileReader: MockBodyFileReader,
  allowExternalPaths = false,
): MockResponse {
  if (action.bodyFile === undefined) return buildMockResponse(action);
  const filePath = resolveRulePath(basePath, action.bodyFile, 'mock.bodyFile', allowExternalPaths);
  const bytes = fileReader.read(filePath);
  const looksLikeJson = filePath.toLowerCase().endsWith('.json');
  return buildMockResponse(action, { bytes, looksLikeJson });
}
