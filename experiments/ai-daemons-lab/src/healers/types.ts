export type SummarizeInput = {
  changeId: string;
  title: string;
  commitSha: string;
};

export type Healer = {
  readonly name: string;
  summarize(input: SummarizeInput): Promise<string>;
};
