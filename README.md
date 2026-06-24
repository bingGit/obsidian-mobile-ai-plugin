# Mobile AI Companion

Mobile AI Companion is a mobile-first Obsidian plugin prototype for chatting with OpenAI-compatible model APIs inside a vault.

The plugin is designed around the requirements in [docs/obsidian-mobile-ai-plugin-requirements.md](docs/obsidian-mobile-ai-plugin-requirements.md):

- configure a custom Base URL, API Key, and model list;
- chat from an Obsidian side view without local CLI dependencies;
- attach the current note, selected text, and vault Markdown files as context;
- use `@file` references for Markdown files in the vault;
- copy, insert, replace, or append AI output only after explicit user action.

This project intentionally avoids shell execution, local agents, MCP stdio servers, and vault-wide automatic uploads so it can fit the Obsidian mobile plugin environment.

## Development

```bash
npm install
npm run build
```

The build outputs `main.js`, which is intentionally ignored by Git.
