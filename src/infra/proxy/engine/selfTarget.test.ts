/* eslint-disable sonarjs/no-hardcoded-ip -- address fixtures */
import { describe, expect, it } from 'vitest';
import { createSelfTargetGuard } from './selfTarget';

function guardWith(dns: Record<string, string[]> = {}, local: string[] = ['192.168.1.5']) {
  const guard = createSelfTargetGuard(
    async (host) => {
      const answer = dns[host];
      if (!answer) throw new Error('ENOTFOUND');
      return answer;
    },
    () => local,
  );
  guard.protectPort(19080);
  return guard;
}

describe('createSelfTargetGuard', () => {
  it.each(['127.0.0.1', '::1', '[::1]', '0.0.0.0', '::ffff:127.0.0.1', '192.168.1.5'])(
    'treats %s on a protected port as self',
    async (host) => {
      expect(await guardWith().isSelfTarget(host, 19080)).toBe(true);
    },
  );

  it('ignores ports that are not protected, so ordinary localhost dev servers stay reachable', async () => {
    expect(await guardWith().isSelfTarget('127.0.0.1', 3000)).toBe(false);
  });

  it('ignores remote addresses on a protected port', async () => {
    expect(await guardWith().isSelfTarget('203.0.113.9', 19080)).toBe(false);
  });

  it('judges a hostname by what it resolves to (localhost, DNS rebinding)', async () => {
    const guard = guardWith({ localhost: ['::1', '127.0.0.1'], 'rebind.example': ['203.0.113.9', '127.0.0.1'] });
    expect(await guard.isSelfTarget('localhost', 19080)).toBe(true);
    expect(await guard.isSelfTarget('rebind.example', 19080)).toBe(true);
  });

  it('lets a name that resolves elsewhere or not at all through', async () => {
    const guard = guardWith({ 'api.example': ['203.0.113.9'] });
    expect(await guard.isSelfTarget('api.example', 19080)).toBe(false);
    expect(await guard.isSelfTarget('nx.example', 19080)).toBe(false);
  });

  it('protects every port it is told about', async () => {
    const guard = guardWith();
    guard.protectPort(18080);
    expect(await guard.isSelfTarget('127.0.0.1', 18080)).toBe(true);
  });
});
