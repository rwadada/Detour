import os from 'node:os';

/**
 * Every non-internal IPv4 address this machine currently has. Originally
 * the `--lan`/`lanAccess` startup banner's helper (an address another
 * device on the network can actually reach, since `localhost` resolves to
 * whatever device is asking, not this one) — reused by `detour setup`
 * (issue #65) to guess the address a separate device (Android) should
 * point its proxy at, since that's exactly the same problem.
 *
 * Order matches `os.networkInterfaces()`'s own (insertion order of the
 * underlying OS call) — not sorted or deduped further, since a machine
 * legitimately reachable at more than one address (Wi-Fi + Ethernet, a VPN)
 * should have every one of them available.
 */
export function lanAddresses(): string[] {
  const addresses: string[] = [];
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const info of iface ?? []) {
      if (info.family === 'IPv4' && !info.internal) addresses.push(info.address);
    }
  }
  return addresses;
}
