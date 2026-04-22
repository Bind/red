export const branchOnResultExample = `
import { workflow } from "@red/workflows";

export default workflow("conditional-deploy", async ({ step, sh }) => {
  const checks = await step("checks", async () => {
    const status = (await sh\`./scripts/health-check\`.text()).trim();
    return {
      healthy: status === "ok",
    };
  });

  if (!checks.healthy) {
    await step("abort", async () => {
      await sh\`echo refusing to deploy because health checks failed\`;
    });
    return { deployed: false };
  }

  await step("deploy", async () => {
    await sh\`./scripts/deploy\`;
  });

  return { deployed: true };
});
`.trim();
