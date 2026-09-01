import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { DetourEventBus } from './eventBus';
import { logExchange, logProxyError } from './logger';
import { startProxyServer } from './proxyServer';
import { loadRulesFile } from './rules/loader';
import { RuleEngine } from './rules/ruleEngine';
import { SAMPLE_RULES_FILE } from './rules/sample';
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
  rules?: string;
}

async function runStart(options: StartOptions): Promise<void> {
  const port = parsePort(options.port, '--port');
  const dashboardPort = parsePort(options.dashboardPort, '--dashboard-port');

  const eventBus = new DetourEventBus();
  eventBus.on('response', logExchange);
  eventBus.on('error', logProxyError);
  eventBus.on('rulesReloaded', ({ filePath, ruleCount }) => {
    console.log(`↻ ルールを再読み込みしました（${ruleCount}件）: ${filePath}`);
  });

  let ruleEngine: RuleEngine | undefined;
  if (options.rules) {
    // Load eagerly so a broken rules.json fails CLI startup with a clear
    // error, rather than the proxy silently starting without any rules.
    ruleEngine = RuleEngine.load({
      filePath: options.rules,
      onReload: (info) => eventBus.emit('rulesReloaded', { filePath: ruleEngine!.filePath, ruleCount: info.ruleCount }),
      onReloadError: (message) =>
        eventBus.emit('error', { errorKind: 'RULES_RELOAD_ERROR', message }),
    });
  }

  const handle = await startProxyServer({ port, ruleEngine }, eventBus);

  console.log(`Detour プロキシを起動しました → http://localhost:${handle.port}`);
  console.log(`ルートCA証明書: ${handle.caCertPath}`);
  console.log('  HTTPSを復号するには、このCA証明書を対象デバイス/ブラウザに信頼済みとしてインストールしてください。');
  console.log(
    `ダッシュボード用ポート ${dashboardPort} を予約しました（ダッシュボード自体は未実装。今後の issue で追加予定）。`,
  );
  if (ruleEngine) {
    console.log(`ルールファイル: ${ruleEngine.filePath}（${ruleEngine.getRules().length}件のルールを読み込み、変更を監視中）`);
  }
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
    .option('--rules <path>', 'rules.json のパス。指定するとmock/route/rewriteルールを適用し、変更を監視して自動反映します')
    .action(async (options: StartOptions) => {
      try {
        await runStart(options);
      } catch (err) {
        console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  const rules = program.command('rules').description('rules.json（宣言型ルールエンジン設定）の管理');

  rules
    .command('validate <path>')
    .description('rules.json のスキーマ・整合性を検証します')
    .action((rulesPath: string) => {
      try {
        const { rules: loaded } = loadRulesFile(path.resolve(rulesPath));
        console.log(`✔ ${rulesPath} は妥当です（${loaded.length}件のルール）`);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  rules
    .command('init [path]')
    .description('サンプルの rules.json を作成します')
    .action((rulesPath = 'rules.json') => {
      const dest = path.resolve(rulesPath);
      if (fs.existsSync(dest)) {
        console.error(`✖ 既に存在します: ${dest}`);
        process.exitCode = 1;
        return;
      }
      fs.writeFileSync(dest, SAMPLE_RULES_FILE);
      console.log(`✔ サンプルルールを作成しました: ${dest}`);
    });

  return program;
}
