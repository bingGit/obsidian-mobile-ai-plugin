# Changelog

All notable changes to Mobile AI Companion are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.22] - 2026-06-25

### Changed (mobile chat UI rework)
- **User / AI message distinction by background tint, not text label.** Removed the "你" / "AI" role label div from `renderMessages`. Each message is now wrapped in a `.mobile-ai-message-inner` block; user messages get a subtle `var(--background-secondary)` background, assistant messages stay on the default background. No more reading "AI said this, you said that" — the colored block itself is the cue.
- **Compact composer.** The four-button bottom toolbar (current file / selection / send / stop) is gone. Replaced with a single row: `[paperclip] [textarea, auto-grow] [send]`. The paperclip opens a small popover above it containing the two attachment options ("添加当前文件" / "添加选中文本"). Send and stop still toggle based on `this.sending`.
- **Auto-resize textarea.** The input starts at one line of height (`min-height: 38px`), grows with the content as the user types, and stops at `max-height: 30vh` (with internal scrollbar if exceeded). `resize: vertical` is gone — auto-grow handles it.
- **Fullscreen button** in the header (`maximize-2` icon). On mobile it walks up the leaf's parent chain looking for a `WorkspaceMobileDrawer` / `WorkspaceSidedock` and calls `expand()` on it, so a previously collapsed right drawer is re-expanded to fullscreen. On desktop the button is currently a no-op (popping the chat out to its own workspace window would also need to thread `sessionId` through the leaf state — separate piece of work if you want it).
- **`user-select: text` is now explicit** on `.mobile-ai-message`, `.mobile-ai-message-inner`, `.mobile-ai-message-content`, `.mobile-ai-message-context`, and `.mobile-ai-warning`. Mobile webviews can occasionally inherit a `user-select: none` from the host theme; this forces selection to work on every part of both user and assistant messages, so a specific sentence can be long-pressed and copied without having to copy the whole message.

## [0.1.23] - 2026-06-26

### Fixed
- **Fullscreen button in the header was a no-op** when the chat leaf was not directly inside a `WorkspaceMobileDrawer` — e.g. when an older `v0.1.20` chat leaf survived a BRAT upgrade in an orphan tab. The previous implementation walked up `leaf.parent` looking for something with `expand()` / `collapsed`; for those orphan tabs the walk silently fell through to `activateChatView`, which re-created the leaf in the right side without affecting the leaf the user was actually looking at, so the click appeared to do nothing.
- `openFullscreen` now drives `app.workspace.rightSplit` directly (always present on mobile as a `WorkspaceMobileDrawer`, on desktop as a `WorkspaceSidedock`), then calls `revealLeaf(this.leaf)`, and only as a last resort re-runs `ensureSideLeaf` when the current leaf is provably not in the right split. A `[mobile-ai] fullscreen click` dev-console log line exposes the state of `rightSplit` and the leaf's parent constructor name so the next "button does nothing" case is one console line away from diagnosed.

## [Unreleased]

## [0.1.25] - 2026-06-26

### Added
- Added a settings action to clear all saved chat history without touching provider/model/API key settings.
- Added a chat header action to clear only the current chat page history.

### Changed
- Tightened assistant Markdown spacing for mobile reading density while preserving line breaks during active streaming.
- User messages now have a subtle tinted bubble and border so sent content is easier to distinguish from AI replies in the chat flow.

## [0.1.24] - 2026-06-26

### Changed
- Reworked the mobile composer into a larger embedded input panel: the textarea now owns the vertical space, with attachment, stop, and send controls tucked into the panel footer.
- Made provider action buttons wrap into a mobile-friendly grid so the settings page no longer clips the bottom operation row.

### Fixed
- Fullscreen is now controlled by the plugin itself as a fixed overlay, so tapping the header button has an immediate visible effect instead of depending on Obsidian drawer internals.
- Provider name edits no longer re-render and collapse the provider details section on every keystroke.
- Fixed TypeScript errors in the function-calling stream path that esbuild did not catch, including the tool-call chip renderer referencing an out-of-scope `innerEl` variable.
- Normalized direct, XHR, and WebSocket stream results to return `{ content, toolCalls }`, so chat-completions tool calls survive every streaming transport consistently.

## [0.1.21] - 2026-06-25

### Changed
- Chat view now opens in the right side panel on desktop and the right swipe drawer on mobile, so on mobile the user can summon it with the same right-swipe gesture that reveals the outline and backlinks, instead of the ribbon or a bottom tab.
- `activateChatView` rewritten on top of the Obsidian 1.7.2 API `Workspace.ensureSideLeaf(VIEW_TYPE_CHAT, "right", { active: true, reveal: true })`. The previous `getExistingChatLeaf` / `getPreferredLeaf` helpers and their `Platform.isMobile` / `WorkspaceMobileDrawer` branching are gone; the framework now handles "find existing vs create new" leaf discovery.
- `minAppVersion` bumped to **1.7.2** (was 1.5.0) to match the new API.

### Notes
- Users upgrading from <=0.1.20 may briefly see a leftover chat tab from the old "tab" leaf. It is detached the next time the plugin reloads (`onunload` runs `detachLeavesOfType`), or can be closed manually from the tab bar.

## [0.1.20] - 2026-06-25

### Fixed
- Chat view silently failing to open (ribbon click appears as a no-op) when the view instance is destroyed and recreated, e.g. on Obsidian mobile when navigating away from the chat tab and back, or after a plugin reload. The cause was `render()` reading `this.containerEl.children[1]` — a structure the Obsidian framework does not actually guarantee for `ItemView`. The new view's `containerEl` had zero children, so `containerEl.empty()` threw `TypeError: Cannot read properties of undefined (reading 'empty')` and the error was swallowed by the async ribbon callback.
- `render()` now uses `this.contentEl` (the framework-provided content element of `ItemView`, guaranteed to exist) instead of the brittle `containerEl.children[1]` access. Works for both fresh instances and reused ones.

### Changed
- `onOpen` wraps `ensureSession` + `render` in `try/catch` and surfaces a `Notice` (plus a `[mobile-ai] onOpen failed` console error) if anything in the view-initialization path throws. The next "silent failure" will at least tell the user what went wrong.

## [0.1.19] - 2026-06-25

### Fixed
- AI response rendered as duplicated text when running through the WebSocket bridge. Some relay servers forward each upstream SSE chunk as a `delta` event and then put the entire assembled response in the `done` message's `text` field. The bridge client was doing `content += tail` and forwarding `tail` via `onDelta`, so the user-visible assistant message ended up as streamed-text + full-text appended again. Visible as the chat panel rendering the reply once during streaming, then a duplicated copy after the stream closes (or both copies during streaming if the bridge sent a long tail).
- `StreamBridgeClient.stream` is now defensive about `done.text`: if any `delta` events came in, the delta stream is treated as authoritative and `done.text` is ignored; if no deltas came in, `done.text` is used as the full response (older single-shot bridges still work).

### Changed
- Added a `[mobile-ai] bridge stream` dev-console log line reporting `deltaCount`, `deltaTextLengthSum`, `doneTextLength`, and `finalContentLength` so the next time the bridge misbehaves, the dev console shows its actual behavior at a glance.

## [0.1.18] - 2026-06-25

### Fixed
- Function calling silently failed through the WebSocket bridge. v0.1.17 wired tools in `ChatController` and added the tool schemas, but the bridge path dropped `tool_calls` in two places — `StreamBridgeClient.stream()` resolved with a hard-coded `toolCalls: []` and the `done` protocol message had no field for it, and `OpenAICompatibleProvider.streamChat()`'s bridge branch returned only `{ content }`. As a result the model never saw the tool calls come back and fell back to text answers like "I don't have write permission".

### Added
- Bridge protocol: `done` messages may now carry a `tool_calls` array (aggregated by the bridge server from the upstream `delta.tool_calls` stream). The plugin client is forward-compatible with old bridge servers that don't return it.
- A `[mobile-ai] bridge result` dev-console log line in the bridge branch reporting `hasTools`, `toolCount`, `toolCallCount`, and `toolNames` so the next "AI says no permission" debug cycle is cheap.

### Notes (bridge server requirement)
To make function calling actually work, the relay/bridge server also needs to:
1. Forward the `tools` field from the plugin's `start` payload into the upstream `chat/completions` request body.
2. Aggregate `choices[0].delta.tool_calls` by `index` from the upstream SSE stream and include the final `tool_calls` array in the `done` message sent back to the plugin.

Without those changes, the model still can't write files even with v0.1.18.

## [0.1.17] - 2026-06-25

### Added (function calling, phase 1)
- `Tool` / `ToolCall` types in `src/providers/types.ts`. `ChatMessage` got `tool_calls` / `tool_call_id` / `name`. `ChatRequest` got `tools` / `tool_choice`. `ChatResponse` got `toolCalls`. `ChatRole` got `"tool"`.
- `OpenAICompatibleProvider`: stream parser now accumulates `tool_calls` by index (verified with a reproducer for both serial and parallel tool calls). Request body includes `tools` when present. Non-streaming `sendChat` also reads `tool_calls`.
- `StreamBridgeClient`: return shape synced to `{ content, toolCalls }`. `tools` field forwarded in payload.
- New `src/tools/noteTools.ts` with three tools, each carrying a JSON Schema plus an Obsidian-vault executor:
  - `read_file(path)` — read any Markdown file in the vault.
  - `write_file(path, content)` — overwrite a file. Uses `editor.setValue()` when the target is the active view so undo (Cmd+Z) still works.
  - `append_to_file(path, content)` — append content, separated by a blank line if the file does not already end with one.
  - `path = "."` means the active `MarkdownView` file.
- `ChatController`: `MAX_TOOL_ITERATIONS = 5`. After each response, if there are `tool_calls`, append an assistant message with `tool_calls` plus one `role: "tool"` message per call, then re-send. `onToolCall` callback wired so the view can update incrementally. Serial execution within one response. System prompt now names the active file path so the AI knows what `"."` refers to.
- `ChatView`: threads `onToolCall` callback that pushes a `{ name, summary, ok }` record onto `assistantMessage.toolCalls`. New `renderToolCalls()` shows one chip per invocation above the four action buttons.
- `ChatStore`: `SessionMessage` got `toolCalls?: SessionToolCall[]` for persistence across reloads.
- `styles.css`: `.mobile-ai-message-toolcall*` chip styling (rounded pill, success / failure variants, monospace-friendly).

### Fixed
- Model list was being polluted with every keystroke of the default model name while the user was still typing it in the picker.

### Changed
- Chat message vertical spacing tightened.
- Chat content is now contained inside the panel so it no longer overflows horizontally on mobile.

[Unreleased]: https://github.com/bingGit/obsidian-mobile-ai-plugin/compare/v0.1.25...HEAD
[0.1.25]: https://github.com/bingGit/obsidian-mobile-ai-plugin/compare/v0.1.24...v0.1.25
[0.1.24]: https://github.com/bingGit/obsidian-mobile-ai-plugin/compare/v0.1.23...v0.1.24
[0.1.23]: https://github.com/bingGit/obsidian-mobile-ai-plugin/compare/v0.1.22...v0.1.23
[0.1.22]: https://github.com/bingGit/obsidian-mobile-ai-plugin/compare/v0.1.21...v0.1.22
[0.1.21]: https://github.com/bingGit/obsidian-mobile-ai-plugin/compare/v0.1.20...v0.1.21
[0.1.20]: https://github.com/bingGit/obsidian-mobile-ai-plugin/compare/v0.1.19...v0.1.20
[0.1.19]: https://github.com/bingGit/obsidian-mobile-ai-plugin/compare/v0.1.18...v0.1.19
[0.1.18]: https://github.com/bingGit/obsidian-mobile-ai-plugin/compare/v0.1.17...v0.1.18
[0.1.17]: https://github.com/bingGit/obsidian-mobile-ai-plugin/releases/tag/v0.1.17
