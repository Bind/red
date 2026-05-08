process.stdout.write(`${JSON.stringify({ type: "turn_start", turnIndex: 1 })}\n`);
process.stdout.write(
  `${JSON.stringify({
    type: "tool_call",
    turnIndex: 1,
    toolName: "read",
    args: { path: "README.md" },
  })}\n`,
);
process.stdout.write(
  `${JSON.stringify({
    type: "assistant_text_delta",
    turnIndex: 1,
    delta: "remote delta",
  })}\n`,
);
process.stdout.write(
  `${JSON.stringify({
    type: "turn_end",
    turnIndex: 1,
    info: {
      tokens: { input: 2, output: 3 },
      completeCalled: true,
    },
  })}\n`,
);
process.stdout.write(
  `${JSON.stringify({
    type: "result",
    result: {
      ok: true,
      payload: {
        summary: "callback fixture completed",
        findings: [],
      },
      turns: 1,
      tokens: { input: 2, output: 3 },
      session: {
        systemPrompt: "callback test",
        messages: [
          { role: "user", content: "stream please" },
          { role: "assistant", content: "callback fixture completed" },
        ],
      },
    },
  })}\n`,
);
