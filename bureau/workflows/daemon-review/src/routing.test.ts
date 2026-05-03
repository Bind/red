import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadDaemons, type DaemonSpec } from "../../../../pkg/daemons/src/index";
import type { DaemonRoutingMemory } from "./routing-memory";
import { evaluateRouting, resetRoutingCachesForTests, routeDaemons } from "./routing";

function makeSpec(
  name: string,
  routingCategories: Array<{ name: string; description: string }>,
): DaemonSpec {
  return {
    name,
    description: `${name} desc`,
    file: `/tmp/${name}.daemon.md`,
    scopeRoot: "/tmp",
    body: "body",
    review: {
      maxTurns: 18,
      routingCategories,
    },
  };
}

describe("routeDaemons", () => {
  test("returns empty when no routing categories are declared", async () => {
    const specs = [makeSpec("docs-command-surface", [])];
    const routed = await routeDaemons(["README.md"], specs, {
      semanticScorerOverride: async () => new Map(),
    });
    expect(routed).toEqual([]);
  });

  test("routes files using the semantic scorer output", async () => {
    const specs = [
      makeSpec("docs-command-surface", [
        { name: "command-surface", description: "root docs and cli entrypoints" },
      ]),
      makeSpec("compose-contract", [
        { name: "compose-topology", description: "compose, ingress, and gateway topology" },
      ]),
      makeSpec("environment-boundaries", [
        { name: "infra-layering", description: "environment boundaries and preview operator surface" },
      ]),
      makeSpec("infra-audit", [
        { name: "infra-operator-workflow", description: "infra scripts, docs, and operator workflow" },
      ]),
    ];

    const semanticScorer = async (
      sequence: string,
      daemonProfiles: Array<{ daemonName: string; profile: string }>,
    ) => {
      const pathLine = sequence.split("\n")[0] ?? "";
      const path = pathLine.replace(/^File path: /, "");
      const byDaemon = new Map<string, number>();
      for (const daemon of daemonProfiles) {
        if (path === "README.md") {
          if (daemon.daemonName === "docs-command-surface") byDaemon.set(daemon.daemonName, 0.93);
          else if (daemon.daemonName === "infra-audit") byDaemon.set(daemon.daemonName, 0.11);
          else byDaemon.set(daemon.daemonName, 0.03);
        } else if (path === "infra/platform/gateway/envoy.yaml.template") {
          if (daemon.daemonName === "compose-contract") byDaemon.set(daemon.daemonName, 0.89);
          else if (daemon.daemonName === "environment-boundaries") byDaemon.set(daemon.daemonName, 0.85);
          else if (daemon.daemonName === "infra-audit") byDaemon.set(daemon.daemonName, 0.22);
          else byDaemon.set(daemon.daemonName, 0.01);
        } else if (path === "justfile") {
          if (daemon.daemonName === "docs-command-surface") byDaemon.set(daemon.daemonName, 0.72);
          else if (daemon.daemonName === "infra-audit") byDaemon.set(daemon.daemonName, 0.68);
          else byDaemon.set(daemon.daemonName, 0.09);
        }
      }
      return byDaemon;
    };

    const fileTextResolver = async (path: string) => `fixture content for ${path}`;

    const routed = await routeDaemons(
      ["README.md", "infra/platform/gateway/envoy.yaml.template", "justfile"],
      specs,
      {
        semanticScorerOverride: semanticScorer,
        fileTextResolver,
      },
    );

    expect(routed).toEqual([
      {
        name: "docs-command-surface",
        relevantFiles: ["justfile", "README.md"],
      },
      {
        name: "compose-contract",
        relevantFiles: ["infra/platform/gateway/envoy.yaml.template"],
      },
      {
        name: "environment-boundaries",
        relevantFiles: ["infra/platform/gateway/envoy.yaml.template"],
      },
      {
        name: "infra-audit",
        relevantFiles: ["justfile"],
      },
    ]);
  });

  test("supports openrouter embeddings as the semantic scorer backend", async () => {
    const specs = [
      makeSpec("docs-command-surface", [
        { name: "command-surface", description: "root docs and cli entrypoints" },
      ]),
      makeSpec("compose-contract", [
        { name: "compose-topology", description: "compose, ingress, and gateway topology" },
      ]),
    ];

    const originalFetch = globalThis.fetch;
    const originalApiKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "test-key";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://openrouter.ai/api/v1/embeddings");
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        input: string[];
      };
      expect(body.model).toBe("openai/text-embedding-3-small");
      expect(body.input).toHaveLength(3);
      return new Response(JSON.stringify({
        data: [
          { embedding: [1, 0] },
          { embedding: [0.9, 0.1] },
          { embedding: [0.1, 0.9] },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      resetRoutingCachesForTests();
      const routed = await routeDaemons(["README.md"], specs, {
        routerProviderOverride: "openrouter",
        routerModelOverride: "openai/text-embedding-3-small",
        fileTextResolver: async () => "fixture content",
      });

      expect(routed).toEqual([
        {
          name: "docs-command-surface",
          relevantFiles: ["README.md"],
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      resetRoutingCachesForTests();
      if (originalApiKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = originalApiKey;
      }
    }
  });

  test("reuses cached openrouter embeddings across repeated runs", async () => {
    const specs = [
      makeSpec("docs-command-surface", [
        { name: "command-surface", description: "root docs and cli entrypoints" },
      ]),
      makeSpec("compose-contract", [
        { name: "compose-topology", description: "compose, ingress, and gateway topology" },
      ]),
    ];

    const originalFetch = globalThis.fetch;
    const originalApiKey = process.env.OPENROUTER_API_KEY;
    const originalBackend = process.env.DAEMON_REVIEW_EMBEDDING_CACHE_BACKEND;
    let embeddingRequests = 0;
    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.DAEMON_REVIEW_EMBEDDING_CACHE_BACKEND = "none";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://openrouter.ai/api/v1/embeddings");
      embeddingRequests += 1;
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        input: string[];
      };
      expect(body.model).toBe("openai/text-embedding-3-small");
      expect(body.input).toHaveLength(3);
      return new Response(JSON.stringify({
        data: [
          { embedding: [1, 0] },
          { embedding: [0.9, 0.1] },
          { embedding: [0.1, 0.9] },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      resetRoutingCachesForTests();
      const options = {
        routerProviderOverride: "openrouter" as const,
        routerModelOverride: "openai/text-embedding-3-small",
        fileTextResolver: async () => "fixture content",
      };

      await routeDaemons(["README.md"], specs, options);
      await routeDaemons(["README.md"], specs, options);

      expect(embeddingRequests).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      resetRoutingCachesForTests();
      if (originalApiKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = originalApiKey;
      }
      if (originalBackend === undefined) {
        delete process.env.DAEMON_REVIEW_EMBEDDING_CACHE_BACKEND;
      } else {
        process.env.DAEMON_REVIEW_EMBEDDING_CACHE_BACKEND = originalBackend;
      }
    }
  });

  test("routes actual repo files with actual daemon specs", async () => {
    const repoRoot = resolve(import.meta.dir, "../../../../");
    const { specs, errors } = await loadDaemons(repoRoot);
    expect(errors).toEqual([]);

    const selected = specs.filter((spec) =>
      ["docs-command-surface", "compose-contract", "infra-audit"].includes(spec.name),
    );
    const changedFiles = ["README.md", "scripts/red", "infra/preview/deploy.sh"];

    const semanticScorer = async (
      sequence: string,
      daemonProfiles: Array<{ daemonName: string; profile: string }>,
    ) => {
      expect(sequence).toContain("File path:");
      expect(sequence).toContain("Excerpt:");
      const path = sequence.split("\n")[0]?.replace("File path: ", "") ?? "";
      const scores = new Map<string, number>();
      for (const daemon of daemonProfiles) {
        if (path === "README.md") {
          scores.set(daemon.daemonName, daemon.daemonName === "docs-command-surface" ? 0.94 : 0.08);
          continue;
        }
        if (path === "scripts/red") {
          scores.set(daemon.daemonName, daemon.daemonName === "docs-command-surface" ? 0.88 : 0.05);
          continue;
        }
        if (path === "infra/preview/deploy.sh") {
          if (daemon.daemonName === "compose-contract") scores.set(daemon.daemonName, 0.91);
          else if (daemon.daemonName === "infra-audit") scores.set(daemon.daemonName, 0.86);
          else scores.set(daemon.daemonName, 0.04);
          continue;
        }
        scores.set(daemon.daemonName, 0);
      }
      return scores;
    };

    const routed = await routeDaemons(changedFiles, selected, {
      semanticScorerOverride: semanticScorer,
    });

    expect(routed).toEqual([
      {
        name: "compose-contract",
        relevantFiles: ["infra/preview/deploy.sh"],
      },
      {
        name: "docs-command-surface",
        relevantFiles: ["README.md", "scripts/red"],
      },
      {
        name: "infra-audit",
        relevantFiles: ["infra/preview/deploy.sh"],
      },
    ]);
  });

  test("structured memory boosts route real repo files even when semantic scores are weak", async () => {
    const repoRoot = resolve(import.meta.dir, "../../../../");
    const { specs, errors } = await loadDaemons(repoRoot);
    expect(errors).toEqual([]);

    const selected = specs.filter((spec) =>
      ["compose-contract", "infra-audit"].includes(spec.name),
    );
    const changedFiles = ["infra/preview/deploy.sh", "infra/preview/seed.sh"];
    const memoryByDaemon = new Map<string, DaemonRoutingMemory>([
      [
        "compose-contract",
        {
          checkedFiles: [],
          dependencyFiles: ["infra/preview/deploy.sh"],
          trackedSubjects: ["preview_gateway_contract"],
          staleTrackedSubjects: [],
        },
      ],
      [
        "infra-audit",
        {
          checkedFiles: ["infra/preview/deploy.sh"],
          dependencyFiles: [],
          trackedSubjects: ["preview_operator_surface"],
          staleTrackedSubjects: [],
        },
      ],
    ]);

    const semanticScorer = async (
      _sequence: string,
      daemonProfiles: Array<{ daemonName: string; profile: string }>,
    ) => new Map(daemonProfiles.map((daemon) => [daemon.daemonName, 0.12]));

    const routed = await routeDaemons(changedFiles, selected, {
      semanticScorerOverride: semanticScorer,
      memoryByDaemon,
    });

    expect(routed).toEqual([
      {
        name: "compose-contract",
        relevantFiles: ["infra/preview/deploy.sh", "infra/preview/seed.sh"],
      },
      {
        name: "infra-audit",
        relevantFiles: ["infra/preview/seed.sh"],
      },
    ]);
  });

  test("exposes per-file debug scoring details", async () => {
    const specs = [
      makeSpec("docs-command-surface", [
        { name: "command-surface", description: "root docs and cli entrypoints" },
      ]),
      makeSpec("infra-audit", [
        { name: "infra-operator-workflow", description: "infra scripts and operator workflow" },
      ]),
    ];

    const evaluation = await evaluateRouting(["README.md"], specs, {
      semanticScorerOverride: async () =>
        new Map([
          ["docs-command-surface", 0.82],
          ["infra-audit", 0.33],
        ]),
      fileTextResolver: async () => "fixture content",
    });

    expect(evaluation.routedDaemons).toEqual([
      {
        name: "docs-command-surface",
        relevantFiles: ["README.md"],
      },
    ]);
    expect(evaluation.fileDebug).toHaveLength(1);
    expect(evaluation.fileDebug[0]?.file).toBe("README.md");
    expect(evaluation.fileDebug[0]?.selectedDaemons).toEqual(["docs-command-surface"]);
    expect(evaluation.fileDebug[0]?.mode).toBe("memory_embedding");
    expect(evaluation.fileDebug[0]?.scores[0]).toMatchObject({
      daemonName: "docs-command-surface",
      semanticScore: 0.82,
      selected: true,
    });
  });

  test("supports memory_only mode", async () => {
    const specs = [
      makeSpec("compose-contract", [{ name: "compose-topology", description: "compose topology" }]),
      makeSpec("infra-audit", [{ name: "infra-operator-workflow", description: "infra workflow" }]),
    ];
    const memoryByDaemon = new Map<string, DaemonRoutingMemory>([
      [
        "compose-contract",
        {
          checkedFiles: [],
          dependencyFiles: ["infra/preview/deploy.sh"],
          trackedSubjects: ["preview_gateway_contract"],
          staleTrackedSubjects: [],
        },
      ],
      [
        "infra-audit",
        {
          checkedFiles: ["infra/preview/deploy.sh"],
          dependencyFiles: [],
          trackedSubjects: ["preview_operator_surface"],
          staleTrackedSubjects: [],
        },
      ],
    ]);

    const routed = await routeDaemons(["infra/preview/deploy.sh"], specs, {
      semanticScorerOverride: async (sequence, daemonProfiles) =>
        new Map(daemonProfiles.map((daemon) => [daemon.daemonName, sequence.includes("deploy") ? 0.01 : 0])),
      memoryByDaemon,
      modeOverride: "memory_only",
    });

    expect(routed).toEqual([
      { name: "compose-contract", relevantFiles: ["infra/preview/deploy.sh"] },
    ]);
  });

  test("supports embedding_only mode", async () => {
    const specs = [
      makeSpec("docs-command-surface", [{ name: "command-surface", description: "docs" }]),
      makeSpec("infra-audit", [{ name: "infra-operator-workflow", description: "infra workflow" }]),
    ];

    const routed = await routeDaemons(["README.md"], specs, {
      semanticScorerOverride: async () =>
        new Map([
          ["docs-command-surface", 0.6],
          ["infra-audit", 0.2],
        ]),
      modeOverride: "embedding_only",
    });

    expect(routed).toEqual([
      { name: "docs-command-surface", relevantFiles: ["README.md"] },
    ]);
  });

  test("supports memory_embedding_librarian mode", async () => {
    const specs = [
      makeSpec("compose-contract", [{ name: "compose-topology", description: "compose topology" }]),
      makeSpec("environment-boundaries", [{ name: "infra-layering", description: "env boundaries" }]),
      makeSpec("infra-audit", [{ name: "infra-operator-workflow", description: "infra workflow" }]),
    ];

    const evaluation = await evaluateRouting(["infra/preview/deploy.sh"], specs, {
      semanticScorerOverride: async () =>
        new Map([
          ["compose-contract", 0.4],
          ["environment-boundaries", 0.55],
          ["infra-audit", 0.52],
        ]),
      memoryByDaemon: new Map(),
      modeOverride: "memory_embedding_librarian",
      librarianOverride: async ({ candidates }) => ({
        selectedDaemons: candidates
          .filter((candidate) => candidate.daemonName !== "environment-boundaries")
          .map((candidate) => candidate.daemonName),
        rationale: "prefer topology and audit over broad environment routing",
        confidence: 0.81,
      }),
    });

    expect(evaluation.routedDaemons).toEqual([
      { name: "compose-contract", relevantFiles: ["infra/preview/deploy.sh"] },
      { name: "infra-audit", relevantFiles: ["infra/preview/deploy.sh"] },
    ]);
    expect(evaluation.fileDebug[0]?.mode).toBe("memory_embedding_librarian");
    expect(evaluation.fileDebug[0]?.librarianRationale).toBe(
      "prefer topology and audit over broad environment routing",
    );
    expect(evaluation.fileDebug[0]?.librarianConfidence).toBe(0.81);
  });
});
