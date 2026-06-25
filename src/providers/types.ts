import type { ProviderConfig } from "../settings/types";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  // assistant 消息里当 AI 调用 tool 时填充。content 通常为 null,
  // 但允许与 tool_calls 共存(AI 可以在调用 tool 前后加文字说明)。
  tool_calls?: ToolCall[];
  // role === "tool" 时必须, 用于把工具结果回灌到对应的 tool_call。
  tool_call_id?: string;
  // role === "tool" 时填充, 工具名, 便于日志与 UI 展示。
  name?: string;
}

// OpenAI function-calling 的工具定义。
// description 和 parameters 用 JSON Schema 描述。
export interface Tool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

// AI 一次响应里可调用多个 tool; OpenAI 流式 API 把同一个 tool_call
// 切成多块, 按 index 累积后才是完整 ToolCall。
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    // 完整的 JSON 字符串, 解析后是工具参数对象。
    arguments: string;
  };
}

export interface ChatRequest {
  config: ProviderConfig;
  messages: ChatMessage[];
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  // 可选, 传给模型让 AI 决定何时调用。
  tools?: Tool[];
  // 可选, 当 tools 里有 force-call 的 tool 时使用(暂未实现, 留接口)。
  tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
  onStatus?: (message: string) => void;
}

export interface ChatResponse {
  content: string;
  // 模型决定调用工具时填充。content 可与 tool_calls 共存(AI 边说话边调工具)。
  toolCalls?: ToolCall[];
  raw?: unknown;
}

export interface TestResult {
  ok: boolean;
  message: string;
}

export interface AiProvider {
  id: string;
  name: string;
  sendChat(request: ChatRequest): Promise<ChatResponse>;
  streamChat?(request: ChatRequest, onDelta: (text: string) => void): Promise<ChatResponse>;
  testConnection(config: ProviderConfig, timeoutMs: number): Promise<TestResult>;
}
