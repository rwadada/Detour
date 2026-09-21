import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { ensureCaCert, regenerateCaCert } from '../infra/proxy/certExport';

/** Wires `detour cert export` into the CLI. */
export function registerCertCommand(program: Command): void {
  const cert = program
    .command('cert')
    .description('Manage the local root CA certificate used to decrypt HTTPS traffic');

  cert
    .command('export [path]')
    .description(
      'Writes the CA certificate to <path> (or prints it to stdout if omitted) — generates it first if detour has never run on this machine before (issue #20).',
    )
    .action(async (destPath?: string) => {
      try {
        const certPath = await ensureCaCert();
        const pem = fs.readFileSync(certPath, 'utf8');
        if (!destPath) {
          process.stdout.write(pem);
          return;
        }
        const dest = path.resolve(destPath);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, pem);
        console.log(`✔ Exported CA certificate to ${dest}`);
      } catch (err) {
        console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  cert
    .command('regenerate')
    .description(
      'Replaces the local root CA with a freshly generated one, valid for 3 years (issue #164) — needed when the current CA has expired, since detour never silently re-signs it. Every device that trusted the old certificate must trust the new one (`detour setup`).',
    )
    .action(async () => {
      try {
        const certPath = await regenerateCaCert();
        console.log(`✔ Generated a new CA certificate at ${certPath}`);
        console.log(
          '  The previous CA is gone: re-install this one on every device/browser that was trusting it (`detour setup`), and restart any running `detour start`.',
        );
      } catch (err) {
        console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });
}
