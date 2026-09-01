# Detour
A terminal-first, lightweight HTTP debugging proxy for mobile and web. A modern CLI alternative to Charles Proxy with real-time web dashboard.

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
