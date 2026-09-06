import type { SetupTarget } from './targets';

/** Everything the instruction text below needs to fill in — never inferred internally so the same text stays reusable from `detour setup` (no target), a `--target` run's manual fallback, and `doctor`'s guidance. */
export interface InstructionContext {
  /** Path to the CA cert on this machine, from `ensureCaCert()`. */
  certPath: string;
  /** Address the target should point its HTTP/HTTPS proxy at — `localhost` for a target that *is* this machine, this machine's LAN IP for a separate device (see `usecase/setup/proxyAddress.ts`). */
  proxyHost: string;
  proxyPort: number;
}

/**
 * The two manual steps every target needs, kept as separate named fields
 * (not a `string[]`, which `usecase/setup/manualSteps.ts` used to index
 * positionally) specifically so `cleanup` can print only `proxyConfig` —
 * `cleanup` never touches CA cert trust (matching every automated target's
 * cleanup behavior), so showing `certTrust` there read as an "Undo
 * manually: Trust the CA cert: ..." instruction that contradicted that.
 */
export interface ManualInstructions {
  certTrust: string;
  proxyConfig: string;
}

/**
 * Manual, human-followed setup steps for `target` — the `detour setup`
 * (no `--target`) "announce" output, and what a `--target` run falls back
 * to for targets `TARGET_AUTOMATION` marks as not automated (ios, windows)
 * or where the host platform doesn't match (issue #65).
 */
export function manualSetupInstructions(target: SetupTarget, ctx: InstructionContext): ManualInstructions {
  switch (target) {
    case 'mac':
      return {
        certTrust: `Trust the CA cert: double-click ${ctx.certPath} to add it to Keychain Access, open it there, expand "Trust", and set "When using this certificate" to "Always Trust".`,
        proxyConfig: `Configure the proxy: System Settings → Wi-Fi → Details → Proxies, enable "Web Proxy (HTTP)" and "Secure Web Proxy (HTTPS)", and set both to ${ctx.proxyHost} / ${ctx.proxyPort}.`,
      };
    case 'windows':
      return {
        certTrust: `Trust the CA cert: ${ctx.certPath} → certmgr.msc → Trusted Root Certification Authorities → Certificates → right-click → All Tasks → Import… and select the file.`,
        proxyConfig: `Configure the proxy: Settings → Network & Internet → Proxy → Manual proxy setup, set the address/port to ${ctx.proxyHost} / ${ctx.proxyPort}.`,
      };
    case 'ios':
      return {
        certTrust: `Trust the CA cert: AirDrop or email ${ctx.certPath} to the device and install the profile via Settings → General → VPN & Device Management, then separately enable it under Settings → General → About → Certificate Trust Settings (installing alone leaves it untrusted for TLS).`,
        proxyConfig: `Configure the proxy: Settings → Wi-Fi → (i) next to your network → Configure Proxy → Manual, and set Server/Port to ${ctx.proxyHost} / ${ctx.proxyPort}.`,
      };
    case 'android':
      return {
        certTrust: `Trust the CA cert: copy ${ctx.certPath} to the device, then Settings → Security → Encryption & credentials → Install a certificate → CA certificate. Since Android 7 (API 24), apps that don't opt into user-added CAs via a network_security_config still won't show decrypted traffic even once installed — a rooted device installing it into the system store instead is the more reliable path for those.`,
        proxyConfig: `Configure the proxy: Settings → Wi-Fi → long-press your network → Modify network → Advanced options → Proxy → Manual, and set Hostname/Port to ${ctx.proxyHost} / ${ctx.proxyPort}.`,
      };
    case 'linux':
      return {
        certTrust: `Trust the CA cert (Debian/Ubuntu): sudo cp ${ctx.certPath} /usr/local/share/ca-certificates/detour-ca.crt && sudo update-ca-certificates`,
        proxyConfig: `Configure the proxy: Settings → Network → Network Proxy, set it to Manual, and set the HTTP and HTTPS proxy to ${ctx.proxyHost} / ${ctx.proxyPort}.`,
      };
  }
}
