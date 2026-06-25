import { Notice, Plugin } from "obsidian";

import { ChatStore } from "./chat/ChatStore";
import { ChatView, VIEW_TYPE_CHAT } from "./chat/ChatView";
import { registerCommands } from "./commands/registerCommands";
import { ProviderRegistry } from "./providers/ProviderRegistry";
import { MobileAiSettingsTab } from "./settings/SettingsTab";
import { DEFAULT_SETTINGS, normalizeSettings, type MobileAiSettings } from "./settings/types";

export default class MobileAiCompanionPlugin extends Plugin {
  settings: MobileAiSettings = DEFAULT_SETTINGS;
  providerRegistry = new ProviderRegistry();
  chatStore = new ChatStore(this);

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.chatStore.load();

    this.registerView(
      VIEW_TYPE_CHAT,
      (leaf) => new ChatView(leaf, this)
    );

    this.addRibbonIcon("bot", "Mobile AI", async () => {
      await this.activateChatView();
    });

    registerCommands(this);
    this.addSettingTab(new MobileAiSettingsTab(this));
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_CHAT);
  }

  async loadSettings(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async activateChatView(): Promise<ChatView | null> {
    // Obsidian 1.7.2 加入的 ensureSideLeaf: 同一套 API 在 desktop 打开右栏、
    // mobile 打开右滑 drawer(就是和大纲、 backlinks 同一处), 不用再手动区分
    // tab / right leaf / WorkspaceMobileDrawer 三种情况, leaf 的获取与创建也
    // 都由框架处理, 我们只需要在拿到 leaf 之后检查 view 类型。
    const leaf = await this.app.workspace.ensureSideLeaf(VIEW_TYPE_CHAT, "right", {
      active: true,
      reveal: true
    });

    if (leaf.view instanceof ChatView) {
      return leaf.view;
    }

    new Notice("无法打开 Mobile AI 视图。");
    return null;
  }
}
