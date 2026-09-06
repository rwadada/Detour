export interface CertPairingSession {
  /** URL a phone's browser fetches to download the CA cert — what the QR code encodes. Known as soon as `start` resolves, well before anything downloads it. */
  url: string;
  /** Resolves once a device has fetched the cert, or `timeoutMs` elapses — whichever comes first. `downloaded: false` means nobody scanned it in time. */
  waitForDownloadOrTimeout(): Promise<{ downloaded: boolean }>;
}

export interface CertPairingOptions {
  /** Path to the CA cert on this machine (`ensureCaCert()`'s result). */
  certPath: string;
  /** LAN-reachable address to advertise in `url` — never `localhost`, since a phone can't resolve that to this machine. */
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
