import { ItemView, Notice, type TFile, type WorkspaceLeaf } from "obsidian";

import type MobileAiCompanionPlugin from "../main";
import { FileSuggest } from "../context/FileSuggest";
import { getActiveMentionQuery } from "../context/MentionParser";
import type { ContextAttachment } from "../context/types";
import { EditorActions } from "../note-actions/EditorActions";
import type { ProviderConfig } from "../settings/types";
import { toDebugMessage, toUserMessage } from "../utils/errors";
import { ChatController } from "./ChatController";
import { createMessage, type ChatSession } from "./ChatStore";

export const VIEW_TYPE_CHAT = "mobile-ai-companion-chat";

export class ChatView extends ItemView {
  private controller: ChatController;
  private editorActions: EditorActions;
  private fileSuggest: FileSuggest;
  private session: ChatSession | null = null;
  private attachments: ContextAttachment[] = [];
  private sending = false;
  private statusText = "";
  private historyOpen = false;

  private providerSelectEl!: HTMLSelectElement;
  private modelSelectEl!: HTMLSelectElement;
  private messageListEl!: HTMLElement;
  private attachmentListEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private suggestionEl!: HTMLElement;
  private footerActionsEl!: HTMLElement;
  private historyEl!: HTMLElement;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: MobileAiCompanionPlugin
  ) {
    super(leaf);
    this.controller = new ChatController(plugin);
    this.editorActions = new EditorActions(plugin.app);
    this.fileSuggest = new FileSuggest(plugin.app);
  }

  getViewType(): string {
    return VIEW_TYPE_CHAT;
  }

  getDisplayText(): string {
    return "Mobile AI";
  }

  getIcon(): string {
    return "bot";
  }

  async onOpen(): Promise<void> {
    this.ensureSession();
    this.render();
  }

  async onClose(): Promise<void> {
    this.controller.cancel();
  }

  setPrompt(prompt: string): void {
    if (!this.inputEl) {
      return;
    }

    this.inputEl.value = prompt;
    this.inputEl.focus();
    this.renderSuggestions();
  }

  addCurrentFileAttachment(): void {
    const attachment = this.editorActions.getCurrentFileAttachment();

    if (!attachment) {
      new Notice("没有当前文件。");
      return;
    }

    this.addAttachment(attachment);
  }

  addSelectionAttachment(): void {
    const attachment = this.editorActions.getSelectionAttachment();

    if (!attachment) {
      new Notice("请先选中文本。");
      return;
    }

    this.addAttachment(attachment);
  }

  private ensureSession(): ChatSession {
    if (this.session) {
      this.hydrateSession(this.session);
      return this.session;
    }

    const defaultProvider = this.getDefaultProvider() ?? this.plugin.settings.providers[0];
    const recent = this.plugin.chatStore.getMostRecent();

    this.session = this.hydrateSession(recent ?? this.plugin.chatStore.createSession(
      defaultProvider.id,
      this.resolveModelForProvider(defaultProvider)
    ));

    return this.session;
  }

  private render(): void {
    const containerEl = this.containerEl.children[1] as HTMLElement;
    containerEl.empty();
    containerEl.addClass("mobile-ai-chat-view");

    this.renderHeader(containerEl);
    this.historyEl = containerEl.createDiv("mobile-ai-history");
    this.renderHistory();

    this.messageListEl = containerEl.createDiv("mobile-ai-messages");
    this.renderMessages();

    this.attachmentListEl = containerEl.createDiv("mobile-ai-attachments");
    this.renderAttachments();

    const statusEl = containerEl.createDiv("mobile-ai-status");
    statusEl.toggle(Boolean(this.statusText));
    statusEl.setText(this.statusText);

    const composerEl = containerEl.createDiv("mobile-ai-composer");
    this.suggestionEl = composerEl.createDiv("mobile-ai-suggestions");
    this.inputEl = composerEl.createEl("textarea", {
      cls: "mobile-ai-input",
      attr: {
        rows: "4",
        placeholder: "问当前笔记，或输入 @ 搜索 vault 内 Markdown 文件"
      }
    });
    this.inputEl.addEventListener("input", () => this.renderSuggestions());
    this.inputEl.addEventListener("keyup", () => this.renderSuggestions());
    this.inputEl.addEventListener("click", () => this.renderSuggestions());

    this.renderToolbar(composerEl);
    this.footerActionsEl = containerEl.createDiv("mobile-ai-footer-actions");
    this.renderFooterActions();
  }

  private renderHeader(parentEl: HTMLElement): void {
    const session = this.ensureSession();
    const headerEl = parentEl.createDiv("mobile-ai-header");
    const controlsEl = headerEl.createDiv("mobile-ai-provider-controls");

    this.providerSelectEl = controlsEl.createEl("select", { cls: "mobile-ai-select" });

    for (const provider of this.plugin.settings.providers) {
      const option = this.providerSelectEl.createEl("option", {
        text: provider.name || "OpenAI Compatible",
        value: provider.id
      });
      option.selected = provider.id === session.providerId;
    }

    this.providerSelectEl.addEventListener("change", () => {
      const provider = this.getConfiguredProviderById(this.providerSelectEl.value);

      if (!provider || !this.session) {
        return;
      }

      this.session.providerId = provider.id;
      this.session.model = this.resolveModelForProvider(provider);
      this.renderModelSelect(controlsEl);
    });

    this.modelSelectEl = controlsEl.createEl("select", { cls: "mobile-ai-select" });
    this.renderModelSelect(controlsEl);

    const actionsEl = headerEl.createDiv("mobile-ai-header-actions");
    const newButton = actionsEl.createEl("button", { text: "新会话" });
    newButton.addEventListener("click", () => {
      const provider = this.getSelectedProvider() ?? this.plugin.settings.providers[0];
      this.session = this.plugin.chatStore.createSession(provider.id, provider.defaultModel);
      this.attachments = [];
      this.render();
    });

    const historyButton = actionsEl.createEl("button", { text: "历史" });
    historyButton.addEventListener("click", () => {
      this.historyOpen = !this.historyOpen;
      this.renderHistory();
    });
  }

  private renderModelSelect(parentEl: HTMLElement): void {
    this.modelSelectEl.empty();
    const provider = this.getSelectedProvider();

    if (!provider || !this.session) {
      return;
    }

    const currentModel = this.resolveModelForProvider(provider, this.session.model);
    const models = unique([currentModel, ...this.getProviderModels(provider)].filter(Boolean));
    this.session.providerId = provider.id;
    this.session.model = currentModel;

    if (this.providerSelectEl.value !== provider.id) {
      this.providerSelectEl.value = provider.id;
    }

    if (!models.length) {
      this.modelSelectEl.createEl("option", {
        text: "请先在设置中配置模型",
        value: ""
      });
      return;
    }

    for (const model of models) {
      const option = this.modelSelectEl.createEl("option", { text: model, value: model });
      option.selected = model === currentModel;
    }

    this.modelSelectEl.addEventListener("change", () => {
      if (this.session) {
        this.session.model = this.modelSelectEl.value;
      }
    });

    if (!parentEl.contains(this.modelSelectEl)) {
      parentEl.appendChild(this.modelSelectEl);
    }
  }

  private renderToolbar(parentEl: HTMLElement): void {
    const toolbarEl = parentEl.createDiv("mobile-ai-toolbar");

    const currentButton = toolbarEl.createEl("button", { text: "当前文件" });
    currentButton.addEventListener("click", () => this.addCurrentFileAttachment());

    const selectionButton = toolbarEl.createEl("button", { text: "选中文本" });
    selectionButton.addEventListener("click", () => this.addSelectionAttachment());

    const sendButton = toolbarEl.createEl("button", {
      text: this.sending ? "发送中" : "发送",
      cls: "mod-cta"
    });
    sendButton.disabled = this.sending;
    sendButton.addEventListener("click", () => {
      void this.handleSend();
    });

    const stopButton = toolbarEl.createEl("button", { text: "停止" });
    stopButton.disabled = !this.sending;
    stopButton.addEventListener("click", () => {
      this.controller.cancel();
      this.sending = false;
      new Notice("已请求停止，当前网络请求返回后会被忽略。");
      this.render();
    });
  }

  private renderMessages(): void {
    this.messageListEl.empty();
    const session = this.ensureSession();

    if (!session.messages.length) {
      this.messageListEl.createDiv({
        cls: "mobile-ai-empty",
        text: "还没有消息。"
      });
      return;
    }

    for (const message of session.messages) {
      const messageEl = this.messageListEl.createDiv(`mobile-ai-message mobile-ai-${message.role}`);
      messageEl.createDiv({
        cls: "mobile-ai-message-role",
        text: message.role === "user" ? "你" : "AI"
      });

      if (message.attachments?.length) {
        const attachmentEl = messageEl.createDiv("mobile-ai-message-context");
        attachmentEl.setText(`上下文：${message.attachments.map((item) => item.label).join("、")}`);
      }

      if (message.warnings?.length) {
        const warningEl = messageEl.createDiv("mobile-ai-warning");
        warningEl.setText(message.warnings.join(" "));
      }

      messageEl.createDiv({
        cls: "mobile-ai-message-content",
        text: message.content
      });
    }

    this.messageListEl.scrollTop = this.messageListEl.scrollHeight;
  }

  private renderAttachments(): void {
    this.attachmentListEl.empty();

    if (!this.attachments.length) {
      this.attachmentListEl.createDiv({
        cls: "mobile-ai-attachment-empty",
        text: "未添加上下文"
      });
      return;
    }

    for (const attachment of this.attachments) {
      const chip = this.attachmentListEl.createDiv("mobile-ai-chip");
      chip.createSpan({ text: attachment.label });
      const removeButton = chip.createEl("button", { text: "x" });
      removeButton.addEventListener("click", () => {
        this.attachments = this.attachments.filter((item) => item.id !== attachment.id);
        this.renderAttachments();
      });
    }
  }

  private renderSuggestions(): void {
    if (!this.suggestionEl || !this.inputEl) {
      return;
    }

    this.suggestionEl.empty();
    const query = getActiveMentionQuery(this.inputEl.value, this.inputEl.selectionStart ?? this.inputEl.value.length);

    if (query === null) {
      return;
    }

    const suggestions = this.fileSuggest.search(query, 6);

    for (const suggestion of suggestions) {
      const button = this.suggestionEl.createEl("button", {
        cls: "mobile-ai-suggestion",
        text: suggestion.file.path
      });
      button.addEventListener("click", () => this.selectSuggestion(suggestion.file));
    }
  }

  private renderFooterActions(): void {
    this.footerActionsEl.empty();
    const lastAssistant = [...this.ensureSession().messages].reverse().find((message) => message.role === "assistant");

    if (!lastAssistant) {
      return;
    }

    const copyButton = this.footerActionsEl.createEl("button", { text: "复制回答" });
    copyButton.addEventListener("click", async () => {
      await this.editorActions.copyToClipboard(lastAssistant.content);
    });

    if (!this.editorActions.hasEditor()) {
      return;
    }

    const insertButton = this.footerActionsEl.createEl("button", { text: "插入光标" });
    insertButton.addEventListener("click", () => this.runNoteAction(() => this.editorActions.insertAtCursor(lastAssistant.content)));

    const replaceButton = this.footerActionsEl.createEl("button", { text: "替换选区" });
    replaceButton.addEventListener("click", () => this.runNoteAction(() => this.editorActions.replaceSelection(lastAssistant.content)));

    const appendButton = this.footerActionsEl.createEl("button", { text: "追加末尾" });
    appendButton.addEventListener("click", () => {
      void this.runAsyncNoteAction(() => this.editorActions.appendToCurrentFile(lastAssistant.content));
    });
  }

  private renderHistory(): void {
    if (!this.historyEl) {
      return;
    }

    this.historyEl.empty();

    if (!this.historyOpen) {
      this.historyEl.hide();
      return;
    }

    this.historyEl.show();
    const recent = this.plugin.chatStore.getRecent();

    if (!recent.length) {
      this.historyEl.createDiv({ text: "暂无历史会话" });
      return;
    }

    const clearButton = this.historyEl.createEl("button", { text: "清空历史" });
    clearButton.addEventListener("click", async () => {
      await this.plugin.chatStore.clear();
      const provider = this.getDefaultProvider() ?? this.plugin.settings.providers[0];
      this.session = this.plugin.chatStore.createSession(provider.id, this.resolveModelForProvider(provider));
      this.render();
    });

    for (const session of recent) {
      const row = this.historyEl.createDiv("mobile-ai-history-row");
      const openButton = row.createEl("button", { text: session.title });
      openButton.addEventListener("click", () => {
        this.session = this.hydrateSession(session);
        this.attachments = [];
        this.historyOpen = false;
        this.render();
      });

      const deleteButton = row.createEl("button", { text: "删除" });
      deleteButton.addEventListener("click", async () => {
        await this.plugin.chatStore.deleteSession(session.id);
        this.renderHistory();
      });
    }
  }

  private async handleSend(): Promise<void> {
    if (this.sending) {
      return;
    }

    const session = this.ensureSession();
    const provider = this.getSelectedProvider();
    const userInput = this.inputEl.value.trim();

    if (!provider) {
      new Notice("请先配置 Provider。");
      return;
    }

    const model = this.resolveModelForProvider(provider, this.modelSelectEl.value || session.model);
    const attachments = [...this.attachments];
    const userMessage = createMessage("user", userInput);
    let inputToRestore: string | null = null;
    userMessage.attachments = attachments;
    session.providerId = provider.id;
    session.model = model;
    session.messages.push(userMessage);
    this.sending = true;
    this.statusText = "正在整理上下文并请求模型...";
    this.renderMessages();
    this.render();

    try {
      const result = await this.controller.send({
        session,
        provider,
        model,
        userInput,
        attachments
      });
      userMessage.attachments = result.resolvedAttachments;
      userMessage.warnings = result.warnings;
      const assistantMessage = createMessage("assistant", result.content);
      session.messages.push(assistantMessage);
      await this.plugin.chatStore.saveSession(session);
      this.inputEl.value = "";
      this.attachments = [];
      new Notice(`已发送，约 ${result.characterCount} 字符上下文。`);
    } catch (error) {
      session.messages = session.messages.filter((message) => message.id !== userMessage.id);
      session.messages.push(createMessage("assistant", toDebugMessage(error)));
      inputToRestore = userInput;
      new Notice(toUserMessage(error));
    } finally {
      this.sending = false;
      this.statusText = "";
      this.render();
      if (inputToRestore) {
        this.setPrompt(inputToRestore);
      }
    }
  }

  private selectSuggestion(file: TFile): void {
    const cursor = this.inputEl.selectionStart ?? this.inputEl.value.length;
    const before = this.inputEl.value.slice(0, cursor);
    const at = before.lastIndexOf("@");
    const after = this.inputEl.value.slice(cursor);
    const token = file.path.includes(" ") ? `@"${file.path}"` : `@${file.path}`;
    const nextValue = `${this.inputEl.value.slice(0, at)}${token} ${after}`;
    const nextCursor = at + token.length + 1;

    this.inputEl.value = nextValue;
    this.inputEl.focus();
    this.inputEl.setSelectionRange(nextCursor, nextCursor);
    this.addAttachment({
      id: `file-${file.path}`,
      type: "file",
      path: file.path,
      label: file.basename,
      addedAt: Date.now()
    });
    this.renderSuggestions();
  }

  private addAttachment(attachment: ContextAttachment): void {
    const duplicate = this.attachments.some((item) => {
      if (attachment.path && item.path === attachment.path) {
        return true;
      }

      return item.id === attachment.id;
    });

    if (!duplicate) {
      this.attachments.push(attachment);
    }

    if (this.attachmentListEl) {
      this.renderAttachments();
    }
  }

  private getSelectedProvider(): ProviderConfig | null {
    const selectedId = this.providerSelectEl?.value || this.session?.providerId || this.plugin.settings.defaultProviderId;
    const selectedProvider = this.getConfiguredProviderById(selectedId);

    if (selectedProvider && this.getProviderModels(selectedProvider).length) {
      return selectedProvider;
    }

    const defaultProvider = this.getDefaultProvider();

    if (defaultProvider && this.getProviderModels(defaultProvider).length) {
      return defaultProvider;
    }

    return selectedProvider ?? defaultProvider ?? this.plugin.settings.providers[0] ?? null;
  }

  private getDefaultProvider(): ProviderConfig | null {
    const configuredDefault = this.getConfiguredProviderById(this.plugin.settings.defaultProviderId);

    if (configuredDefault && this.getProviderModels(configuredDefault).length) {
      return configuredDefault;
    }

    return this.plugin.settings.providers.find((provider) => this.getProviderModels(provider).length)
      ?? configuredDefault
      ?? this.plugin.settings.providers[0]
      ?? null;
  }

  private getConfiguredProviderById(id: string | undefined): ProviderConfig | null {
    if (!id) {
      return null;
    }

    return this.plugin.settings.providers.find((provider) => provider.id === id) ?? null;
  }

  private hydrateSession(session: ChatSession): ChatSession {
    const sessionProvider = this.getConfiguredProviderById(session.providerId);
    const provider = sessionProvider && this.getProviderModels(sessionProvider).length
      ? sessionProvider
      : this.getDefaultProvider() ?? sessionProvider;

    if (!provider) {
      return session;
    }

    const model = this.resolveModelForProvider(provider, session.model);

    session.providerId = provider.id;
    session.model = model;

    return session;
  }

  private getProviderModels(provider: ProviderConfig): string[] {
    return unique([provider.defaultModel, ...provider.models]
      .map((model) => model.trim())
      .filter(Boolean));
  }

  private resolveModelForProvider(provider: ProviderConfig, preferredModel = ""): string {
    const models = this.getProviderModels(provider);
    const preferred = preferredModel.trim();

    if (preferred && models.includes(preferred)) {
      return preferred;
    }

    return provider.defaultModel.trim() || models[0] || preferred;
  }

  private runNoteAction(action: () => void): void {
    try {
      action();
      new Notice("已写入当前笔记。");
    } catch (error) {
      new Notice(toUserMessage(error));
    }
  }

  private async runAsyncNoteAction(action: () => Promise<void>): Promise<void> {
    try {
      await action();
      new Notice("已写入当前笔记。");
    } catch (error) {
      new Notice(toUserMessage(error));
    }
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
