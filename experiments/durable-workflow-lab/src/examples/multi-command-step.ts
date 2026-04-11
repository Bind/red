export const multiCommandStepExample = `
import { workflow } from "@redc/workflows";

export default workflow("package-app", async ({ step, sh }) => {
  const pkg = await step("package", async () => {
    await sh\`bun install\`;
    await sh\`bun test\`;
    await sh\`bun run build\`;
    const sha = (await sh\`git rev-parse HEAD\`.text()).trim();
    return {
      sha,
      tarball: \`dist/app-\${sha.slice(0, 8)}.tgz\`,
    };
  });

  await step("report", async () => {
    await sh\`echo packaged \${pkg.tarball}\`;
  });
});
`.trim();
