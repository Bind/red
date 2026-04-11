export const typedOutputExample = `
import { z } from "zod";
import { workflow } from "@redc/workflows";

export default workflow("build-release", async ({ input, step, sh }) => {
  await step("install", async () => {
    await sh\`bun install\`;
  });

  const build = await step(
    "build",
    {
      output: z.object({
        version: z.string(),
        artifactPath: z.string(),
      }),
    },
    async () => {
      await sh\`bun run build\`;
      const version = (await sh\`node -p "require('./package.json').version"\`.text()).trim();
      return {
        version,
        artifactPath: \`dist/app-\${version}.tgz\`,
      };
    },
  );

  await step("announce", async () => {
    await sh\`echo built \${build.artifactPath} for version \${build.version}\`;
  });
});
`.trim();
