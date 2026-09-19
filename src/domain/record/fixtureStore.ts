import type { Fixture } from './types';

interface FixtureGroup {
  fixtures: Fixture[];
  cursor: number;
}

function pathnameOf(path: string): string {
  const queryIndex = path.indexOf('?');
  return queryIndex === -1 ? path : path.slice(0, queryIndex);
}

function keyOf(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

/**
 * Matches an incoming request against loaded fixtures for `detour serve`
 * (issue #149).
 *
 * Two-tier lookup: an exact `method + path` (including query string) match
 * first, since different query params can legitimately have been recorded
 * with different responses (e.g. pagination) — falling back to `method +
 * pathname` (ignoring query entirely) for the common case of a
 * non-deterministic query param (a timestamp, a cache-buster) that was
 * never going to match verbatim on replay.
 *
 * Within whichever tier matches, multiple recordings sharing that key are
 * replayed round-robin in recorded order (see `buildFixtureFromExchange`'s
 * doc comment on why file order preserves that), sticking on the last one
 * once exhausted rather than erroring out on, say, a 4th request when only
 * 3 were ever recorded.
 */
export class FixtureStore {
  private readonly exact = new Map<string, FixtureGroup>();
  private readonly byPathname = new Map<string, FixtureGroup>();

  constructor(fixtures: readonly Fixture[]) {
    for (const fixture of fixtures) {
      this.addTo(this.exact, keyOf(fixture.method, fixture.path), fixture);
      this.addTo(this.byPathname, keyOf(fixture.method, pathnameOf(fixture.path)), fixture);
    }
  }

  private addTo(map: Map<string, FixtureGroup>, key: string, fixture: Fixture): void {
    const group = map.get(key);
    if (group) {
      group.fixtures.push(fixture);
    } else {
      map.set(key, { fixtures: [fixture], cursor: 0 });
    }
  }

  private next(group: FixtureGroup): Fixture {
    const index = Math.min(group.cursor, group.fixtures.length - 1);
    if (group.cursor < group.fixtures.length - 1) group.cursor += 1;
    return group.fixtures[index]!;
  }

  findFixture(method: string, path: string): Fixture | undefined {
    const exactGroup = this.exact.get(keyOf(method, path));
    if (exactGroup) return this.next(exactGroup);
    const pathnameGroup = this.byPathname.get(keyOf(method, pathnameOf(path)));
    if (pathnameGroup) return this.next(pathnameGroup);
    return undefined;
  }
}
