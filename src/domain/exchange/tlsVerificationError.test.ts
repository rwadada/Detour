import { describe, expect, it } from 'vitest';
import { describeUpstreamTlsError } from './tlsVerificationError';

function fakeErrnoException(code: string): NodeJS.ErrnoException {
  const err = new Error(`some raw openssl message for ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe('describeUpstreamTlsError', () => {
  it('returns undefined for null/undefined', () => {
    expect(describeUpstreamTlsError(null)).toBeUndefined();
    expect(describeUpstreamTlsError(undefined)).toBeUndefined();
  });

  it('returns undefined for an error with no code (a plain non-TLS failure)', () => {
    expect(describeUpstreamTlsError(new Error('connect ECONNREFUSED') as NodeJS.ErrnoException)).toBeUndefined();
  });

  it('returns undefined for an unrecognized code', () => {
    expect(describeUpstreamTlsError(fakeErrnoException('ECONNRESET'))).toBeUndefined();
  });

  it.each([
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'verified up to a trusted root'],
    ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'not trusted'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'self-signed certificate'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'self-signed certificate was found'],
    ['CERT_HAS_EXPIRED', 'has expired'],
    ['CERT_NOT_YET_VALID', "hasn't started yet"],
    ['ERR_TLS_CERT_ALTNAME_INVALID', "hostname doesn't match"],
    ['CERT_UNTRUSTED', 'is untrusted'],
    ['CERT_REVOKED', 'has been revoked'],
  ])('gives a specific message for %s', (code, expectedSubstring) => {
    const message = describeUpstreamTlsError(fakeErrnoException(code));
    expect(message).toContain(expectedSubstring);
    expect(message).toContain(code);
    expect(message).toContain('--upstream-ca');
    expect(message).toContain('--insecure-upstream');
  });
});
