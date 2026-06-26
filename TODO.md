# Mobile AI Companion TODO

This file tracks near-term optimization ideas for the mobile Obsidian plugin.
Keep items concrete enough that we can pick one, implement it, test it, and mark it done.

## Priority 0 - Current Mobile Polish

- [ ] Verify the v0.1.25 chat layout on Android: user bubble contrast, assistant Markdown density, composer height, and header buttons.
- [ ] Tune Markdown spacing again after real mobile screenshots if headings, lists, or blockquotes still occupy too much vertical space.
- [ ] Confirm the clear-current-chat action is easy to understand and not too close to other destructive-looking buttons.
- [ ] Check whether the fullscreen overlay needs an explicit close/back affordance beyond the current minimize icon.

## Priority 1 - Chat Experience

- [ ] Add a lightweight message timestamp or status marker only if it does not add visual noise.
- [ ] Add "retry last message" for failed requests so users do not need to retype after transient network errors.
- [ ] Add "edit and resend" for the last user message.
- [ ] Improve empty-state copy so first use clearly suggests asking about the current note or adding context.
- [ ] Consider grouping tool-call chips behind a compact disclosure when there are many calls.

## Priority 1 - Context Control

- [ ] Add a compact context budget indicator before sending, such as used characters / configured maximum.
- [ ] Let users quickly remove all current attachments from the composer.
- [ ] Add a "current note summary only" context mode for long files to reduce token usage.
- [ ] Make `@file` suggestions easier to tap on narrow mobile screens.

## Priority 1 - Provider And Settings

- [ ] Add a provider duplicate action for quickly creating a variant with another model or Base URL.
- [ ] Add clearer validation for Base URL, especially trailing `/v1`, `/responses`, and `/chat/completions`.
- [ ] Add a visible stream compatibility hint near the streaming toggle when direct SSE is selected.
- [ ] Make settings test buttons report short success details without overflowing on mobile.

## Priority 2 - Streaming And Diagnostics

- [ ] Show first-token latency and total generation time in debug details.
- [ ] Distinguish CORS/preflight failure, DNS failure, timeout, and upstream HTTP error more directly in user-facing messages.
- [ ] Add a copy-debug button for failed requests.
- [ ] Keep direct SSE as the default path, with WebSocket bridge documented as the fallback.

## Priority 2 - File Tools Safety

- [ ] Add a confirmation step before `write_file` overwrites a non-active file.
- [ ] Add a simple diff preview for destructive file edits.
- [ ] Add a max write size guard so accidental large overwrites require confirmation.
- [ ] Improve tool-call result display for failed file operations.

## Priority 3 - Code Health

- [ ] Split `ChatView.ts` into smaller pieces once UI behavior settles.
- [ ] Split `OpenAICompatibleProvider.ts` into transport, request body, and SSE parsing modules.
- [ ] Add focused tests for SSE parsing and tool-call accumulation.
- [ ] Add a release checklist covering version files, build assets, tag, GitHub release, and BRAT update verification.

## Done

- [x] Add global "clear all chat history" in settings.
- [x] Add current-chat clear action in the chat header.
- [x] Make the common models textarea wider than the cleanup button.
- [x] Tighten assistant Markdown spacing for mobile reading density.
- [x] Add subtle visual distinction between user messages and assistant replies.
