import { Notice, Plugin, type WorkspaceLeaf } from "obsidian";

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
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];

    if (!leaf) {
      leaf = this.getPreferredLeaf();
      await leaf.setViewState({
        type: VIEW_TYPE_CHAT,
        active: true
      });
    }

    this.app.workspace.revealLeaf(leaf);

    if (leaf.view instanceof ChatView) {
      return leaf.view;
    }

    new Notice("无法打开 Mobile AI 视图。");
    return null;
  }

  private getPreferredLeaf(): WorkspaceLeaf {
    return this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf("tab");
  }
}
