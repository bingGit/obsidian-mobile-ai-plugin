import { ItemView, MarkdownRenderer, Notice, Platform, setIcon, type TFile, type WorkspaceLeaf } from "obsidian";

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
  private statusTimerId: number | null = null;
  private requestStartedAt = 0;
  // Persisted across renders so status updates do not need a full re-render.
  private statusEl: HTMLElement | null = null;
  // The assistant message currently receiving stream deltas, if any.
  // While set, renderMessages skips MarkdownRenderer for this message and
  // writes plain text into the cached content element instead.
  private streamingMessageId: string | null = null;
  private streamingContentEl: HTMLElement | null = null;

  private providerSelectEl!: HTMLSelectElement;
  private modelSelectEl!: HTMLSelectElement;
  private messageListEl!: HTMLElement;
  private attachmentListEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private suggestionEl!: HTMLElement;

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
    try {
      this.ensureSession();
      this.render();
    } catch (error) {
      // 别再静默: 如果视图在 onOpen 阶段抛错(例如 fresh view 重建时
      // containerEl 结构不符合隐式假设), 至少在 Notice 里告诉用户。
      // 配合上面改用 this.contentEl, 这里理论上不会再触发, 但留着当保险。
      console.error("[mobile-ai] onOpen failed", error);
      new Notice(`Mobile AI 视图初始化失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async onClose(): Promise<void> {
    this.controller.cancel();
    this.stopRequestStatusTimer();
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
    const containerEl = this.contentEl;
    containerEl.empty();
    containerEl.addClass("mobile-ai-chat-view");

    // Invalidate the cached streaming node: the DOM is about to be rebuilt.
    this.streamingContentEl = null;

    this.renderHeader(containerEl);

    this.messageListEl = containerEl.createDiv("mobile-ai-messages");
    void this.renderMessages();

    this.attachmentListEl = containerEl.createDiv("mobile-ai-attachments");
    this.renderAttachments();

    // Reuse the status node across renders so updates are O(1) text writes.
    if (!this.statusEl) {
      this.statusEl = containerEl.createDiv("mobile-ai-status");
    } else {
      containerEl.appendChild(this.statusEl);
    }
    this.statusEl.toggle(Boolean(this.statusText));
    this.statusEl.setText(this.statusText);

    const composerEl = containerEl.createDiv("mobile-ai-composer");
    this.suggestionEl = composerEl.createDiv("mobile-ai-suggestions");

    const composerRow = composerEl.createDiv("mobile-ai-composer-row");
    this.renderAttachControl(composerRow);
    this.renderSendControl(composerRow);

    this.inputEl = composerRow.createEl("textarea", {
      cls: "mobile-ai-input",
      attr: {
        rows: "1",
        placeholder: "问当前笔记，或输入 @ 搜索 vault 内 Markdown 文件"
      }
    });
    // Auto-resize: input 时先把 height 置为 auto 让 scrollHeight 反映真实内容,
    // 再写回 scrollHeight, 由 CSS max-height 兜底防止撑爆视口。
    this.inputEl.addEventListener("input", () => {
      this.inputEl.style.height = "auto";
      this.inputEl.style.height = `${this.inputEl.scrollHeight}px`;
      this.renderSuggestions();
    });
    this.inputEl.addEventListener("keyup", () => this.renderSuggestions());
    this.inputEl.addEventListener("click", () => this.renderSuggestions());
  }

  private renderAttachControl(rowEl: HTMLElement): void {
    // 单个附件按钮 + 上方弹出的 popover, 取代原来 toolbar 里的两个独立按钮,
    // 节约横向空间, 移动端一屏能装下 input + send。
    const attachButton = rowEl.createEl("button", {
      cls: "mobile-ai-icon-button",
      attr: {
        "aria-label": "添加上下文",
        title: "添加上下文"
      }
    });
    setIcon(attachButton, "paperclip");

    const popover = rowEl.createDiv("mobile-ai-attach-popover");

    const currentItem = popover.createEl("button", {
      attr: { "aria-label": "添加当前文件" }
    });
    setIcon(currentItem, "file-text");
    currentItem.createSpan({ text: "添加当前文件" });
    currentItem.addEventListener("click", () => {
      this.addCurrentFileAttachment();
      popover.removeClass("is-open");
    });

    const selectionItem = popover.createEl("button", {
      attr: { "aria-label": "添加选中文本" }
    });
    setIcon(selectionItem, "text-select");
    selectionItem.createSpan({ text: "添加选中文本" });
    selectionItem.addEventListener("click", () => {
      this.addSelectionAttachment();
      popover.removeClass("is-open");
    });

    attachButton.addEventListener("click", (event) => {
      // 阻止冒泡, 配合 document 上的关闭监听避免"刚展开就被关掉"。
      event.stopPropagation();
      popover.toggleClass("is-open", !popover.hasClass("is-open"));
    });

    // 点击 popover 外部任意位置关闭。listener 每次打开时挂一次, 关闭后清掉。
    const closeOnOutside = (event: MouseEvent) => {
      if (!popover.contains(event.target as Node) && event.target !== attachButton) {
        popover.removeClass("is-open");
        document.removeEventListener("click", closeOnOutside);
      }
    };
    const observer = new MutationObserver(() => {
      if (popover.hasClass("is-open")) {
        document.addEventListener("click", closeOnOutside);
      } else {
        document.removeEventListener("click", closeOnOutside);
      }
    });
    observer.observe(popover, { attributes: true, attributeFilter: ["class"] });
  }

  private renderSendControl(rowEl: HTMLElement): void {
    const sendButton = rowEl.createEl("button", {
      cls: "mobile-ai-send-button mod-cta",
      attr: {
        "aria-label": this.sending ? "发送中" : "发送",
        title: this.sending ? "发送中" : "发送"
      }
    });
    setIcon(sendButton, "send");
    sendButton.disabled = this.sending;
    sendButton.addEventListener("click", () => {
      void this.handleSend();
    });

    const stopButton = rowEl.createEl("button", {
      cls: "mobile-ai-icon-button",
      attr: {
        "aria-label": "停止生成",
        title: "停止生成"
      }
    });
    setIcon(stopButton, "square");
    stopButton.disabled = !this.sending;
    stopButton.addEventListener("click", () => {
      this.controller.cancel();
      this.sending = false;
      new Notice("已请求停止，当前网络请求返回后会被忽略。");
      this.render();
    });
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
    const newButton = actionsEl.createEl("button", {
      cls: "mobile-ai-icon-button",
      attr: {
        "aria-label": "新会话",
        title: "新会话"
      }
    });
    setIcon(newButton, "plus");
    newButton.addEventListener("click", () => {
      const provider = this.getSelectedProvider() ?? this.plugin.settings.providers[0];
      this.session = this.plugin.chatStore.createSession(provider.id, provider.defaultModel);
      this.attachments = [];
      this.render();
    });

    // 全屏按钮: mobile 走 drawer.expand() 让右滑面板铺满, desktop 走 getLeaf("window")
    // 把视图弹到独立窗口方便用户自己拉大/移到第二屏。
    const fullscreenButton = actionsEl.createEl("button", {
      cls: "mobile-ai-icon-button",
      attr: {
        "aria-label": "全屏",
        title: "全屏"
      }
    });
    setIcon(fullscreenButton, "maximize-2");
    fullscreenButton.addEventListener("click", () => {
      this.openFullscreen();
    });
  }

  private openFullscreen(): void {
    // 走 app.workspace.rightSplit 直达抽屉/右栏, 不依赖 leaf.parent 链:
    //   - 优点: 老版本(<=0.1.20)留下来的 tab 孤儿也会触发抽屉展开,
    //     走 leaf.parent 链找不到 drawer 就静默失败了, 这是原版最大的坑。
    //   - 副作用: 即使 chat 不在 right split 里, 右抽屉也会被展开 —
    //     对 mobile 来说正好把抽屉"喊回来"成全屏, 对 desktop 来说 idempotent。
    const rightSplit = this.app.workspace.rightSplit as unknown as {
      expand?: () => void;
      collapse?: () => void;
      collapsed?: boolean;
    } | null;
    // eslint-disable-next-line no-console
    console.log("[mobile-ai] fullscreen click", {
      isMobile: Platform.isMobile,
      hasRightSplit: Boolean(rightSplit),
      rightSplitCollapsed: rightSplit?.collapsed,
      leafParent: (this.leaf?.parent as { constructor?: { name?: string } })?.constructor?.name
    });

    if (rightSplit) {
      if (rightSplit.collapsed) {
        rightSplit.expand?.();
      } else {
        // 不在 collapsed 状态, 也要调一次 expand, 防止 rightSplit 自己状态
        // 跟实际 DOM 不同步(比如 framework 收起后又展开, expand() 不会重置)。
        rightSplit.expand?.();
      }
    }

    // 同时 reveal 一下当前 leaf, 让框架把它放到抽屉里最前面, 真正"可见"。
    if (this.leaf) {
      this.app.workspace.revealLeaf(this.leaf);
    }

    // 兜底: 如果 chat 根本不在 right split 里(典型场景: 老 tab 孤儿),
    // 走一次 ensureSideLeaf 让框架把 chat 重新放到右侧。
    const isInRight = this.isLeafInRightSplit();
    if (!isInRight) {
      void this.plugin.activateChatView();
    }
  }

  private isLeafInRightSplit(): boolean {
    const target = this.app.workspace.rightSplit as unknown;
    if (!target) {
      return false;
    }
    let candidate: unknown = this.leaf?.parent ?? null;
    while (candidate) {
      if (candidate === target) {
        return true;
      }
      candidate = (candidate as { parent?: unknown }).parent ?? null;
    }
    return false;
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

  private async renderMessages(): Promise<void> {
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
      // 不再创建"你 / AI"角色标签 div, 改用 .mobile-ai-user / .mobile-ai-assistant
      // 修饰的 .mobile-ai-message-inner 背景色块来区分, 视觉上一眼能分清。
      const messageEl = this.messageListEl.createDiv(`mobile-ai-message mobile-ai-${message.role}`);
      const innerEl = messageEl.createDiv("mobile-ai-message-inner");

      if (message.attachments?.length) {
        const attachmentEl = innerEl.createDiv("mobile-ai-message-context");
        attachmentEl.setText(`上下文：${message.attachments.map((item) => item.label).join("、")}`);
      }

      if (message.warnings?.length) {
        const warningEl = innerEl.createDiv("mobile-ai-warning");
        warningEl.setText(message.warnings.join(" "));
      }

      const contentEl = innerEl.createDiv("mobile-ai-message-content");

      if (message.role === "assistant") {
        if (message.id === this.streamingMessageId) {
          // Streaming: skip MarkdownRenderer entirely. The node is reused
          // across deltas via this.streamingContentEl so deltas are O(1)
          // textContent writes instead of full re-parse + DOM rebuild.
          contentEl.textContent = message.content || "";
          this.streamingContentEl = contentEl;
        } else {
          await MarkdownRenderer.render(
            this.app,
            message.content || " ",
            contentEl,
            this.getActiveSourcePath(),
            this
          );
        }
      } else {
        contentEl.setText(message.content);
      }

      if (message.role === "assistant" && message.content) {
        this.renderMessageActions(innerEl, message.content, message.toolCalls);
      }
    }

    this.scrollMessageListToBottom(true);
  }

  private scrollMessageListToBottom(force: boolean): void {
    if (!this.messageListEl) {
      return;
    }
    if (force) {
      this.messageListEl.scrollTop = this.messageListEl.scrollHeight;
      return;
    }
    // Only follow along if the user is already near the bottom, so they can
    // scroll up to read history without being yanked back on every delta.
    const distance = this.messageListEl.scrollHeight
      - this.messageListEl.scrollTop
      - this.messageListEl.clientHeight;
    if (distance < 64) {
      this.messageListEl.scrollTop = this.messageListEl.scrollHeight;
    }
  }

  private setStatusText(text: string): void {
    this.statusText = text;
    if (this.statusEl) {
      this.statusEl.toggle(Boolean(text));
      this.statusEl.setText(text);
    }
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

  private renderMessageActions(
    messageEl: HTMLElement,
    content: string,
    toolCalls?: Array<{ name: string; summary: string; ok: boolean }>
  ): void {
    if (toolCalls && toolCalls.length > 0) {
      this.renderToolCalls(innerEl, toolCalls);
    }

    const actionsEl = messageEl.createDiv("mobile-ai-message-actions");

    const copyButton = actionsEl.createEl("button", {
      cls: "mobile-ai-icon-button",
      attr: {
        "aria-label": "复制这条回复",
        title: "复制"
      }
    });
    setIcon(copyButton, "copy");
    copyButton.addEventListener("click", async () => {
      await this.editorActions.copyToClipboard(content);
    });

    if (!this.editorActions.hasEditor()) {
      return;
    }

    const insertButton = actionsEl.createEl("button", {
      cls: "mobile-ai-icon-button",
      attr: {
        "aria-label": "插入到当前光标",
        title: "插入光标"
      }
    });
    setIcon(insertButton, "corner-down-left");
    insertButton.addEventListener("click", () => this.runNoteAction(() => this.editorActions.insertAtCursor(content)));

    const replaceButton = actionsEl.createEl("button", {
      cls: "mobile-ai-icon-button",
      attr: {
        "aria-label": "替换当前选区",
        title: "替换选区"
      }
    });
    setIcon(replaceButton, "replace");
    replaceButton.addEventListener("click", () => this.runNoteAction(() => this.editorActions.replaceSelection(content)));

    const appendButton = actionsEl.createEl("button", {
      cls: "mobile-ai-icon-button",
      attr: {
        "aria-label": "追加到当前笔记末尾",
        title: "追加末尾"
      }
    });
    setIcon(appendButton, "list-plus");
    appendButton.addEventListener("click", () => {
      void this.runAsyncNoteAction(() => this.editorActions.appendToCurrentFile(content));
    });
  }

  private renderToolCalls(
    messageEl: HTMLElement,
    toolCalls: Array<{ name: string; summary: string; ok: boolean }>
  ): void {
    const listEl = messageEl.createDiv("mobile-ai-message-toolcalls");
    const heading = listEl.createDiv("mobile-ai-message-toolcalls-heading");
    heading.setText("工具调用");

    for (const call of toolCalls) {
      const item = listEl.createDiv("mobile-ai-message-toolcall");
      item.addClass(call.ok ? "is-ok" : "is-failed");
      const icon = item.createSpan("mobile-ai-message-toolcall-icon");
      icon.setText(call.ok ? "✓" : "✗");
      const name = item.createSpan("mobile-ai-message-toolcall-name");
      name.setText(call.name);
      const detail = item.createSpan("mobile-ai-message-toolcall-summary");
      detail.setText(call.summary);
    }
  }

  private getActiveSourcePath(): string {
    return this.app.workspace.getActiveFile()?.path ?? "";
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
    const assistantMessage = createMessage("assistant", "");
    let inputToRestore: string | null = null;
    userMessage.attachments = attachments;
    session.providerId = provider.id;
    session.model = model;
    session.messages.push(userMessage);
    session.messages.push(assistantMessage);
    this.sending = true;
    this.streamingMessageId = assistantMessage.id;
    this.startRequestStatusTimer();
    this.render();

    try {
      const result = await this.controller.send({
        session,
        provider,
        model,
        userInput,
        attachments,
        onDelta: (delta) => {
          assistantMessage.content += delta;
          if (this.streamingContentEl) {
            this.streamingContentEl.textContent = assistantMessage.content;
            this.scrollMessageListToBottom(false);
          }
          // If streamingContentEl is null, a full render() is in flight and
          // the next renderMessages() will pick up the updated content.
        },
        onStatus: (message) => {
          this.setStatusText(message);
        },
        onToolCall: (call, result) => {
          if (!assistantMessage.toolCalls) {
            assistantMessage.toolCalls = [];
          }
          assistantMessage.toolCalls.push({
            name: call.function.name,
            summary: result.summary,
            ok: result.ok
          });
          // 工具调用已经改变了文件, 重新渲染消息列表, 让用户看到新内容。
          // 这次 render 不会丢流式 buffer: 我们在 onDelta 末尾已经写过最新的 content 了。
          if (this.streamingContentEl) {
            this.streamingContentEl.textContent = assistantMessage.content;
            this.scrollMessageListToBottom(false);
          }
        }
      });
      userMessage.attachments = result.resolvedAttachments;
      userMessage.warnings = result.warnings;
      assistantMessage.content = result.content;
      assistantMessage.toolCalls = assistantMessage.toolCalls?.length
        ? assistantMessage.toolCalls
        : undefined;
      this.streamingMessageId = null;
      this.streamingContentEl = null;
      // Final render: turns the plain-text streaming buffer into a proper
      // MarkdownRenderer output for the completed message.
      await this.renderMessages();
      await this.plugin.chatStore.saveSession(session);
      this.inputEl.value = "";
      this.attachments = [];
      new Notice(`已发送，约 ${result.characterCount} 字符上下文。`);
    } catch (error) {
      session.messages = session.messages.filter((message) => message.id !== userMessage.id && message.id !== assistantMessage.id);
      session.messages.push(createMessage("assistant", toDebugMessage(error)));
      this.streamingMessageId = null;
      this.streamingContentEl = null;
      inputToRestore = userInput;
      new Notice(toUserMessage(error));
    } finally {
      this.sending = false;
      this.stopRequestStatusTimer();
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

  private startRequestStatusTimer(): void {
    this.stopRequestStatusTimer();
    this.requestStartedAt = Date.now();
    this.statusText = "正在整理上下文并请求模型... 已等待 0 秒";
    this.statusTimerId = window.setInterval(() => {
      const elapsedSeconds = Math.max(0, Math.floor((Date.now() - this.requestStartedAt) / 1000));
      this.setStatusText(`正在等待模型返回... 已等待 ${elapsedSeconds} 秒`);
    }, 1000);
  }

  private stopRequestStatusTimer(): void {
    if (this.statusTimerId !== null) {
      window.clearInterval(this.statusTimerId);
      this.statusTimerId = null;
    }

    this.statusText = "";
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
