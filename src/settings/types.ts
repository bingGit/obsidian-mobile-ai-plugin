export type ProviderApiFormat = "chat-completions" | "responses";

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  apiFormat: ProviderApiFormat;
  defaultModel: string;
  models: string[];
  temperature: number;
  maxTokens: number;
  stream: boolean;
}

export interface MobileAiSettings {
  providers: ProviderConfig[];
  defaultProviderId: string;
  maxContextFiles: number;
  maxFileCharacters: number;
  maxTotalContextCharacters: number;
  requestTimeoutMs: number;
  historyEnabled: boolean;
}

export const DEFAULT_PROVIDER_ID = "openai-compatible-default";

export const DEFAULT_SETTINGS: MobileAiSettings = {
  providers: [
    {
      id: DEFAULT_PROVIDER_ID,
      name: "OpenAI Compatible",
      baseUrl: "",
      apiKey: "",
      apiFormat: "chat-completions",
      defaultModel: "",
      models: [],
      temperature: 0.7,
      maxTokens: 2048,
      stream: false
    }
  ],
  defaultProviderId: DEFAULT_PROVIDER_ID,
  maxContextFiles: 5,
  maxFileCharacters: 20000,
  maxTotalContextCharacters: 60000,
  requestTimeoutMs: 60000,
  historyEnabled: true
};

export function createProviderConfig(): ProviderConfig {
  const id = `provider-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    id,
    name: "OpenAI Compatible",
    baseUrl: "",
    apiKey: "",
    apiFormat: "chat-completions",
    defaultModel: "",
    models: [],
    temperature: 0.7,
    maxTokens: 2048,
    stream: false
  };
}

export function normalizeSettings(data: Partial<MobileAiSettings> | null | undefined): MobileAiSettings {
  const settings = {
    ...DEFAULT_SETTINGS,
    ...data
  };

  if (!settings.providers.length) {
    settings.providers = DEFAULT_SETTINGS.providers.map((provider) => ({ ...provider }));
  }

  if (!settings.defaultProviderId || !settings.providers.some((provider) => provider.id === settings.defaultProviderId)) {
    settings.defaultProviderId = settings.providers[0].id;
  }

  settings.providers = settings.providers.map((provider) => {
    const models = Array.isArray(provider.models)
      ? provider.models.map((model) => model.trim()).filter(Boolean)
      : [];
    const defaultModel = provider.defaultModel?.trim() || models[0] || "";

    return {
      ...createProviderConfig(),
      ...provider,
      defaultModel,
      models
    };
  });

  return settings;
}
