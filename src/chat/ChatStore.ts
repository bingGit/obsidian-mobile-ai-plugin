import type MobileAiCompanionPlugin from "../main";
import type { ContextAttachment } from "../context/types";

export type SessionMessageRole = "user" | "assistant";

export interface SessionToolCall {
  // 工具名(例如 read_file / write_file / append_to_file)。
  name: string;
  // 工具入参的简短描述, 用于 UI 显示。
  // 不存完整 arguments: 那可能很大且对 UI 无用。
  summary: string;
  // 是否成功。
  ok: boolean;
}

export interface SessionMessage {
  id: string;
  role: SessionMessageRole;
  content: string;
  createdAt: number;
  attachments?: ContextAttachment[];
  warnings?: string[];
  // AI 在生成这条消息过程中调用的工具, 按调用顺序。
  toolCalls?: SessionToolCall[];
}

export interface ChatSession {
  id: string;
  title: string;
  providerId: string;
  model: string;
  messages: SessionMessage[];
  createdAt: number;
  updatedAt: number;
}

interface SessionFile {
  sessions: ChatSession[];
}

export class ChatStore {
  private sessions: ChatSession[] = [];

  constructor(private readonly plugin: MobileAiCompanionPlugin) {}

  async load(): Promise<void> {
    try {
      const data = await this.plugin.app.vault.adapter.read(this.getPath());
      const parsed = JSON.parse(data) as SessionFile;
      this.sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
    } catch {
      this.sessions = [];
    }
  }

  getRecent(limit = 20): ChatSession[] {
    return [...this.sessions]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  getMostRecent(): ChatSession | null {
    return this.getRecent(1)[0] ?? null;
  }

  createSession(providerId: string, model: string): ChatSession {
    const now = Date.now();

    return {
      id: `session-${now}-${Math.random().toString(36).slice(2, 8)}`,
      title: "新会话",
      providerId,
      model,
      messages: [],
      createdAt: now,
      updatedAt: now
    };
  }

  async saveSession(session: ChatSession): Promise<void> {
    if (!this.plugin.settings.historyEnabled) {
      return;
    }

    session.updatedAt = Date.now();
    session.title = deriveTitle(session);

    const index = this.sessions.findIndex((item) => item.id === session.id);

    if (index === -1) {
      this.sessions.push(session);
    } else {
      this.sessions[index] = session;
    }

    await this.persist();
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions = this.sessions.filter((session) => session.id !== id);
    await this.persist();
  }

  async clear(): Promise<void> {
    this.sessions = [];
    await this.persist();
  }

  private async persist(): Promise<void> {
    await this.ensurePluginDirectory();
    await this.plugin.app.vault.adapter.write(
      this.getPath(),
      JSON.stringify({ sessions: this.sessions }, null, 2)
    );
  }

  private async ensurePluginDirectory(): Promise<void> {
    const directory = `${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}`;

    if (!(await this.plugin.app.vault.adapter.exists(directory))) {
      await this.plugin.app.vault.adapter.mkdir(directory);
    }
  }

  private getPath(): string {
    return `${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}/sessions.json`;
  }
}

export function createMessage(role: SessionMessageRole, content: string): SessionMessage {
  return {
    id: `message-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    content,
    createdAt: Date.now()
  };
}

function deriveTitle(session: ChatSession): string {
  const firstUserMessage = session.messages.find((message) => message.role === "user");
  const content = firstUserMessage?.content.trim();

  if (!content) {
    return "新会话";
  }

  return content.length > 32 ? `${content.slice(0, 32)}...` : content;
}
