import fs from 'node:fs';
import http from 'node:http';
import type { CertPairingOptions, CertPairingServer, CertPairingSession } from '../../usecase/ports/certPairingServer';

/** Fixed rather than derived from `certPath` — a stable, obviously-a-cert URL/filename regardless of where `ensureCaCert()` happens to keep the file on this machine. */
const CERT_ROUTE = '/detour-ca.crt';

/** Extra time after the first request before tearing the server down — long enough for the response to finish flushing over a slow/lossy Wi-Fi link before the socket closes under it. */
const DOWNLOAD_GRACE_MS = 2_000;

/**
 * Real `CertPairingServer` (see that file's doc comment). Deliberately
 * plain `http://`, not `https://`: the whole point of this endpoint is to
 * hand a phone the *first* certificate it should trust, so it can't
 * already have anything to verify an HTTPS connection to this server with
 * — the same reasoning `mitm.it`/similar tools' cert-bootstrap pages use.
 */
export const nodeCertPairingServer: CertPairingServer = {
  start({ certPath, host, timeoutMs }: CertPairingOptions): Promise<CertPairingSession> {
    const cert = fs.readFileSync(certPath);

    return new Promise((resolveStart, rejectStart) => {
      let downloaded = false;
      let finish: (() => void) | undefined;

      const server = http.createServer((req, res) => {
        if (req.url !== CERT_ROUTE) {
          res.writeHead(404).end();
          return;
        }
        downloaded = true;
        res.writeHead(200, {
          // Android's Download Manager recognizes this MIME type and offers
          // to install the file as a CA certificate as soon as it finishes
          // downloading — the whole point of serving it this way instead of
          // just handing over a plain file.
          'Content-Type': 'application/x-x509-ca-cert',
          'Content-Length': cert.length,
          'Content-Disposition': 'attachment; filename="detour-ca.crt"',
        });
        res.end(cert);
        setTimeout(() => finish?.(), DOWNLOAD_GRACE_MS);
      });

      server.once('error', rejectStart);

      // 0.0.0.0: a phone on the same Wi-Fi has to reach this from outside
      // the host machine, so localhost-only won't do.
      server.listen(0, '0.0.0.0', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        const url = `http://${host}:${port}${CERT_ROUTE}`;

        const completion = new Promise<{ downloaded: boolean }>((resolveWait) => {
          const timeout = setTimeout(() => finish?.(), timeoutMs);
          let finished = false;
          finish = () => {
            if (finished) return;
            finished = true;
            clearTimeout(timeout);
            server.close();
            resolveWait({ downloaded });
          };
        });

        resolveStart({ url, waitForDownloadOrTimeout: () => completion });
      });
    });
  },
};
