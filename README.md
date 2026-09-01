# Detour
A terminal-first, lightweight HTTP debugging proxy for mobile and web. A modern CLI alternative to Charles Proxy with real-time web dashboard.

## Getting Started

```bash
npm install
npm run build
npm start -- start --port 8080 --dashboard-port 4040
```

`npm start --` は `detour` コマンド（`bin/detour.js`）を実行します。グローバルインストールした場合は `detour start` で同じことができます。

- `--port <number>`: プロキシがリッスンするポート（デフォルト: `8080`）
- `--dashboard-port <number>`: Webダッシュボード用に予約するポート（デフォルト: `4040`。ダッシュボード自体は未実装で、今後の issue で追加予定）

初回起動時にローカルCAのルート証明書が `~/.detour/certs/certs/ca.pem` に自動生成されます。HTTPSトラフィックを復号するには、対象のブラウザ/OS/端末にこの証明書を信頼済みルート証明書としてインストールしてください。

起動後、`--port` で指定したポートを HTTP/HTTPS プロキシとして指定すれば（例: `curl -x http://localhost:8080 https://example.com`、または対象デバイスのWi-Fiプロキシ設定）、通過したリクエストがコンソールにログ出力されます。

開発時は `npm run dev` でTypeScriptをウォッチ実行できます。

### 既知の注意点
- `http-mitm-proxy@1.1.0` にはmacOS/BSD環境でHTTPS(CONNECT)トンネルが `ECONNREFUSED` になるバグがあり（内部で接続先ホストを `0.0.0.0` に決め打ちしているため）、`patches/http-mitm-proxy+1.1.0.patch`（`patch-package` 経由、`npm install` 時に自動適用）で修正しています。

# 雑メモ
## 想定コマンド集

detour start
detour start --detach
detour status
detour stop
detour stop --cleanup : 停止＋setupの取り消し
detour view <file> : Viewer起動
detour setup
detour cleanup
detour doctor
detour settings
detour rules init
detour rules edit
detour rules validate
detour rules use
detour session save/load/list
detour cert export

## startの主なオプション
--detach
--rules <path>
--port <number>
--ui-port <number>
--ui-lan : DashboardをLAN公開
--no-open
--no-ui
--headless
--exit-on-idle
--fail-on-running
--dump <level>

## セットアップ
detour setup --target android 的な
