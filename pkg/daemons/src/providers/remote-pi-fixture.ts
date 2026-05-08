const input = JSON.parse(await new Response(process.stdin).text()) as {
  systemPrompt: string;
  initialInput: string;
};

process.stdout.write(
  `${JSON.stringify({
    type: "result",
    result: {
      ok: true,
      payload: {
        summary: "remote provider completed",
        findings: [],
      },
      turns: 1,
      tokens: { input: 4, output: 7 },
      session: {
        systemPrompt: input.systemPrompt,
        messages: [
          { role: "user", content: input.initialInput },
          { role: "assistant", content: "remote provider completed" },
        ],
      },
    },
  })}\n`,
);
