import fs from 'node:fs';
import { detectInstallMethod, type InstallMethod } from '../../domain/update/installMethod';

/** How the currently running detour executable was installed (decides whether it can upgrade itself). */
export function detectCurrentInstall(): InstallMethod {
  const entry = process.argv[1];
  if (!entry) return { kind: 'unsupported' };
  try {
    return detectInstallMethod(fs.realpathSync(entry));
  } catch {
    return { kind: 'unsupported' };
  }
}
