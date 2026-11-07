---
name: detour-live-probe
description: Launch Detour in a temporary live process on dynamic/isolated ports to reproduce bugs, test proxies, verify WebSocket upgrades, and observe real network behavior safely. Trigger when the user asks to reproduce a bug in a live process, test live traffic with curl/WebSocket, probe real proxy behavior, or "実プロセスで再現/検証".
---

# Detour Live Probe

Run Detour as a live background process on dedicated, non-conflicting ports to safely reproduce issues (such as #205, #206), inspect active connections, and test client traffic.

## 1. Prerequisites and Build

Before launching, build the CLI executable:
```bash
npm run build:cli
```

> [!NOTE]
> When running inside a git worktree, ensure `node_modules` is linked and `DETOUR_WEB_DIST_DIR` points to the built dashboard:
> ```bash
> ln -s ../../node_modules node_modules 2>/dev/null || true
> export DETOUR_WEB_DIST_DIR="$(pwd)/web-dist"
> ```

## 2. Choosing Ephemeral Ports

Always use dynamic, non-default ports to prevent port conflicts with running dev instances:
```bash
PROXY_PORT=$((20000 + RANDOM % 10000))
DASH_PORT=$((PROXY_PORT + 1))
CONTROL_PORT=$((PROXY_PORT + 2))
```

## 3. Starting Detour in Background

Launch Detour with `--foreground` and `--no-open` to avoid popping up browser windows, redirecting stdout/stderr to a log file:
```bash
LOG_FILE="/tmp/detour-probe-${PROXY_PORT}.log"
node bin/detour.js start \
  -p "$PROXY_PORT" \
  --dashboard-port "$DASH_PORT" \
  --control-port "$CONTROL_PORT" \
  --foreground \
  --no-open > "$LOG_FILE" 2>&1 &
DETOUR_PID=$!

echo "Detour started with PID $DETOUR_PID, logging to $LOG_FILE"
```

Wait until the process outputs the readiness banner:
```bash
for i in $(seq 1 30); do
  if grep -q "Proxy listening" "$LOG_FILE" 2>/dev/null || grep -q "DETOUR_READY" "$LOG_FILE" 2>/dev/null; then
    echo "Detour is ready on proxy port $PROXY_PORT"
    break
  fi
  sleep 0.2
done
```

## 4. Probing Traffic

### Plain HTTP Proxying
```bash
curl -sv -x "http://127.0.0.1:${PROXY_PORT}" "http://httpbin.org/get"
```

### HTTPS Proxying (with Detour CA)
```bash
# Export the CA certificate if not already present:
CA_CERT="/tmp/detour-ca-${PROXY_PORT}.pem"
node bin/detour.js cert export > "$CA_CERT"

curl -sv -x "http://127.0.0.1:${PROXY_PORT}" --cacert "$CA_CERT" "https://httpbin.org/get"
```

### WebSocket Upgrade & Keep-Alive Probing (e.g. Issue #206)
Send a raw HTTP Upgrade request using Node to test upstream socket handling and disconnect behavior:
```bash
node -e '
const net = require("net");
const sock = net.connect({ host: "127.0.0.1", port: process.env.PROXY_PORT }, () => {
  sock.write("GET http://echo.websocket.events/ HTTP/1.1\r\n" +
             "Host: echo.websocket.events\r\n" +
             "Upgrade: websocket\r\n" +
             "Connection: Upgrade\r\n" +
             "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
             "Sec-WebSocket-Version: 13\r\n\r\n");
});
sock.on("data", (chunk) => {
  console.log("Received:\n" + chunk.toString());
  sock.end();
});
'
```

### Inspecting Sockets and File Descriptors
Check open sockets for leaks using `lsof`:
```bash
lsof -iTCP:"$PROXY_PORT" -sTCP:LISTEN
lsof -p "$DETOUR_PID" | grep TCP
```

## 5. Teardown and Cleanup

Always clean up the spawned background process and temp files:
```bash
if [ -n "$DETOUR_PID" ]; then
  kill -TERM "$DETOUR_PID" 2>/dev/null || true
  # Wait up to 5s for graceful shutdown
  for i in $(seq 1 25); do
    kill -0 "$DETOUR_PID" 2>/dev/null || break
    sleep 0.2
  done
  # Force kill if still lingering
  kill -9 "$DETOUR_PID" 2>/dev/null || true
fi

# Verify port is free
if lsof -iTCP:"$PROXY_PORT" >/dev/null 2>&1; then
  echo "Warning: Port $PROXY_PORT is still in use"
else
  echo "Port $PROXY_PORT released successfully"
fi

rm -f "$LOG_FILE" "$CA_CERT" 2>/dev/null || true
```
