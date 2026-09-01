import { Command } from 'commander';
import { DetourEventBus } from './eventBus';
import { logExchange, logProxyError } from './logger';
import { startProxyServer } from './proxyServer';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../package.json') as { version: string; description: string };

function parsePort(value: string, flag: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${flag} には 0〜65535 の整数を指定してください（受け取った値: ${value}）`);
  }
  return port;
}

interface StartOptions {
  port: string;
  dashboardPort: string;
}

async function runStart(options: StartOptions): Promise<void> {
  const port = parsePort(options.port, '--port');
  const dashboardPort = parsePort(options.dashboardPort, '--dashboard-port');

  const eventBus = new DetourEventBus();
  eventBus.on('response', logExchange);
  eventBus.on('error', logProxyError);

  const handle = await startProxyServer({ port }, eventBus);

  console.log(`Detour プロキシを起動しました → http://localhost:${handle.port}`);
  console.log(`ルートCA証明書: ${handle.caCertPath}`);
  console.log('  HTTPSを復号するには、このCA証明書を対象デバイス/ブラウザに信頼済みとしてインストールしてください。');
  console.log(
    `ダッシュボード用ポート ${dashboardPort} を予約しました（ダッシュボード自体は未実装。今後の issue で追加予定）。`,
  );
  console.log('Ctrl+C で終了します。');

  const shutdown = async (signal: NodeJS.Signals) => {
    console.log(`\n${signal} を受信しました。プロキシを停止しています…`);
    await handle.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

export function createCli(): Command {
  const program = new Command();

  program.name('detour').description(pkg.description).version(pkg.version);

  program
    .command('start')
    .description('MITMプロキシを起動し、HTTP/HTTPSトラフィックのキャプチャを開始します')
    .option('-p, --port <port>', 'プロキシがリッスンするポート', '8080')
    .option('--dashboard-port <port>', 'Webダッシュボード用に予約するポート（ダッシュボードは未実装）', '4040')
    .action(async (options: StartOptions) => {
      try {
        await runStart(options);
      } catch (err) {
        console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  return program;
}
