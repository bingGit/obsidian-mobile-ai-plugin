/*
 * Minimal WebSocket bridge skeleton for Mobile AI Companion.
 *
 * This is intentionally a design skeleton, not a production-ready server.
 * It shows the protocol and the key hooks needed to proxy SSE-style model
 * streaming to a mobile-friendly WebSocket channel.
 *
 * Suggested runtime:
 *   npm i ws
 *   node docs/websocket-bridge-minimal-server.js
 */

const http = require("http");

let WebSocketServer;
try {
  ({ WebSocketServer } = require("ws"));
} catch (error) {
  console.error("Install ws first: npm i ws");
  process.exit(1);
}

const server = http.createServer();
const wss = new WebSocketServer({ server });

wss.on("connection", (socket) => {
  socket.on("message", async (raw) => {
    let payload;

    try {
      payload = JSON.parse(String(raw));
    } catch (error) {
      socket.send(JSON.stringify({
        type: "error",
        code: "bad_json",
        message: "Invalid JSON from client"
      }));
      return;
    }

    if (payload.type !== "start") {
      socket.send(JSON.stringify({
        type: "error",
        code: "bad_message_type",
        message: "Expected start message"
      }));
      return;
    }

    const request = payload.request || {};
    const auth = payload.auth || null;

    if (!isAuthorized(auth)) {
      socket.send(JSON.stringify({
        type: "error",
        code: "unauthorized",
        message: "Bridge authorization failed"
      }));
      return;
    }

    socket.send(JSON.stringify({
      type: "status",
      message: "Bridge accepted request"
    }));

    try {
      await streamUpstream(request, socket);
      socket.send(JSON.stringify({ type: "done" }));
    } catch (error) {
      socket.send(JSON.stringify({
        type: "error",
        code: "upstream_failed",
        message: error instanceof Error ? error.message : String(error)
      }));
    }
  });
});

server.listen(8787, () => {
  console.log("Bridge listening on ws://localhost:8787");
});

function isAuthorized(auth) {
  if (!process.env.BRIDGE_TOKEN) {
    return true;
  }

  return auth && auth.type === "bearer" && auth.token === process.env.BRIDGE_TOKEN;
}

async function streamUpstream(request, socket) {
  const apiFormat = request.apiFormat === "chat-completions" ? "chat-completions" : "responses";
  const url = joinUpstreamUrl(request.baseUrl, apiFormat);
  const body = apiFormat === "responses"
    ? buildResponsesBody(request)
    : buildChatCompletionsBody(request);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
      "Authorization": `Bearer ${request.apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Upstream HTTP ${response.status}`);
  }

  if (!response.body) {
    throw new Error("Upstream response has no body");
  }

  const contentType = response.headers.get("content-type") || "";

  if (!contentType.includes("text/event-stream")) {
    throw new Error(`Expected SSE but got ${contentType || "(missing content-type)"}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.replace(/\r\n/g, "\n").split("\n\n");
    buffer = parts.pop() || "";

    for (const part of parts) {
      const event = parseSseEvent(part);

      if (!event || !event.data || event.data === "[DONE]") {
        continue;
      }

      const delta = apiFormat === "responses"
        ? extractResponsesDelta(event)
        : extractChatCompletionsDelta(event);

      if (delta) {
        socket.send(JSON.stringify({
          type: "delta",
          text: delta
        }));
      }
    }
  }
}

function joinUpstreamUrl(baseUrl, apiFormat) {
  const trimmed = String(baseUrl || "").replace(/\/+$/, "");
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

  return "";
}

function extractChatCompletionsDelta(event) {
  const chunk = JSON.parse(event.data);
  return chunk.choices?.[0]?.delta?.content || "";
}
