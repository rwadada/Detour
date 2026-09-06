import { describe, expect, it } from 'vitest';
import { renderQrCode } from './qrCode';

describe('renderQrCode', () => {
  it('renders a non-empty, multi-line ASCII QR code for a URL', async () => {
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- this is exactly the plain-http cert-pairing URL renderQrCode exists to render (see nodeCertPairingServer.ts's doc comment for why it's HTTP, not HTTPS, by design).
    const qr = await renderQrCode('http://203.0.113.5:8080/detour-ca.crt');
    expect(qr.length).toBeGreaterThan(0);
    expect(qr.split('\n').length).toBeGreaterThan(5);
  });
});
