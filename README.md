# Mobile AI Companion

Mobile AI Companion is a mobile-first Obsidian plugin for chatting with OpenAI-compatible model APIs inside a vault.

The plugin is designed around the requirements in [docs/obsidian-mobile-ai-plugin-requirements.md](docs/obsidian-mobile-ai-plugin-requirements.md):

- configure a custom Base URL, API Key, and model list;
- chat from an Obsidian side view without local CLI dependencies;
- attach the current note, selected text, and vault Markdown files as context;
- use `@file` references for Markdown files in the vault;
- copy, insert, replace, or append AI output only after explicit user action.

This project intentionally avoids shell execution, local agents, MCP stdio servers, and vault-wide automatic uploads so it can fit the Obsidian mobile plugin environment.

## Streaming transports

The plugin supports two streaming transports for chat:

1. **Direct SSE** (default) — the plugin opens a streaming HTTP request from the device to your provider. This is the recommended path on Obsidian mobile as long as the proxy in front of the upstream returns a single matching `Access-Control-Allow-Origin` header.
2. **WebSocket bridge** — the plugin sends the request to a small bridge server, which opens the streaming HTTP request on its behalf and forwards token deltas back. Use this as a fallback when the proxy chain cannot be made CORS-clean (third-party gateways, restricted networks, etc.).

The most common reason direct streaming fails on mobile is **CORS**, not SSE itself: Obsidian's `requestUrl()` (used for non-streaming) bypasses the WebView CORS checks, but the `fetch` used for streaming does not. See [docs/mobile-streaming-troubleshooting.md](docs/mobile-streaming-troubleshooting.md) for the diagnosis, the nginx + CLIProxyAPI fix recipe, and a curl sanity check.

References:

- mobile CORS troubleshooting: [docs/mobile-streaming-troubleshooting.md](docs/mobile-streaming-troubleshooting.md)
- bridge protocol: [docs/websocket-bridge-protocol.md](docs/websocket-bridge-protocol.md)
- runnable bridge: [bridge/server.js](bridge/server.js)
- bridge setup notes: [bridge/README.md](bridge/README.md)

## Development

```bash
npm install
npm run build
```

The build outputs `main.js`, which is intentionally ignored by Git.
