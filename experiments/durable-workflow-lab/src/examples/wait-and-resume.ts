export const waitAndResumeExample = `
import { workflow } from "@red/workflows";

export default workflow("rollout-check", async ({ input, step, sh, sleep }) => {
  await step("deploy", async () => {
    await sh\`./scripts/start-rollout \${input.releaseId}\`;
  });

  await step("settle", async () => {
    await sleep("5m");
  });

  const verify = await step("verify", async () => {
    const status = (await sh\`./scripts/rollout-status \${input.releaseId}\`.text()).trim();
    return { status };
  });

  if (verify.status !== "healthy") {
    await step("rollback", async () => {
      await sh\`./scripts/rollback \${input.releaseId}\`;
    });
  }
});
`.trim();
