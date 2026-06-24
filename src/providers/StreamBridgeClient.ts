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

export class StreamBridgeClient {
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
      const socket = new WebSocket(bridgeUrl);
      let settled = false;
      let content = "";

      const finish = (fn: () => void) => {
        if (settled) {
          return;
        }

        settled = true;
        try {
          socket.close();
        } catch {
          // ignore close errors
        }
        fn();
      };

      socket.onopen = () => {
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

          if (message.type === "status") {
            request.onStatus?.(message.message || "Bridge 正在处理请求");
            return;
          }

          if (message.type === "delta") {
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
              { label: "错误详情", value: message.details ? JSON.stringify(message.details) : "(none)" }
            ])));
            return;
          }

          throw new Error("unknown bridge message");
        } catch (error) {
          finish(() => reject(new UserFacingError("Bridge 返回了无法解析的消息。", [
            { label: "流式传输", value: "websocket-bridge" },
            { label: "原始错误", value: error instanceof Error ? error.message : String(error) },
            { label: "原始消息", value: truncate(String(event.data), 400) }
          ])));
        }
      };

      socket.onerror = () => {
        finish(() => reject(new UserFacingError("WebSocket bridge 连接失败。", [
          { label: "流式传输", value: "websocket-bridge" },
          { label: "Bridge URL", value: bridgeUrl }
        ])));
      };

      socket.onclose = () => {
        if (settled) {
          return;
        }

        finish(() => reject(new UserFacingError("WebSocket bridge 提前关闭。", [
          { label: "流式传输", value: "websocket-bridge" },
          { label: "Bridge URL", value: bridgeUrl }
        ])));
      };
    });
  }
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}
