import type { ProviderApiFormat, ProviderConfig } from "../settings/types";
import { UserFacingError } from "../utils/errors";
import type { ChatRequest } from "./types";

interface BridgeStartPayload {
  type: "start";
  request: {
    apiFormat: ProviderApiFormat;
    baseUrl: string;
    apiKey: string;
    model: string;
    temperature: number;
    maxTokens: number;
    messages: ChatRequest["messages"];
    timeoutMs: number;
  };
}

interface BridgeStatusMessage {
  type: "status";
  message?: string;
}

interface BridgeDeltaMessage {
  type: "delta";
  text?: string;
}

interface BridgeDoneMessage {
  type: "done";
  text?: string;
}

interface BridgeErrorMessage {
  type: "error";
  message?: string;
  code?: string;
  details?: Record<string, unknown>;
}

type BridgeServerMessage =
  | BridgeStatusMessage
  | BridgeDeltaMessage
  | BridgeDoneMessage
  | BridgeErrorMessage;

interface BridgeDiagnostics {
  bridgeUrl: string;
  readyState: string;
  openSucceeded: boolean;
  messageCount: number;
  statusCount: number;
  deltaCount: number;
  closeCode: string;
  closeReason: string;
  lastMessageType: string;
  lastStatus: string;
}

export class StreamBridgeClient {
  async testConnection(config: ProviderConfig, timeoutMs: number): Promise<string> {
    const bridgeUrl = config.bridgeUrl.trim();

    if (!bridgeUrl) {
      throw new UserFacingError("未填写 Bridge URL。", [
        { label: "流式传输", value: "websocket-bridge" }
      ]);
    }

    if (typeof WebSocket === "undefined") {
      throw new UserFacingError("当前环境不支持 WebSocket。", [
        { label: "流式传输", value: "websocket-bridge" }
      ]);
    }

    return await new Promise<string>((resolve, reject) => {
      const diagnostics = createBridgeDiagnostics(bridgeUrl);
      const socket = new WebSocket(bridgeUrl);
      let settled = false;
      const timeoutId = window.setTimeout(() => {
        finish(() => reject(new UserFacingError(`Bridge 连接超过 ${timeoutMs} 毫秒仍未成功。`, buildBridgeDebugDetails(diagnostics))));
      }, timeoutMs);

      const finish = (fn: () => void) => {
        if (settled) {
          return;
        }

        settled = true;
        window.clearTimeout(timeoutId);
        try {
          socket.close();
        } catch {
          // ignore close errors
        }
        fn();
      };

      socket.onopen = () => {
        diagnostics.openSucceeded = true;
        diagnostics.readyState = "OPEN";
        finish(() => resolve(`Bridge 连接成功：${bridgeUrl}`));
      };

      socket.onerror = () => {
        diagnostics.readyState = describeReadyState(socket.readyState);
        finish(() => reject(new UserFacingError("WebSocket bridge 连接失败。", buildBridgeDebugDetails(diagnostics))));
      };

      socket.onclose = (event) => {
        diagnostics.readyState = "CLOSED";
        diagnostics.closeCode = String(event.code);
        diagnostics.closeReason = event.reason || "(empty)";

        if (settled) {
          return;
        }

        finish(() => reject(new UserFacingError("WebSocket bridge 提前关闭。", buildBridgeDebugDetails(diagnostics))));
      };
    });
  }

  async stream(
    config: ProviderConfig,
    request: ChatRequest,
    onDelta: (text: string) => void
  ): Promise<string> {
    const bridgeUrl = config.bridgeUrl.trim();

    if (!bridgeUrl) {
      throw new UserFacingError("已选择 WebSocket bridge，但未填写 Bridge URL。", [
        { label: "流式传输", value: "websocket-bridge" }
      ]);
    }

    if (typeof WebSocket === "undefined") {
      throw new UserFacingError("当前环境不支持 WebSocket。", [
        { label: "流式传输", value: "websocket-bridge" }
      ]);
    }

    return await new Promise<string>((resolve, reject) => {
      const diagnostics = createBridgeDiagnostics(bridgeUrl);
      const socket = new WebSocket(bridgeUrl);
      let settled = false;
      let content = "";
      const timeoutId = window.setTimeout(() => {
        finish(() => reject(new UserFacingError(`WebSocket bridge 超过 ${request.timeoutMs} 毫秒仍未返回完成事件。`, buildBridgeDebugDetails(diagnostics))));
      }, request.timeoutMs);

      const finish = (fn: () => void) => {
        if (settled) {
          return;
        }

        settled = true;
        window.clearTimeout(timeoutId);
        try {
          socket.close();
        } catch {
          // ignore close errors
        }
        fn();
      };

      socket.onopen = () => {
        diagnostics.openSucceeded = true;
        diagnostics.readyState = "OPEN";
        request.onStatus?.("Bridge 已连接，正在等待服务端转发流式响应");

        const payload: BridgeStartPayload = {
          type: "start",
          request: {
            apiFormat: config.apiFormat,
            baseUrl: config.baseUrl,
            apiKey: config.apiKey,
            model: request.model,
            temperature: request.temperature,
            maxTokens: request.maxTokens,
            messages: request.messages,
            timeoutMs: request.timeoutMs
          }
        };

        const authToken = config.bridgeAuthToken.trim();
        const envelope = authToken
          ? {
            ...payload,
            auth: {
              type: "bearer",
              token: authToken
            }
          }
          : payload;

        socket.send(JSON.stringify(envelope));
      };

      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as BridgeServerMessage;
          diagnostics.messageCount += 1;
          diagnostics.lastMessageType = message.type;

          if (message.type === "status") {
            diagnostics.statusCount += 1;
            diagnostics.lastStatus = message.message || "(empty)";
            request.onStatus?.(message.message || "Bridge 正在处理请求");
            return;
          }

          if (message.type === "delta") {
            diagnostics.deltaCount += 1;
            const text = message.text ?? "";
            if (text) {
              content += text;
              onDelta(text);
            }
            return;
          }

          if (message.type === "done") {
            const tail = message.text ?? "";
            if (tail) {
              content += tail;
              onDelta(tail);
            }

            finish(() => resolve(content));
            return;
          }

          if (message.type === "error") {
            finish(() => reject(new UserFacingError(message.message || "Bridge 返回错误。", [
              { label: "流式传输", value: "websocket-bridge" },
              { label: "错误代码", value: message.code || "(none)" },
              { label: "错误详情", value: message.details ? JSON.stringify(message.details) : "(none)" },
              ...buildBridgeDebugDetails(diagnostics)
            ])));
            return;
          }

          throw new Error("unknown bridge message");
        } catch (error) {
          finish(() => reject(new UserFacingError("Bridge 返回了无法解析的消息。", [
            { label: "流式传输", value: "websocket-bridge" },
            { label: "原始错误", value: error instanceof Error ? error.message : String(error) },
            { label: "原始消息", value: truncate(String(event.data), 400) },
            ...buildBridgeDebugDetails(diagnostics)
          ])));
        }
      };

      socket.onerror = () => {
        diagnostics.readyState = describeReadyState(socket.readyState);
        finish(() => reject(new UserFacingError("WebSocket bridge 连接失败。", buildBridgeDebugDetails(diagnostics))));
      };

      socket.onclose = (event) => {
        diagnostics.readyState = "CLOSED";
        diagnostics.closeCode = String(event.code);
        diagnostics.closeReason = event.reason || "(empty)";

        if (settled) {
          return;
        }

        finish(() => reject(new UserFacingError("WebSocket bridge 提前关闭。", buildBridgeDebugDetails(diagnostics))));
      };
    });
  }
}

function createBridgeDiagnostics(bridgeUrl: string): BridgeDiagnostics {
  return {
    bridgeUrl,
    readyState: "CONNECTING",
    openSucceeded: false,
    messageCount: 0,
    statusCount: 0,
    deltaCount: 0,
    closeCode: "(none)",
    closeReason: "(none)",
    lastMessageType: "(none)",
    lastStatus: "(none)"
  };
}

function buildBridgeDebugDetails(diagnostics: BridgeDiagnostics) {
  return [
    { label: "Bridge URL", value: diagnostics.bridgeUrl },
    { label: "Bridge readyState", value: diagnostics.readyState },
    { label: "Bridge 已连接", value: String(diagnostics.openSucceeded) },
    { label: "Bridge 消息数", value: String(diagnostics.messageCount) },
    { label: "Bridge 状态数", value: String(diagnostics.statusCount) },
    { label: "Bridge delta 数", value: String(diagnostics.deltaCount) },
    { label: "Bridge 最后消息类型", value: diagnostics.lastMessageType },
    { label: "Bridge 最后状态", value: diagnostics.lastStatus },
    { label: "Bridge close code", value: diagnostics.closeCode },
    { label: "Bridge close reason", value: diagnostics.closeReason }
  ];
}

function describeReadyState(readyState: number): string {
  if (readyState === WebSocket.CONNECTING) {
    return "CONNECTING";
  }

  if (readyState === WebSocket.OPEN) {
    return "OPEN";
  }

  if (readyState === WebSocket.CLOSING) {
    return "CLOSING";
  }

  if (readyState === WebSocket.CLOSED) {
    return "CLOSED";
  }

  return `UNKNOWN(${String(readyState)})`;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}
