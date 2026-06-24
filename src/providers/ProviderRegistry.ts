import type { ProviderConfig } from "../settings/types";
import { OpenAICompatibleProvider } from "./OpenAICompatibleProvider";
import type { AiProvider } from "./types";

export class ProviderRegistry {
  createProvider(_config: ProviderConfig): AiProvider {
    return new OpenAICompatibleProvider();
  }
}
