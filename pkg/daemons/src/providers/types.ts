export type ProviderTurn = {
  finalResponse: string;
  usage: { inputTokens: number; outputTokens: number } | null;
};

export type ProviderSession = {
  run(input: string): Promise<ProviderTurn>;
  stop(): Promise<void>;
};

export type ProviderSpawnOptions = {
  cwd: string;
  systemPrompt: string;
};

export type AgentProvider = {
  name: string;
  spawn(opts: ProviderSpawnOptions): Promise<ProviderSession>;
};
