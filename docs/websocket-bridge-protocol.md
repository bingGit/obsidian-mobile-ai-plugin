# WebSocket Bridge Protocol

This document describes the minimal bridge protocol used by `Mobile AI Companion` when a provider chooses `WebSocket bridge` as its streaming transport.

## Why this exists

On Obsidian mobile, direct SSE streaming may fail even when the upstream model endpoint itself supports streaming.
The bridge moves the upstream streaming request to a server-side environment with a more reliable network stack, then forwards token deltas back to the mobile plugin over WebSocket.

## Connection model

1. The plugin opens a WebSocket connection to `bridgeUrl`.
2. After `open`, the plugin sends one `start` message.
3. The bridge may send `status` messages at any time.
4. The bridge sends zero or more `delta` messages.
5. The bridge finishes with either:
   - `done`
   - `error`

## Client -> bridge

```json
{
  "type": "start",
  "auth": {
    "type": "bearer",
    "token": "optional-bridge-token"
  },
  "request": {
    "apiFormat": "responses",
    "baseUrl": "https://token.malong.fun/v1",
    "apiKey": "sk-...",
    "model": "gpt-5.5",
    "temperature": 0.7,
    "maxTokens": 2048,
    "timeoutMs": 120000,
    "messages": [
      {
        "role": "system",
        "content": "You are an AI assistant inside Obsidian mobile."
      },
      {
        "role": "user",
        "content": "Hello"
      }
    ]
  }
}
```

Notes:

- `auth` is optional.
- `baseUrl` is stored exactly as configured in the plugin.
- `apiKey` is forwarded to the bridge, so the bridge must be trusted.
- `maxTokens` maps to:
  - `max_tokens` for `/chat/completions`
  - `max_output_tokens` for `/responses`

## Bridge -> client

### `status`

```json
{
  "type": "status",
  "message": "Bridge connected to upstream"
}
```

### `delta`

```json
{
  "type": "delta",
  "text": "partial token text"
}
```

### `done`

```json
{
  "type": "done",
  "text": ""
}
```

`text` is optional on `done`. It exists only if the bridge has a final tail fragment to flush.

### `error`

```json
{
  "type": "error",
  "message": "Upstream stream failed",
  "code": "upstream_stream_failed",
  "details": {
    "status": 502,
    "channel": "fetch"
  }
}
```

## Upstream mapping

### Responses API

The bridge should call:

- `POST {baseUrl}/responses` if `baseUrl` does not already end with `/responses`
- otherwise call `baseUrl` directly

Recommended request body:

```json
{
  "model": "gpt-5.5",
  "instructions": "joined system messages",
  "input": [
    {
      "role": "user",
      "content": "hello"
    }
  ],
  "temperature": 0.7,
  "max_output_tokens": 2048,
  "stream": true
}
```

Forward token text for events such as:

- `response.output_text.delta`
- `output_text.delta`

### Chat Completions API

The bridge should call:

- `POST {baseUrl}/chat/completions` if `baseUrl` does not already end with `/chat/completions`
- otherwise call `baseUrl` directly

Recommended request body:

```json
{
  "model": "gpt-5.5",
  "messages": [
    {
      "role": "system",
      "content": "..."
    },
    {
      "role": "user",
      "content": "..."
    }
  ],
  "temperature": 0.7,
  "max_tokens": 2048,
  "stream": true
}
```

Forward token text from `choices[0].delta.content`.

## Trust and security

- The bridge receives the model `apiKey`.
- Only deploy the bridge to an environment you control.
- Protect the bridge with at least one of:
  - bearer token
  - IP allowlist
  - private network/VPN
  - short-lived signed session token

## Operational guidance

- Keep the bridge stateless.
- Log upstream status code, content type, and the last event type.
- Add heartbeat/status messages if upstream responses are long-running.
- Enforce a per-request timeout slightly above the plugin timeout.
