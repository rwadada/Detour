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
- `--rules <path>`: `rules.json` のパス。指定するとルールに一致したリクエストへ mock/route/rewrite を適用します（後述）。ファイルの変更は自動検知して再読み込みします。省略時もカレントディレクトリに `rules.json` があれば自動的に読み込みます

初回起動時にローカルCAのルート証明書が `~/.detour/certs/certs/ca.pem` に自動生成されます。HTTPSトラフィックを復号するには、対象のブラウザ/OS/端末にこの証明書を信頼済みルート証明書としてインストールしてください。

起動後、`--port` で指定したポートを HTTP/HTTPS プロキシとして指定すれば（例: `curl -x http://localhost:8080 https://example.com`、または対象デバイスのWi-Fiプロキシ設定）、通過したリクエストがコンソールにログ出力されます。

開発時は `npm run dev` でTypeScriptをウォッチ実行できます。

## ルールエンジン（rules.json）

通信のルーティング・書き換え・モック差し替えを宣言的に定義できます。

```bash
detour rules init          # サンプルの rules.json を生成
detour rules validate rules.json  # スキーマ・整合性チェック
detour start --rules rules.json   # ルールを適用してプロキシ起動
```

`rules.json` はルールの配列で、リクエストごとに先頭から順に評価し、最初に一致した有効なルールのアクションが適用されます（後続のルールは評価されません）。

```json
{
  "rules": [
    {
      "name": "mock-users",
      "match": { "method": "GET", "url": "https://api.example.com/users/*" },
      "action": { "type": "mock", "status": 200, "body": { "id": 1, "name": "Mock User" } }
    }
  ]
}
```

- `match.url`: `*`（任意の文字列）・`?`（任意の1文字）が使えるワイルドカードパターン。`match.urlRegex`（+ 任意で`urlRegexFlags`）で正規表現によるマッチも可能（`url`と`urlRegex`はどちらか一方のみ指定）。`method`は省略時は全メソッドにマッチ
- `action.type: "mock"`: 指定したステータス・ヘッダー・Body（`body`はオブジェクト/配列ならJSON化、文字列ならそのまま送信、`bodyFile`でファイル内容を返却）を、実サーバーに接続せず即座に返します
- `action.type: "route"`: リクエストの接続先ホスト/ポートを差し替えます（`preserveHostHeader: false`でHostヘッダーも書き換え）
- `action.type: "rewrite"`: `request`/`response`それぞれで、ヘッダーの追加・削除（`headers.set`/`headers.remove`）とBodyの書き換え（`body.set`で全置換、`body.replace`で文字列/正規表現の置換）ができます

起動中に `rules.json` を編集すると自動的に再読み込みされます（検証に失敗した場合は直前の内容のまま動作を継続し、エラーをコンソールに表示します）。

リポジトリ直下の [`rules.json`](./rules.json) には mock/route/rewrite それぞれのサンプルルールを `enabled: false` の状態で用意しています。すべて無効なので `detour start`（`--rules` 未指定）で実行してもデフォルトでは何も横取りせず、素のパススルー プロキシとして動作します。動作を試すには該当ルールを `enabled: true` にするか、`detour rules init` で別のルールファイルを作成してください。

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
