import { describe, expect, it } from 'vitest';
import { clientCertRejectionAlert, createAutoPassthroughHosts } from './clientCertRejection';

describe('clientCertRejectionAlert', () => {
  it.each([
    // What an Android app that doesn't trust user CAs sends (seen on a Pixel, Android 17).
    [
      'C0DE5BF401000000:error:0A000416:SSL routines:ssl3_read_bytes:tls alert certificate unknown:ssl/record/rec_layer_s3.c:923:SSL alert number 46',
      'certificate unknown',
    ],
    // What `openssl s_client -verify_return_error` sends.
    [
      'C0DE5BF401000000:error:0A000418:SSL routines:ssl3_read_bytes:tlsv1 alert unknown ca:ssl/record/rec_layer_s3.c:923:SSL alert number 48',
      'unknown CA',
    ],
    ['…:sslv3 alert bad certificate:…:SSL alert number 42', 'bad certificate'],
    ['…:SSL alert number 43', 'unsupported certificate'],
    ['…:SSL alert number 44', 'certificate revoked'],
    ['…:SSL alert number 45', 'certificate expired'],
  ])('reads %s as a refusal (%s)', (message, alert) => {
    expect(clientCertRejectionAlert(new Error(message))).toBe(alert);
  });

  it.each([
    // A client hanging up mid-handshake looks the same as a network drop.
    'socket hang up',
    'read ECONNRESET',
    // Alerts that aren't about the certificate.
    '…:tlsv1 alert protocol version:…:SSL alert number 70',
    '…:sslv3 alert handshake failure:…:SSL alert number 40',
    '…:tlsv1 alert decode error:…:SSL alert number 50',
  ])('does not read %s as a refusal', (message) => {
    expect(clientCertRejectionAlert(new Error(message))).toBeUndefined();
  });

  it('tolerates an error without a message', () => {
    expect(clientCertRejectionAlert(undefined)).toBeUndefined();
    expect(clientCertRejectionAlert({})).toBeUndefined();
  });
});

describe('createAutoPassthroughHosts', () => {
  it('records a host once and matches it case-insensitively', () => {
    const hosts = createAutoPassthroughHosts();
    expect(hosts.has('api.example.com')).toBe(false);
    expect(hosts.add('API.example.com')).toBe(true);
    expect(hosts.add('api.example.com')).toBe(false);
    expect(hosts.has('Api.Example.Com')).toBe(true);
    expect(hosts.has('other.example.com')).toBe(false);
  });
});
