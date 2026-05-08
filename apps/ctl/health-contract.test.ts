import { describeHealthContract } from "@red/health";
import { type AppConfig, createApp } from "./index";

const testConfig: AppConfig = {
  port: 0,
  dbPath: ":memory:",
  repoBackend: {
    kind: "git_storage",
    publicUrl: "http://git-server.test",
    defaultOwner: "red",
    defaultBranch: "main",
    controlPlane: {
      baseUrl: "http://git-server.test",
      username: "admin",
      password: "admin",
    },
  },
  repos: [],
};

describeHealthContract({
  serviceName: "ctl",
  loadApp: () => {
    const { app } = createApp(testConfig);
    return app;
  },
});
