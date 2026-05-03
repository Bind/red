import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadDaemons } from "../../../../pkg/daemons/src/index";
import { buildDaemonProfile, buildFileSummary } from "./signals";

describe("buildFileSummary", () => {
  test("extracts real shell and preview deployment signals from repo files", async () => {
    const repoRoot = resolve(import.meta.dir, "../../../../");
    const previewDeploy = await readFile(resolve(repoRoot, "infra/preview/deploy.sh"), "utf8");
    const scriptRed = await readFile(resolve(repoRoot, "scripts/red"), "utf8");

    const previewSummary = buildFileSummary("infra/preview/deploy.sh", previewDeploy);
    const scriptSummary = buildFileSummary("scripts/red", scriptRed);

    expect(previewSummary).toContain("File path: infra/preview/deploy.sh");
    expect(previewSummary).toContain("Env vars:");
    expect(previewSummary).toContain("DOTENV_PRIVATE_KEY_PREVIEW");
    expect(previewSummary).toContain("Commands:");
    expect(previewSummary).toContain("ssh");
    expect(previewSummary).toContain("rsync");
    expect(previewSummary).toContain("Excerpt:");

    expect(scriptSummary).toContain("File path: scripts/red");
    expect(scriptSummary).toContain("Commands:");
    expect(scriptSummary).toContain("exec");
    expect(scriptSummary).toContain("Excerpt:");
    expect(scriptSummary).toContain("./apps/ctl/cli/shell/red");
  });
});

describe("buildDaemonProfile", () => {
  test("uses actual daemon markdown and tracked signals to build semantic profiles", async () => {
    const repoRoot = resolve(import.meta.dir, "../../../../");
    const { specs, errors } = await loadDaemons(repoRoot);
    expect(errors).toEqual([]);

    const docsDaemon = specs.find((spec) => spec.name === "docs-command-surface");
    const composeDaemon = specs.find((spec) => spec.name === "compose-contract");
    expect(docsDaemon).toBeDefined();
    expect(composeDaemon).toBeDefined();

    const docsProfile = buildDaemonProfile(docsDaemon!, {
      trackedSubjectNames: ["root_readme_command_surface"],
      trackedDependencyPaths: ["README.md", "scripts/red"],
      invariantNames: ["readme_cli_examples_match_entrypoints"],
    });
    const composeProfile = buildDaemonProfile(composeDaemon!, {
      trackedSubjectNames: ["preview_gateway_contract"],
      trackedDependencyPaths: ["infra/preview/deploy.sh", "infra/platform/gateway/envoy.yaml.template"],
      invariantNames: ["compose_ports_match_gateway_routes"],
    });

    expect(docsProfile).toContain("Daemon: docs-command-surface");
    expect(docsProfile).toContain("Routing categories:");
    expect(docsProfile).toContain("command-surface");
    expect(docsProfile).toContain("Tracked subjects: root_readme_command_surface");
    expect(docsProfile).toContain("Tracked dependency paths: README.md, scripts/red");
    expect(docsProfile).toContain("Invariant names: readme_cli_examples_match_entrypoints");

    expect(composeProfile).toContain("Daemon: compose-contract");
    expect(composeProfile).toContain("compose-topology");
    expect(composeProfile).toContain("preview_gateway_contract");
    expect(composeProfile).toContain(
      "Tracked dependency paths: infra/platform/gateway/envoy.yaml.template, infra/preview/deploy.sh",
    );
    expect(composeProfile).toContain("compose_ports_match_gateway_routes");
  });
});
