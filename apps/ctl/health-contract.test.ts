import { describeHealthContract } from "@redc/health";
import { createApp, type AppConfig } from "./index";

const testConfig: AppConfig = {
  port: 0,
  dbPath: ":memory:",
  repoBackend: {
    kind: "git_storage",
    publicUrl: "http://git-server.test",
    defaultOwner: "redc",
    defaultBranch: "main",
    controlPlane: {
      baseUrl: "http://git-server.test",
      username: "admin",
      password: "admin",
    },
  },
  repos: [],
  artifacts: {
    minio: {
      endPoint: "localhost",
      port: 9000,
      useSSL: false,
      accessKey: "minioadmin",
      secretKey: "minioadmin",
      bucket: "test-artifacts",
      prefix: "claw-runs",
    },
  },
};

describeHealthContract({
  serviceName: "ctl",
  loadApp: () => {
    const { app } = createApp(testConfig);
    return app;
  },
});
