import type { ProviderConfig } from "../settings/types";

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatRequest {
  config: ProviderConfig;
  messages: ChatMessage[];
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  onStatus?: (message: string) => void;
}

export interface ChatResponse {
  content: string;
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
