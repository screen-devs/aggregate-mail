export const agentProviders = {
  openai: { name: "OpenAI", baseURL: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
  deepseek: { name: "DeepSeek", baseURL: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  custom: { name: "Other OpenAI-compatible", baseURL: "", model: "" },
} as const;
export type AgentProvider = keyof typeof agentProviders;
// Credentials never belong in the renderer's saved-settings shape.
export type AgentProviderSettings = {
  provider: AgentProvider;
  baseURL: string;
  model: string;
  hasKey: boolean;
  revision: string;
};
