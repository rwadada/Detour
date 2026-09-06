export interface CertPairingSession {
  /** URL a phone's browser fetches to download the CA cert — what the QR code encodes. Known as soon as `start` resolves, well before anything downloads it. */
  url: string;
  /** Resolves once a device has fetched the cert, or `timeoutMs` elapses — whichever comes first. `downloaded: false` means nobody scanned it in time. */
  waitForDownloadOrTimeout(): Promise<{ downloaded: boolean }>;
}

export interface CertPairingOptions {
  /** Path to the CA cert on this machine (`ensureCaCert()`'s result). */
  certPath: string;
  /** LAN-reachable address to advertise in `url` — a bare IPv4/hostname, no port, no IPv6 colons (the implementation interpolates this straight into a `host:port` URL component, unbracketed), and never a loopback address, since a phone can't resolve that to this machine. Callers validate this before calling `start` (see `usecase/setup/android.ts`'s `invalidProxyHostError`, the only caller today) — this port trusts it's already been checked. */
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
