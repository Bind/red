import type { DaemonRoutingMemory } from "./routing-memory";

export type RoutingTrainingCase = {
  name: string;
  files: string[];
  expectedByFile: Record<string, string[]>;
  memoryByDaemon?: Record<string, DaemonRoutingMemory>;
};

export const ROUTING_TRAINING_SET: RoutingTrainingCase[] = [
  {
    name: "docs_only",
    files: ["README.md", "scripts/red"],
    expectedByFile: {
      "README.md": ["docs-command-surface"],
      "scripts/red": ["docs-command-surface"],
    },
  },
  {
    name: "preview_ops",
    files: ["infra/preview/deploy.sh", "infra/preview/seed.sh"],
    expectedByFile: {
      "infra/preview/deploy.sh": ["compose-contract", "infra-audit", "environment-boundaries"],
      "infra/preview/seed.sh": ["compose-contract", "infra-audit"],
    },
    memoryByDaemon: {
      "compose-contract": {
        checkedFiles: [],
        dependencyFiles: ["infra/preview/deploy.sh"],
        trackedSubjects: ["preview_gateway_contract"],
        staleTrackedSubjects: [],
      },
      "infra-audit": {
        checkedFiles: ["infra/preview/deploy.sh"],
        dependencyFiles: [],
        trackedSubjects: ["preview_operator_surface"],
        staleTrackedSubjects: [],
      },
      "environment-boundaries": {
        checkedFiles: ["infra/preview/deploy.sh"],
        dependencyFiles: ["infra/preview/deploy.sh"],
        trackedSubjects: ["preview_environment_contract"],
        staleTrackedSubjects: [],
      },
    },
  },
  {
    name: "mixed_surface",
    files: ["README.md", "infra/platform/gateway/envoy.yaml.template", "justfile"],
    expectedByFile: {
      "README.md": ["docs-command-surface"],
      "infra/platform/gateway/envoy.yaml.template": ["compose-contract", "environment-boundaries"],
      "justfile": ["docs-command-surface", "infra-audit"],
    },
  },
];
