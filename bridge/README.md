# Mobile AI Bridge

This is a minimal WebSocket bridge for `Mobile AI Companion`.

It exists for one purpose: move the upstream streaming request out of Obsidian mobile's WebView network stack, then forward token deltas back to the plugin over WebSocket.

## Start

```bash
cd bridge
npm install
BRIDGE_TOKEN=your-secret-token PORT=8787 node server.js
```

Or with Docker:

```bash
cd bridge
docker build -t mobile-ai-bridge .
docker run --rm -p 8787:8787 --env-file .env.example mobile-ai-bridge
```

## Plugin settings

In the plugin provider settings:

- `流式传输` -> `WebSocket bridge`
- `Bridge URL` -> `ws://your-host:8787`
- `Bridge Token` -> same value as `BRIDGE_TOKEN`

`Base URL`, `API Key`, `接口格式`, `模型` still stay in the plugin.

## Environment variables

- `PORT`: WebSocket server port. Default `8787`.
- `HOST`: Bind host. Default `0.0.0.0`.
- `BRIDGE_TOKEN`: Optional bearer token required from the plugin.
- `UPSTREAM_TIMEOUT_MS`: Optional upstream timeout override. Default `180000`.

You can start from `.env.example` and replace `BRIDGE_TOKEN` before deployment.

## Protocol

See [../docs/websocket-bridge-protocol.md](../docs/websocket-bridge-protocol.md).

## Current scope

- supports `responses`
- supports `chat-completions`
- expects upstream SSE
- forwards `status`, `delta`, `done`, `error`

## Not production-ready yet

- no rate limiting
- no persistent auth/session layer
- no structured audit logging sink
- no reverse proxy / TLS config included

## Recommended rollout

1. Start the bridge locally and hit `http://host:8787/healthz`.
2. In the plugin, set `流式传输` to `WebSocket bridge`.
3. Fill `Bridge URL` with `ws://host:8787`.
4. Run `测试 Bridge` first.
5. Then run `测试流式`.
