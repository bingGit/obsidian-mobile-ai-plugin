# Mobile AI Companion

Mobile AI Companion is a mobile-first Obsidian plugin prototype for chatting with OpenAI-compatible model APIs inside a vault.

The plugin is designed around the requirements in [docs/obsidian-mobile-ai-plugin-requirements.md](docs/obsidian-mobile-ai-plugin-requirements.md):

- configure a custom Base URL, API Key, and model list;
- chat from an Obsidian side view without local CLI dependencies;
- attach the current note, selected text, and vault Markdown files as context;
- use `@file` references for Markdown files in the vault;
- copy, insert, replace, or append AI output only after explicit user action.

This project intentionally avoids shell execution, local agents, MCP stdio servers, and vault-wide automatic uploads so it can fit the Obsidian mobile plugin environment.

## Streaming Bridge

Direct SSE streaming on Obsidian mobile can fail even when the upstream provider itself supports streaming.
This repo now includes a minimal `WebSocket bridge` skeleton so the plugin can forward chat requests to a trusted bridge server and receive token deltas back over WebSocket.

References:

- protocol: [docs/websocket-bridge-protocol.md](docs/websocket-bridge-protocol.md)
- server skeleton: [docs/websocket-bridge-minimal-server.js](docs/websocket-bridge-minimal-server.js)

## Development

```bash
npm install
npm run build
```

The build outputs `main.js`, which is intentionally ignored by Git.
