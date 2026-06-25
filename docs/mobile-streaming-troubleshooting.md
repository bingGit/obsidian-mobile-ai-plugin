# Mobile Streaming Troubleshooting

If the same provider works for non-streaming chat on Obsidian mobile but streaming fails with `Failed to fetch` and 0 bytes, the root cause is almost always **CORS** in the proxy chain, not the plugin or the upstream SSE itself.

This document explains how to confirm the diagnosis, how to fix a typical nginx + CLIProxyAPI setup, and when to fall back to the WebSocket bridge.

## Why mobile streaming breaks while non-streaming works

Obsidian mobile has two distinct network paths that the plugin uses depending on whether streaming is requested:

| Path | API used | CORS enforced |
|------|----------|---------------|
| Non-streaming chat | Obsidian's `requestUrl()` | No (uses Obsidian's native network stack) |
| Streaming chat | `fetch` / `XMLHttpRequest` in the WebView | Yes (browser-style CORS validation) |

`requestUrl()` is part of Obsidian's plugin API and is implemented in native code, so it does not run the same CORS checks that the WebView applies to `fetch`. That is why the same Base URL and API Key can answer `POST /v1/chat/completions` successfully but reject `POST /v1/responses` with `stream: true` — the WebView aborts the request before it leaves the device when the response does not carry matching `Access-Control-Allow-*` headers.

## How to confirm it is CORS

Open the plugin's debug output (mobile debug panel or the desktop "show debug message" action) and look at the streaming diagnostics block:

| Field | CORS failure signature |
|-------|------------------------|
| 流式状态码 | `(unknown)` |
| 已收字节 | `0` |
| 流式 Content-Type | `(unknown)` |
| 流式响应头 | `(unavailable)` |
| 原始错误 | `TypeError: Failed to fetch` (or `Load failed` / `Network request failed`) |

If you see this pattern on multiple attempts, the WebView is aborting the request before any HTTP status is sent back. If you instead see a real status code such as `401`, `402`, `429`, or `503`, the request did reach the server and the issue is upstream (auth, quota, rate limit, model availability), not CORS.

## Fix the proxy

If you control the proxy in front of the upstream (the common case is `nginx → CLIProxyAPI`), make sure the proxy does not emit a second `Access-Control-Allow-Origin` header and that the value matches the request `Origin`. Obsidian typically sends `Origin: http://localhost` because the WebView origin is the vault's local file host.

A minimal `location ^~ /ob/` block:

```nginx
location ^~ /ob/ {
    # Hide any CORS coming from the upstream so this block owns the response.
    proxy_hide_header Access-Control-Allow-Origin;
    proxy_hide_header Access-Control-Allow-Credentials;
    proxy_hide_header Access-Control-Allow-Headers;
    proxy_hide_header Access-Control-Allow-Methods;

    # Required for SSE.
    proxy_buffering off;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_set_header Accept-Encoding "";
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Reply to preflight locally so we never depend on the upstream for CORS.
    if ($request_method = OPTIONS) {
        add_header Access-Control-Allow-Origin      $http_origin always;
        add_header Access-Control-Allow-Credentials true       always;
        add_header Access-Control-Allow-Headers     "Authorization, Content-Type" always;
        add_header Access-Control-Allow-Methods     "GET, POST, OPTIONS" always;
        add_header Access-Control-Max-Age           86400;
        return 204;
    }

    # Echo the origin for actual requests.
    add_header Access-Control-Allow-Origin      $http_origin always;
    add_header Access-Control-Allow-Credentials true       always;

    proxy_pass http://127.0.0.1:8317/;
}
```

Two things to watch out for:

1. The most common mistake is a duplicated `Access-Control-Allow-Origin` header. If CLIProxyAPI already adds `*` and nginx also adds `$http_origin`, the WebView will reject the response. Use `proxy_hide_header` to strip the upstream copies before adding the right one.
2. SSE needs `proxy_buffering off` and `Connection: ''` with `proxy_http_version 1.1`, otherwise the proxy will buffer the stream and the plugin will not see any deltas.

Sanity-check the response with curl, mimicking the Obsidian origin:

```bash
curl -i \
  -H "Origin: http://localhost" \
  -H "Authorization: Bearer $YOUR_PROXY_KEY" \
  https://your-host/ob/v1/models
```

You should see exactly one `Access-Control-Allow-Origin` header whose value is `http://localhost`. Then run the same test with a streaming body to confirm the headers are present on `Content-Type: text/event-stream` as well.

## When to fall back to the WebSocket bridge

The bridge ships with the plugin as a backup path for environments where the proxy CORS cannot be fixed (third-party gateways you do not control, restricted corporate proxies, etc.). Direct SSE is still the recommended default because it reuses the same provider entry as non-streaming, requires no extra server to deploy, and avoids handing the model `apiKey` to a bridge.

Switch `流式传输` to `WebSocket bridge` only after you have confirmed the proxy CORS diagnosis and the proxy cannot be made CORS-clean. The bridge setup notes live in [`bridge/README.md`](../bridge/README.md) and the protocol in [`websocket-bridge-protocol.md`](websocket-bridge-protocol.md).

## Recommended plugin configuration

For a self-hosted setup behind `nginx → CLIProxyAPI`:

| Setting | Value |
|---------|-------|
| Base URL | `https://your-host/ob/v1` |
| API Key | the proxy-side key issued for Obsidian (not the upstream vendor key) |
| 接口格式 | `Responses API` (preferred) or `Chat Completions` |
| 流式传输 | `直连 SSE` (default) |
| Bridge URL | leave empty unless you are running the bridge fallback |

## Related references

- Plugin bridge protocol: [websocket-bridge-protocol.md](websocket-bridge-protocol.md)
- Bridge service: [../bridge/README.md](../bridge/README.md)
- Obsidian forum thread on streaming: <https://forum.obsidian.md/t/support-streaming-the-request-and-requesturl-response-body/87381>
