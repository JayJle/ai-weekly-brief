import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { MODEL_PROVIDER_DEFINITIONS, type ModelProvider } from "../config.js";

export interface ProviderModelSummary {
  provider: ModelProvider;
  label: string;
  keyEnvironment?: string;
  defaultMainModel: string;
  defaultResearchModel: string;
  modelCount: number;
}

export async function listConfiguredProviderModels(provider?: string, query = ""): Promise<unknown> {
  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  if (!provider) {
    return Object.entries(MODEL_PROVIDER_DEFINITIONS).map(([id, definition]) => {
      const result: ProviderModelSummary = {
        provider: id as ModelProvider,
        label: definition.label,
        defaultMainModel: definition.mainModel,
        defaultResearchModel: definition.researchModel,
        modelCount: id === "mock" ? 2 : runtime.getModels(id).length,
      };
      if (definition.keyEnv) result.keyEnvironment = definition.keyEnv;
      return result;
    });
  }

  if (!Object.hasOwn(MODEL_PROVIDER_DEFINITIONS, provider)) {
    throw new Error(`配置向导暂不支持该 Provider：${provider}`);
  }
  if (provider === "mock") return ["mock-main", "mock-research"];
  const normalizedQuery = query.trim().toLowerCase();
  return runtime.getModels(provider)
    .filter((model) => !normalizedQuery || `${model.id} ${model.name}`.toLowerCase().includes(normalizedQuery))
    .map((model) => ({ id: model.id, name: model.name, reasoning: model.reasoning, contextWindow: model.contextWindow }));
}
