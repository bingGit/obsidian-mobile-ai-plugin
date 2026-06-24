"use strict";

const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = Number.parseInt(process.env.PORT || "8787", 10);
const HOST = process.env.HOST || "0.0.0.0";
const BRIDGE_TOKEN = (process.env.BRIDGE_TOKEN || "").trim();
const DEFAULT_UPSTREAM_TIMEOUT_MS = Number.parseInt(process.env.UPSTREAM_TIMEOUT_MS || "180000", 10);

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "not_found" }));
});

const wss = new WebSocketServer({ server });

wss.on("connection", (socket, req) => {
  log("ws_connected", { remote: req.socket.remoteAddress || "(unknown)" });

  socket.once("message", async (raw) => {
    let payload;

    try {
      payload = JSON.parse(String(raw));
    } catch (error) {
      send(socket, {
        type: "error",
        code: "bad_json",
        message: "Invalid JSON from client"
      });
      socket.close();
      return;
    }

    if (payload.type !== "start") {
      send(socket, {
        type: "error",
        code: "bad_message_type",
        message: "Expected start message"
      });
      socket.close();
      return;
    }

    if (!isAuthorized(payload.auth)) {
      send(socket, {
        type: "error",
        code: "unauthorized",
        message: "Bridge authorization failed"
      });
      socket.close();
      return;
    }

    const request = payload.request || {};
    send(socket, {
      type: "status",
      message: "Bridge accepted request"
    });

    try {
      await streamUpstream(request, socket);
      send(socket, {
        type: "done"
      });
    } catch (error) {
      const details = error && typeof error === "object" && "details" in error
        ? error.details
        : undefined;

      send(socket, {
        type: "error",
        code: error && typeof error === "object" && "code" in error ? error.code : "upstream_failed",
        message: error instanceof Error ? error.message : String(error),
        details
      });
    } finally {
      socket.close();
    }
  });
});

server.listen(PORT, HOST, () => {
  log("bridge_listening", {
    ws: `ws://${HOST}:${PORT}`,
    healthz: `http://${HOST}:${PORT}/healthz`
  });
});

function isAuthorized(auth) {
  if (!BRIDGE_TOKEN) {
    return true;
  }

  return auth && auth.type === "bearer" && auth.token === BRIDGE_TOKEN;
}

async function streamUpstream(request, socket) {
  const apiFormat = request.apiFormat === "chat-completions" ? "chat-completions" : "responses";
  const url = joinUpstreamUrl(request.baseUrl, apiFormat);
  const body = apiFormat === "responses"
    ? buildResponsesBody(request)
    : buildChatCompletionsBody(request);
  const timeoutMs = normalizePositiveInt(request.timeoutMs, DEFAULT_UPSTREAM_TIMEOUT_MS);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort("timeout"), timeoutMs);
  const diagnostics = {
    apiFormat,
    url,
    timeoutMs,
    status: null,
    contentType: "",
    events: 0,
    lastEventType: "",
    bytes: 0
  };

  send(socket, {
    type: "status",
    message: `Bridge connecting upstream: ${apiFormat}`
  });

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "Authorization": `Bearer ${String(request.apiKey || "").trim()}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    diagnostics.status = response.status;
    diagnostics.contentType = response.headers.get("content-type") || "";

    send(socket, {
      type: "status",
      message: `Upstream connected: HTTP ${response.status}`
    });

    if (!response.ok) {
      const text = await response.text();
      throw bridgeError("upstream_http_error", `Upstream HTTP ${response.status}`, {
        ...diagnostics,
        responsePreview: truncate(text, 500)
      });
    }

    if (!response.body) {
      throw bridgeError("upstream_missing_body", "Upstream response has no body", diagnostics);
    }

    if (!diagnostics.contentType.toLowerCase().includes("text/event-stream")) {
      const text = await response.text();
      throw bridgeError("upstream_not_sse", `Expected SSE but got ${diagnostics.contentType || "(missing content-type)"}`, {
        ...diagnostics,
        responsePreview: truncate(text, 500)
      });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      const chunk = decoder.decode(value, { stream: true });
      diagnostics.bytes += chunk.length;
      buffer += chunk;
      const parts = buffer.replace(/\r\n/g, "\n").split("\n\n");
      buffer = parts.pop() || "";

      for (const part of parts) {
        const event = parseSseEvent(part);

        if (!event || !event.data || event.data === "[DONE]") {
          continue;
        }

        diagnostics.events += 1;
        diagnostics.lastEventType = event.event;

        const delta = apiFormat === "responses"
          ? extractResponsesDelta(event)
          : extractChatCompletionsDelta(event);

        if (delta) {
          send(socket, {
            type: "delta",
            text: delta
          });
        }
      }
    }

    log("upstream_done", diagnostics);
  } catch (error) {
    if (error === "timeout" || (error instanceof Error && error.name === "AbortError")) {
      throw bridgeError("upstream_timeout", `Upstream stream timed out after ${timeoutMs} ms`, diagnostics);
    }

    if (error && typeof error === "object" && "code" in error) {
      throw error;
    }

    throw bridgeError("upstream_fetch_failed", error instanceof Error ? error.message : String(error), diagnostics);
  } finally {
    clearTimeout(timeoutId);
  }
}

function send(socket, payload) {
  if (socket.readyState !== socket.OPEN) {
    return;
  }

  socket.send(JSON.stringify(payload));
}

function joinUpstreamUrl(baseUrl, apiFormat) {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");

  if (!trimmed) {
    throw bridgeError("bad_base_url", "Missing baseUrl");
  }

  if (trimmed.endsWith("/responses") || trimmed.endsWith("/chat/completions")) {
    return trimmed;
  }

  return `${trimmed}${apiFormat === "responses" ? "/responses" : "/chat/completions"}`;
}

function buildResponsesBody(request) {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const instructions = messages
    .filter((message) => message.role === "system")
    .map((message) => String(message.content || "").trim())
    .filter(Boolean)
    .join("\n\n");

  return {
    model: request.model,
    instructions: instructions || undefined,
    input: messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role,
        content: message.content
      })),
    temperature: request.temperature,
    max_output_tokens: request.maxTokens,
    stream: true
  };
}

function buildChatCompletionsBody(request) {
  return {
    model: request.model,
    messages: request.messages,
    temperature: request.temperature,
    max_tokens: request.maxTokens,
    stream: true
  };
}

function parseSseEvent(chunkText) {
  const lines = chunkText.split("\n");
  let event = "message";
  const data = [];

  for (const line of lines) {
    if (!line || line.startsWith(":")) {
      continue;
    }

    if (line.startsWith("event:")) {
      event = line.slice(6).trim() || "message";
      continue;
    }

    if (line.startsWith("data:")) {
      data.push(line.slice(5).trimStart());
    }
  }

  if (!data.length) {
    return null;
  }

  return {
    event,
    data: data.join("\n")
  };
}

function extractResponsesDelta(event) {
  const chunk = JSON.parse(event.data);
  const eventType = chunk.type || event.event;

  if ((eventType === "response.output_text.delta" || eventType === "output_text.delta") && typeof chunk.delta === "string") {
    return chunk.delta;
  }

  if ((eventType === "response.output_text.done" || eventType === "output_text.done") && typeof chunk.text === "string") {
    return chunk.text;
  }

  const itemText = Array.isArray(chunk.item?.content)
    ? chunk.item.content
      .filter((item) => item.type === "output_text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("")
    : "";

  return itemText || "";
}

function extractChatCompletionsDelta(event) {
  const chunk = JSON.parse(event.data);
  return chunk.choices?.[0]?.delta?.content || "";
}

function bridgeError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function truncate(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function log(event, payload) {
  console.log(JSON.stringify({
    time: new Date().toISOString(),
    event,
    ...payload
  }));
}
