import type { ProviderApiFormat, ProviderConfig } from "../settings/types";
import { UserFacingError } from "../utils/errors";
import type { ChatRequest, ToolCall } from "./types";

interface OpenAIToolCall {
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

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
  // 上游流式响应里累积出的 tool_calls。新桥协议字段: 老桥不返回时为空数组。
  tool_calls?: OpenAIToolCall[];
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
  ): Promise<{ content: string; toolCalls: ToolCall[] }> {
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

    return await new Promise<{ content: string; toolCalls: ToolCall[] }>((resolve, reject) => {
      const diagnostics = createBridgeDiagnostics(bridgeUrl);
      const socket = new WebSocket(bridgeUrl);
      let settled = false;
      let content = "";
      // 跟踪上游 delta 累计量, 用于防御 done.text 与 delta 重复导致内容双倍渲染。
      // 如果 deltaCount > 0, 视为 delta 是权威流, done.text 只是兜底, 直接丢弃。
      // 如果 deltaCount === 0, 视为"老式"中转只在 done 一次性回吐全量。
      let deltaCount = 0;
      let deltaTextLengthSum = 0;
      let unlinkAbort: () => void = () => undefined;
      const timeoutId = window.setTimeout(() => {
        finish(() => reject(new UserFacingError(`WebSocket bridge 超过 ${request.timeoutMs} 毫秒仍未返回完成事件。`, buildBridgeDebugDetails(diagnostics))));
      }, request.timeoutMs);

      const finish = (fn: () => void) => {
        if (settled) {
          return;
        }

        settled = true;
        window.clearTimeout(timeoutId);
        unlinkAbort();
        try {
          socket.close();
        } catch {
          // ignore close errors
        }
        fn();
      };
      unlinkAbort = linkAbortSignal(request.signal, () => {
        finish(() => reject(new UserFacingError("请求已取消。")));
      });

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
            timeoutMs: request.timeoutMs,
            ...(request.tools && request.tools.length > 0 ? { tools: request.tools } : {})
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
              deltaCount += 1;
              deltaTextLengthSum += text.length;
              onDelta(text);
            }
            return;
          }

          if (message.type === "done") {
            const tail = message.text ?? "";

            // 防御性处理 done.text: 一些中转把整个响应原样塞在 done 里 (delta 推增量、
            // done 推全量), 直接相加会双倍渲染。判定规则:
            //   - 如果本次流收过任何 delta, delta 是权威流, done.text 忽略(可能是全量
            //     重复, 也可能是流截断后的零碎尾巴, 两种都是误用, 宁可丢一点也别双倍)。
            //   - 如果一条 delta 都没收到, 视为"老式"中转只在 done 一次性回吐全量,
            //     此时 done.text 就是全部内容, 必须采纳。
            if (tail) {
              if (deltaCount === 0) {
                content = tail;
                onDelta(tail);
              }
              // else: ignore done.text to avoid duplication
            }

            // 诊断日志: 让你在 dev console 里直接看到中转推了多少 delta、done.text 有多长。
            // 配合防御逻辑: 如果你看到 doneTextLength 很大但 deltaCount > 0, 说明中转
            // 把全量塞进了 done, plugin 已经自动忽略, 行为仍然正确。
            // eslint-disable-next-line no-console
            console.log("[mobile-ai] bridge stream", {
              deltaCount,
              deltaTextLengthSum,
              doneTextLength: tail.length,
              finalContentLength: content.length
            });

            // 新桥协议: done 消息里带 tool_calls(累积自上游 stream 的 delta.tool_calls)。
            // 老桥不返回时, 这里拿到 undefined, 当空数组处理, 行为与改造前一致。
            const doneCalls = (message.tool_calls ?? []).map(toOpenAIToolCall).filter((call) => call.id && call.function.name);
            finish(() => resolve({ content, toolCalls: doneCalls }));
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

function toOpenAIToolCall(raw: OpenAIToolCall): ToolCall {
  return {
    id: raw.id ?? "",
    type: "function",
    function: {
      name: raw.function?.name ?? "",
      arguments: raw.function?.arguments ?? ""
    }
  };
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

function linkAbortSignal(signal: AbortSignal | undefined, onAbort: () => void): () => void {
  if (!signal) {
    return () => undefined;
  }

  if (signal.aborted) {
    onAbort();
    return () => undefined;
  }

  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
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
