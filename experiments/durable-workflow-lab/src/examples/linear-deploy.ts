export const linearDeployExample = `
import { workflow } from "@red/workflows";

export default workflow("deploy", async ({ input, step, sh }) => {
  await step("clone", async () => {
    await sh\`git clone \${input.repoUrl} repo\`;
    await sh\`git -C repo checkout \${input.branch}\`;
  });

  const build = await step("build", async () => {
    await sh\`make -C repo build\`;
    return { artifactPath: "repo/dist/app.tgz" };
  });

  await step("publish", async () => {
    await sh\`deploy \${build.artifactPath}\`;
  });
});
`.trim();
