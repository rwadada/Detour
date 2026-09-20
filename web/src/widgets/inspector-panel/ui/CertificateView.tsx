import type { UpstreamCertificate } from '@/shared/api';

/**
 * The upstream server's real TLS certificate (issue #160) — the detail
 * panel's counterpart to `TimingWaterfall`: both surface something about
 * the proxy→upstream connection that the client-facing side (Detour's own
 * substituted leaf cert, in this case) can never show on its own.
 */
export function CertificateView({ certificate }: { certificate: UpstreamCertificate | undefined }) {
  if (!certificate) {
    return (
      <p className="p-3 text-xs text-[var(--muted)]">
        No certificate available — this request never reached an upstream server, or the TLS handshake never completed
        (see this exchange's error for why).
      </p>
    );
  }

  return (
    <div className="p-3">
      <div
        className="mb-3 flex items-center gap-1.5 text-xs font-medium"
        style={{ color: certificate.authorized ? 'var(--status-2xx)' : 'var(--status-4xx)' }}
      >
        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: 'currentColor' }} />
        {certificate.authorized ? 'Verified' : `Not verified — ${certificate.authorizationError ?? 'unknown reason'}`}
      </div>

      {certificate.fromReusedConnection && (
        <p className="mb-3 text-xs text-[var(--muted)]">
          From this connection's original handshake — a reused keep-alive connection doesn't re-handshake per request.
        </p>
      )}

      <dl className="space-y-2 font-mono-ui text-xs">
        <CertificateField label="Subject" value={certificate.subject} />
        <CertificateField label="Issuer" value={certificate.issuer} />
        <CertificateField label="Valid from" value={certificate.validFrom} />
        <CertificateField label="Valid to" value={certificate.validTo} />
        {certificate.subjectAltName && (
          <CertificateField label="Subject Alt Names" value={certificate.subjectAltName} />
        )}
        <CertificateField label="SHA-256 Fingerprint" value={certificate.fingerprint256} />
      </dl>
    </div>
  );
}

function CertificateField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-36 shrink-0 break-all text-[var(--muted)]">{label}</dt>
      <dd className="min-w-0 break-all">{value}</dd>
    </div>
  );
}
