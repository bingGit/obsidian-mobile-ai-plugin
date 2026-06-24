import { Notice, PluginSettingTab, Setting } from "obsidian";

import type MobileAiCompanionPlugin from "../main";
import { createProviderConfig, type ProviderConfig } from "./types";

export class MobileAiSettingsTab extends PluginSettingTab {
  constructor(private readonly mobilePlugin: MobileAiCompanionPlugin) {
    super(mobilePlugin.app, mobilePlugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Mobile AI Companion" });
    containerEl.createEl("p", {
      cls: "mobile-ai-settings-note",
      text: "请求会发送你的输入、已添加的文件内容、当前笔记或选中文本到你配置的 API 服务。插件不会经过作者服务器，也不会默认上传整个 vault。"
    });

    this.renderProviders(containerEl);
    this.renderContextSettings(containerEl);
  }

  private renderProviders(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Providers" });

    for (const provider of this.mobilePlugin.settings.providers) {
      const details = containerEl.createEl("details", { cls: "mobile-ai-provider-settings" });
      details.open = provider.id === this.mobilePlugin.settings.defaultProviderId;
      details.createEl("summary", {
        text: `${provider.name || "OpenAI Compatible"}${provider.id === this.mobilePlugin.settings.defaultProviderId ? " · 默认" : ""}`
      });

      new Setting(details)
        .setName("Provider 名称")
        .addText((text) => text
          .setPlaceholder("OpenAI Compatible")
          .setValue(provider.name)
          .onChange(async (value) => {
            provider.name = value.trim() || "OpenAI Compatible";
            await this.mobilePlugin.saveSettings();
            this.display();
          }));

      new Setting(details)
        .setName("接口格式")
        .setDesc("普通文本聊天优先选 Responses；兼容旧中转站时选 Chat Completions。")
        .addDropdown((dropdown) => dropdown
          .addOption("responses", "Responses API (/v1/responses)")
          .addOption("chat-completions", "Chat Completions (/v1/chat/completions)")
          .setValue(provider.apiFormat)
          .onChange(async (value) => {
            provider.apiFormat = value as ProviderConfig["apiFormat"];
            await this.mobilePlugin.saveSettings();
          }));

      new Setting(details)
        .setName("Base URL")
        .setDesc("例如 https://api.example.com/v1。若已包含完整接口路径，插件不会重复拼接。")
        .addText((text) => text
          .setPlaceholder("https://api.example.com/v1")
          .setValue(provider.baseUrl)
          .onChange(async (value) => {
            provider.baseUrl = value.trim();
            await this.mobilePlugin.saveSettings();
          }));

      new Setting(details)
        .setName("API Key")
        .setDesc("默认隐藏。请留意 .obsidian 同步可能同步 data.json。")
        .addText((text) => {
          text.inputEl.type = "password";
          text
            .setPlaceholder("sk-...")
            .setValue(provider.apiKey)
            .onChange(async (value) => {
              provider.apiKey = value.trim();
              await this.mobilePlugin.saveSettings();
            });
        });

      new Setting(details)
        .setName("默认模型")
        .addText((text) => text
          .setPlaceholder("claude-3-5-sonnet")
          .setValue(provider.defaultModel)
          .onChange(async (value) => {
            provider.defaultModel = value.trim();
            if (provider.defaultModel && !provider.models.includes(provider.defaultModel)) {
              provider.models = [provider.defaultModel, ...provider.models];
            }
            await this.mobilePlugin.saveSettings();
          }));

      new Setting(details)
        .setName("常用模型")
        .setDesc("用英文逗号分隔，聊天界面会作为快捷选项展示。")
        .addTextArea((text) => {
          text.inputEl.rows = 3;
          text
            .setPlaceholder("gpt-4.1, claude-3-5-sonnet, deepseek-chat")
            .setValue(provider.models.join(", "))
            .onChange(async (value) => {
              provider.models = splitModels(value);
              if (!provider.defaultModel && provider.models.length) {
                provider.defaultModel = provider.models[0];
              }
              await this.mobilePlugin.saveSettings();
            });
        });

      new Setting(details)
        .setName("Temperature")
        .addSlider((slider) => slider
          .setLimits(0, 2, 0.1)
          .setDynamicTooltip()
          .setValue(provider.temperature)
          .onChange(async (value) => {
            provider.temperature = value;
            await this.mobilePlugin.saveSettings();
          }));

      new Setting(details)
        .setName("最大输出 token")
        .addText((text) => text
          .setPlaceholder("2048")
          .setValue(String(provider.maxTokens))
          .onChange(async (value) => {
            provider.maxTokens = clampInteger(value, 1, 128000, 2048);
            await this.mobilePlugin.saveSettings();
          }));

      new Setting(details)
        .setName("流式输出")
        .setDesc("优先使用 OpenAI-compatible SSE 流式响应；移动端环境或中转站不支持时会降级为非流式。")
        .addToggle((toggle) => toggle
          .setValue(provider.stream)
          .onChange(async (value) => {
            provider.stream = value;
            await this.mobilePlugin.saveSettings();
          }));

      new Setting(details)
        .setName("操作")
        .addButton((button) => button
          .setButtonText("设为默认")
          .setDisabled(provider.id === this.mobilePlugin.settings.defaultProviderId)
          .onClick(async () => {
            this.mobilePlugin.settings.defaultProviderId = provider.id;
            await this.mobilePlugin.saveSettings();
            this.display();
          }))
        .addButton((button) => button
          .setButtonText("测试连接")
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText("测试中...");
            const result = await this.mobilePlugin.providerRegistry
              .createProvider(provider)
              .testConnection(provider, this.mobilePlugin.settings.requestTimeoutMs);
            new Notice(result.message);
            button.setDisabled(false);
            button.setButtonText("测试连接");
          }))
        .addButton((button) => button
          .setButtonText("测试真实请求")
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText("测试中...");
            const message = await this.testRealChatRequest(provider);
            new Notice(message, 10000);
            button.setDisabled(false);
            button.setButtonText("测试真实请求");
          }))
        .addButton((button) => button
          .setButtonText("删除")
          .setWarning()
          .onClick(async () => {
            await this.deleteProvider(provider);
          }));
    }

    new Setting(containerEl)
      .setName("新增 Provider")
      .addButton((button) => button
        .setButtonText("添加")
        .setCta()
        .onClick(async () => {
          const provider = createProviderConfig();
          this.mobilePlugin.settings.providers.push(provider);
          this.mobilePlugin.settings.defaultProviderId = provider.id;
          await this.mobilePlugin.saveSettings();
          this.display();
        }));
  }

  private renderContextSettings(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Context" });

    new Setting(containerEl)
      .setName("单次最多引用文件数")
      .addText((text) => text
        .setValue(String(this.mobilePlugin.settings.maxContextFiles))
        .onChange(async (value) => {
          this.mobilePlugin.settings.maxContextFiles = clampInteger(value, 1, 50, 5);
          await this.mobilePlugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("单文件最大字符数")
      .addText((text) => text
        .setValue(String(this.mobilePlugin.settings.maxFileCharacters))
        .onChange(async (value) => {
          this.mobilePlugin.settings.maxFileCharacters = clampInteger(value, 1000, 500000, 20000);
          await this.mobilePlugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("总上下文最大字符数")
      .addText((text) => text
        .setValue(String(this.mobilePlugin.settings.maxTotalContextCharacters))
        .onChange(async (value) => {
          this.mobilePlugin.settings.maxTotalContextCharacters = clampInteger(value, 5000, 1000000, 60000);
          await this.mobilePlugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("请求超时毫秒")
      .setDesc("真实聊天通常比测试连接慢很多。移动端建议 120000-180000。")
      .addText((text) => text
        .setValue(String(this.mobilePlugin.settings.requestTimeoutMs))
        .onChange(async (value) => {
          this.mobilePlugin.settings.requestTimeoutMs = clampInteger(value, 5000, 300000, 60000);
          await this.mobilePlugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("保存会话历史")
      .addToggle((toggle) => toggle
        .setValue(this.mobilePlugin.settings.historyEnabled)
        .onChange(async (value) => {
          this.mobilePlugin.settings.historyEnabled = value;
          await this.mobilePlugin.saveSettings();
        }));
  }

  private async deleteProvider(provider: ProviderConfig): Promise<void> {
    if (this.mobilePlugin.settings.providers.length <= 1) {
      new Notice("至少需要保留一个 Provider。");
      return;
    }

    this.mobilePlugin.settings.providers = this.mobilePlugin.settings.providers.filter((item) => item.id !== provider.id);

    if (this.mobilePlugin.settings.defaultProviderId === provider.id) {
      this.mobilePlugin.settings.defaultProviderId = this.mobilePlugin.settings.providers[0].id;
    }

    await this.mobilePlugin.saveSettings();
    this.display();
  }

  private async testRealChatRequest(provider: ProviderConfig): Promise<string> {
    const model = provider.defaultModel || provider.models.find(Boolean) || "";

    if (!model) {
      return "请先填写模型名。";
    }

    try {
      const startedAt = Date.now();
      const response = await this.mobilePlugin.providerRegistry
        .createProvider(provider)
        .sendChat({
          config: provider,
          model,
          messages: [
            {
              role: "user",
              content: "请用 100 个中文字以内回复：移动端真实请求测试成功。"
            }
          ],
          temperature: provider.temperature,
          maxTokens: Math.min(provider.maxTokens, 512),
          timeoutMs: this.mobilePlugin.settings.requestTimeoutMs
        });
      const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);

      return `真实请求成功，用时 ${elapsedSeconds} 秒。返回：${response.content.slice(0, 80)}`;
    } catch (error) {
      return error instanceof Error ? `真实请求失败：${error.message}` : "真实请求失败。";
    }
  }
}

function splitModels(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function clampInteger(value: string, min: number, max: number, fallback: number): number {
  const parsed = Number.parseInt(value, 10);

  if (Number.isNaN(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
}
