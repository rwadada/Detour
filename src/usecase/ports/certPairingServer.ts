export interface CertPairingSession {
  /** URL a phone's browser fetches to download the CA cert — what the QR code encodes. Known as soon as `start` resolves, well before anything downloads it. */
  url: string;
  /** Resolves once a device has fetched the cert, or `timeoutMs` elapses — whichever comes first. `downloaded: false` means nobody scanned it in time. */
  waitForDownloadOrTimeout(): Promise<{ downloaded: boolean }>;
}

export interface CertPairingOptions {
  /** Path to the CA cert on this machine (`ensureCaCert()`'s result). */
  certPath: string;
  /**
   * Address to advertise in `url` — a bare IPv4/hostname, no port, no IPv6
   * colons (the implementation interpolates this straight into a
   * `host:port` URL component, unbracketed). Should be LAN-reachable for
   * real device use — a phone can't resolve a loopback address to this
   * machine — which `usecase/setup/android.ts`'s `invalidProxyHostError`
   * validates before calling `start` (the only real caller today); this
   * port itself doesn't enforce it, so a test exercising the server
   * mechanics directly (`infra/proxy/nodeCertPairingServer.test.ts`) can
   * still legitimately pass `127.0.0.1` to talk to it locally.
   */
  host: string;
  timeoutMs: number;
}

/**
 * Serves the CA cert over a one-shot local HTTP server so a phone on the
 * same Wi-Fi can download it (and, on Android, be offered to install it
 * straight from the download) by visiting a URL — scanned from a QR code
 * rather than typed — with no `adb`/USB connection at all (issue #65
 * follow-up). Implemented against a real `node:http` server by
 * `infra/proxy/nodeCertPairingServer.ts`.
 */
export interface CertPairingServer {
  start(options: CertPairingOptions): Promise<CertPairingSession>;
}
