import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assessResources,
  applyAirtableBaseOverride,
  applyTurnstileSiteKeyOverride,
  assertEnvironmentIsolation,
  assertProductionConfirmation,
  getCustomDomainUrls,
  getDeploymentSmokeUrls,
  getResourcePlan,
  isMissingWorkerError,
  parseD1List,
  parseArguments,
  parseQueueList,
  parseR2List,
  renderDeploymentConfig,
  smokeDeployments,
} from "./provision";
import {
  extractDeploymentVersionId,
  getActiveVersionId,
  getRollbackVersionId,
  parseDeploymentList,
} from "./release";

const configuredPreviewBaseId = ["app", "1234567890ABCD"].join("");
const configuredProductionBaseId = ["app", "ZYXWVUTSRQPONM"].join("");
const configuredTurnstileSiteKey = "0x4AAAAAAAAAAAAAAAAAAAAAA";

const config = {
  $schema: "../../node_modules/wrangler/config-schema.json",
  name: "sessionbox-killer",
  main: "src/index.ts",
  assets: { directory: "../../apps/web/dist" },
  exports: {
    BaseAuthority: { storage: "sqlite", type: "durable-object" },
  },
  analytics_engine_datasets: [
    {
      binding: "OBSERVABILITY",
      dataset: "sessionbox_killer_observability_local",
    },
  ],
  triggers: { crons: ["17 3 * * *"] },
  version_metadata: { binding: "WORKER_VERSION" },
  env: {
    preview: {
      name: "sessionbox-killer-preview",
      workers_dev: true,
      preview_urls: false,
      routes: [
        {
          pattern: "preview.opensessionboard.com",
          custom_domain: true,
        },
      ],
      durable_objects: {
        bindings: [{ class_name: "BaseAuthority", name: "BASE_AUTHORITY" }],
      },
      triggers: { crons: ["17 3 * * *"] },
      vars: {
        APP_ENV: "preview",
        AIRTABLE_BASE_ID: configuredPreviewBaseId,
        TURNSTILE_SITE_KEY: configuredTurnstileSiteKey,
        FEATURE_FLAGS: {
          ai: false,
          embeds: false,
          email: false,
          integrations: false,
          webhooks: false,
          writes: true,
        },
      },
      analytics_engine_datasets: [
        {
          binding: "OBSERVABILITY",
          dataset: "sessionbox_killer_observability_preview",
        },
      ],
      d1_databases: [
        {
          binding: "DB",
          database_name: "sessionbox-killer-preview",
          migrations_dir: "../../migrations",
        },
      ],
      r2_buckets: [
        {
          binding: "UPLOADS",
          bucket_name: "sessionbox-killer-uploads-preview",
        },
      ],
      queues: {
        producers: [{ binding: "EMAIL_QUEUE", queue: "email-send-preview" }],
        consumers: [
          {
            queue: "email-send-preview",
            dead_letter_queue: "email-send-preview-dlq",
          },
        ],
      },
    },
  },
};

function isolatedConfig(): Parameters<typeof getResourcePlan>[0] {
  const isolated = structuredClone(config) as Parameters<
    typeof getResourcePlan
  >[0];
  const preview = isolated.env?.preview;
  if (!preview) {
    throw new Error("Expected preview configuration.");
  }
  const production = structuredClone(preview);
  production.name = "sessionbox-killer-prod";
  if (production.vars) {
    production.vars.AIRTABLE_BASE_ID = configuredProductionBaseId;
  }
  if (production.d1_databases?.[0]) {
    production.d1_databases[0].database_name = "sessionbox-killer-production";
  }
  if (production.r2_buckets?.[0]) {
    production.r2_buckets[0].bucket_name =
      "sessionbox-killer-uploads-production";
  }
  if (production.queues?.producers?.[0]) {
    production.queues.producers[0].queue = "email-send-production";
  }
  if (production.queues?.consumers?.[0]) {
    production.queues.consumers[0].queue = "email-send-production";
    production.queues.consumers[0].dead_letter_queue =
      "email-send-production-dlq";
  }
  if (production.routes?.[0]) {
    production.routes[0].pattern = "opensessionboard.com";
  }
  if (production.analytics_engine_datasets?.[0]) {
    production.analytics_engine_datasets[0].dataset =
      "sessionbox_killer_observability_production";
  }
  isolated.env = { ...isolated.env, production };
  return isolated;
}

describe("Cloudflare provisioner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("derives the resource plan from Wrangler's source config", () => {
    expect(getResourcePlan(config, "preview")).toEqual({
      environment: "preview",
      workerName: "sessionbox-killer-preview",
      workersDev: true,
      smokeUrls: ["https://preview.opensessionboard.com"],
      d1: { binding: "DB", name: "sessionbox-killer-preview" },
      r2: {
        binding: "UPLOADS",
        name: "sessionbox-killer-uploads-preview",
      },
      queues: [
        { binding: "EMAIL_QUEUE", name: "email-send-preview" },
        {
          binding: "DEAD_LETTER_QUEUE_1",
          name: "email-send-preview-dlq",
        },
      ],
    });
  });

  it("rejects an unconfigured Airtable base before remote operations", () => {
    const unconfigured = structuredClone(config);
    unconfigured.env.preview.vars.AIRTABLE_BASE_ID = "app_CONFIGURE_PREVIEW";

    expect(() => getResourcePlan(unconfigured, "preview")).toThrow(
      "preview must declare a configured Airtable base ID",
    );
  });

  it("rejects an unconfigured Turnstile site key before remote operations", () => {
    const unconfigured = structuredClone(config);
    unconfigured.env.preview.vars.TURNSTILE_SITE_KEY =
      "CONFIGURE_TURNSTILE_SITE_KEY";

    expect(() => getResourcePlan(unconfigured, "preview")).toThrow(
      "preview must declare a configured non-test Turnstile site key",
    );
  });

  it.each([
    "1x00000000000000000000AA",
    "2x00000000000000000000AB",
    "1x00000000000000000000BB",
    "2x00000000000000000000BB",
    "3x00000000000000000000FF",
  ])("rejects Cloudflare's documented test site key %s", (siteKey) => {
    const testConfigured = structuredClone(config);
    testConfigured.env.preview.vars.TURNSTILE_SITE_KEY = siteKey;

    expect(() => getResourcePlan(testConfigured, "preview")).toThrow(
      "preview must declare a configured non-test Turnstile site key",
    );
  });

  it("recognizes only Cloudflare's exact missing-Worker response", () => {
    expect(
      isMissingWorkerError(
        new Error("This Worker does not exist on your account. [code: 10007]"),
      ),
    ).toBe(true);
    expect(
      isMissingWorkerError(
        new Error("Authentication failed while listing deployments."),
      ),
    ).toBe(false);
    expect(isMissingWorkerError("[code: 10007]")).toBe(false);
  });

  it("injects a selected Airtable base without committing its identifier", () => {
    const publicConfig = structuredClone(config);
    publicConfig.env.preview.vars.AIRTABLE_BASE_ID = "app_CONFIGURE_PREVIEW";

    const configured = applyAirtableBaseOverride(
      publicConfig,
      "preview",
      configuredPreviewBaseId,
    );

    expect(configured.env?.preview?.vars?.AIRTABLE_BASE_ID).toBe(
      configuredPreviewBaseId,
    );
    expect(() =>
      applyAirtableBaseOverride(publicConfig, "preview", "invalid"),
    ).toThrow("AIRTABLE_PREVIEW_BASE_ID");
  });

  it("injects a selected Turnstile site key without committing it", () => {
    const publicConfig = structuredClone(config);
    publicConfig.env.preview.vars.TURNSTILE_SITE_KEY =
      "CONFIGURE_TURNSTILE_SITE_KEY";

    const configured = applyTurnstileSiteKeyOverride(
      publicConfig,
      "preview",
      configuredTurnstileSiteKey,
    );

    expect(configured.env?.preview?.vars?.TURNSTILE_SITE_KEY).toBe(
      configuredTurnstileSiteKey,
    );
    expect(() =>
      applyTurnstileSiteKeyOverride(
        publicConfig,
        "preview",
        "1x00000000000000000000AA",
      ),
    ).toThrow("TURNSTILE_PREVIEW_SITE_KEY");
    expect(() =>
      applyTurnstileSiteKeyOverride(
        publicConfig,
        "preview",
        "CONFIGURE_TURNSTILE_SITE_KEY",
      ),
    ).toThrow("TURNSTILE_PREVIEW_SITE_KEY");
  });

  it("rejects matching Airtable overrides before either remote plan", () => {
    const publicConfig = isolatedConfig();
    const preview = publicConfig.env?.preview;
    const production = publicConfig.env?.production;
    if (!preview?.vars || !production?.vars) {
      throw new Error("Expected both remote environments.");
    }
    preview.vars.AIRTABLE_BASE_ID = "app_CONFIGURE_PREVIEW";
    production.vars.AIRTABLE_BASE_ID = "app_CONFIGURE_PRODUCTION";

    applyAirtableBaseOverride(publicConfig, "preview", configuredPreviewBaseId);
    applyAirtableBaseOverride(
      publicConfig,
      "production",
      configuredPreviewBaseId,
    );

    expect(() => getResourcePlan(publicConfig, "preview")).toThrow(
      "Airtable bases",
    );
  });

  it.each([
    "Worker names",
    "Airtable bases",
    "D1 databases",
    "R2 buckets",
    "Queues",
    "Custom Domains",
    "Analytics Engine datasets",
  ])("rejects shared preview and production %s", (resource) => {
    const shared = isolatedConfig();
    const preview = shared.env?.preview;
    const production = shared.env?.production;
    if (!preview || !production) {
      throw new Error("Expected both remote environments.");
    }

    if (resource === "Worker names" && preview.name) {
      production.name = preview.name;
    }
    if (resource === "Airtable bases" && production.vars && preview.vars) {
      production.vars.AIRTABLE_BASE_ID = preview.vars.AIRTABLE_BASE_ID;
    }
    if (resource === "D1 databases" && preview.d1_databases) {
      production.d1_databases = structuredClone(preview.d1_databases);
    }
    if (resource === "R2 buckets" && preview.r2_buckets) {
      production.r2_buckets = structuredClone(preview.r2_buckets);
    }
    if (resource === "Queues" && preview.queues) {
      production.queues = structuredClone(preview.queues);
    }
    if (resource === "Custom Domains" && preview.routes) {
      production.routes = structuredClone(preview.routes);
    }
    if (
      resource === "Analytics Engine datasets" &&
      preview.analytics_engine_datasets
    ) {
      production.analytics_engine_datasets = structuredClone(
        preview.analytics_engine_datasets,
      );
    }

    expect(() => assertEnvironmentIsolation(shared)).toThrow(resource);
  });

  it("requires an explicit workers.dev exposure policy", () => {
    const implicit = structuredClone(config) as Parameters<
      typeof getResourcePlan
    >[0];
    const preview = implicit.env?.preview;
    if (!preview) {
      throw new Error("Expected the test preview environment.");
    }
    delete preview.workers_dev;

    expect(() => getResourcePlan(implicit, "preview")).toThrow(
      "preview must declare an explicit workers_dev policy",
    );
  });

  it("derives smoke URLs from every exact Custom Domain", () => {
    expect(
      getCustomDomainUrls([
        {
          pattern: "preview.opensessionboard.com",
          custom_domain: true,
        },
        {
          pattern: "www.opensessionboard.com",
          custom_domain: true,
        },
        { pattern: "opensessionboard.com/*" },
      ]),
    ).toEqual([
      "https://preview.opensessionboard.com",
      "https://www.opensessionboard.com",
    ]);
    expect(getCustomDomainUrls(undefined)).toEqual([]);
    expect(() => getCustomDomainUrls([{ custom_domain: true }])).toThrow(
      "Custom Domain must declare an exact hostname",
    );
    expect(() =>
      getCustomDomainUrls([
        { pattern: "*.opensessionboard.com", custom_domain: true },
      ]),
    ).toThrow("Custom Domain must be an exact hostname");
  });

  it("release-gates every explicitly exposed endpoint", () => {
    const preview = getResourcePlan(config, "preview");

    expect(
      getDeploymentSmokeUrls(
        preview,
        "https://sessionbox-killer-preview.example.workers.dev",
      ),
    ).toEqual([
      "https://preview.opensessionboard.com",
      "https://sessionbox-killer-preview.example.workers.dev",
    ]);
    expect(() => getDeploymentSmokeUrls(preview, null)).toThrow(
      "Wrangler did not return a workers.dev deployment URL",
    );
    expect(
      getDeploymentSmokeUrls(
        { smokeUrls: preview.smokeUrls, workersDev: false },
        "https://ignored.example.workers.dev",
      ),
    ).toEqual(["https://preview.opensessionboard.com"]);
  });

  it("parses current Wrangler inventory formats", () => {
    expect(
      parseD1List('[{"name":"sessionbox-killer-preview","uuid":"db-id"}]').get(
        "sessionbox-killer-preview",
      ),
    ).toEqual({ id: "db-id" });
    expect(
      parseR2List("name:           sessionbox-killer-uploads-preview\n").has(
        "sessionbox-killer-uploads-preview",
      ),
    ).toBe(true);
    expect(
      parseQueueList(
        "│ 0123456789abcdef0123456789abcdef │ email-send-preview │ now │ now │ 0 │ 0 │",
      ).get("email-send-preview"),
    ).toEqual({ id: "0123456789abcdef0123456789abcdef" });
  });

  it("selects the latest single-version deployment independent of list order", () => {
    const deployments = parseDeploymentList(
      JSON.stringify([
        {
          id: "new-deployment",
          created_on: "2026-08-08T23:12:48.364584Z",
          versions: [
            {
              version_id: "86cf8c18-2fe6-4fc0-bacd-b84b59d0096e",
              percentage: 100,
            },
          ],
        },
        {
          id: "old-deployment",
          created_on: "2026-08-08T23:11:31.787381Z",
          versions: [
            {
              version_id: "29ab69e2-24dd-49d4-8a43-d0b71c3a1676",
              percentage: 100,
            },
          ],
        },
      ]),
    );

    expect(getActiveVersionId(deployments)).toBe(
      "86cf8c18-2fe6-4fc0-bacd-b84b59d0096e",
    );
    expect(getRollbackVersionId(deployments)).toBe(
      "29ab69e2-24dd-49d4-8a43-d0b71c3a1676",
    );
    expect(
      extractDeploymentVersionId(
        "Current Version ID: 86cf8c18-2fe6-4fc0-bacd-b84b59d0096e",
      ),
    ).toBe("86cf8c18-2fe6-4fc0-bacd-b84b59d0096e");
  });

  it("rejects split deployments in single-version release automation", () => {
    expect(() =>
      getActiveVersionId([
        {
          id: "split-deployment",
          createdOn: "2026-08-08T23:12:48.364584Z",
          versions: [
            {
              versionId: "86cf8c18-2fe6-4fc0-bacd-b84b59d0096e",
              percentage: 50,
            },
            {
              versionId: "29ab69e2-24dd-49d4-8a43-d0b71c3a1676",
              percentage: 50,
            },
          ],
        },
      ]),
    ).toThrow("split deployment");
  });

  it("requires an explicit valid rollback version", () => {
    expect(
      parseArguments([
        "rollback",
        "--environment",
        "preview",
        "--version-id",
        "86cf8c18-2fe6-4fc0-bacd-b84b59d0096e",
      ]),
    ).toMatchObject({
      command: "rollback",
      environment: "preview",
      versionId: "86cf8c18-2fe6-4fc0-bacd-b84b59d0096e",
    });
    expect(() =>
      parseArguments(["rollback", "--environment", "preview"]),
    ).toThrow("valid --version-id");
    expect(() =>
      parseArguments([
        "status",
        "--environment",
        "preview",
        "--version-id",
        "86cf8c18-2fe6-4fc0-bacd-b84b59d0096e",
      ]),
    ).toThrow("only valid with rollback");
  });

  it("accepts a read-only smoke command", () => {
    expect(parseArguments(["smoke", "--environment", "preview"])).toEqual({
      command: "smoke",
      confirmProduction: false,
      environment: "preview",
      location: "wnam",
      versionId: null,
    });
  });

  it("gives every Custom Domain request its own timeout budget", async () => {
    const signals: AbortSignal[] = [];
    const requests: Parameters<typeof fetch>[0][] = [];

    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      requests.push(input);
      if (init?.signal instanceof AbortSignal) {
        signals.push(init.signal);
      }

      const url = new URL(String(input));
      const requestId = "86cf8c18-2fe6-4fc0-bacd-b84b59d0096e";

      if (url.pathname === "/health/live") {
        return Promise.resolve(
          Response.json(
            { environment: "preview", status: "ok" },
            { headers: { "x-request-id": requestId } },
          ),
        );
      }

      if (url.pathname === "/health/ready") {
        return Promise.resolve(
          Response.json(
            { environment: "preview", status: "ready" },
            { headers: { "x-request-id": requestId } },
          ),
        );
      }

      return Promise.resolve(new Response("OpenSession"));
    });

    await expect(
      smokeDeployments(
        ["https://opensessionboard.com", "https://www.opensessionboard.com"],
        "preview",
      ),
    ).resolves.toMatchObject([
      { url: "https://opensessionboard.com" },
      { url: "https://www.opensessionboard.com" },
    ]);

    expect(signals).toHaveLength(6);
    expect(new Set(signals).size).toBe(6);
    expect(
      requests.every((request) =>
        new URL(String(request)).searchParams.has("__opensession_smoke"),
      ),
    ).toBe(true);
  });

  it("reports only missing resources as creates", () => {
    const plan = getResourcePlan(config, "preview");
    const resources = assessResources(plan, {
      d1: new Map([[plan.d1.name, { id: "db-id" }]]),
      r2: new Map(),
      queues: new Map(),
    });

    expect(resources.map(({ kind, status }) => [kind, status])).toEqual([
      ["D1", "ready"],
      ["R2", "create"],
      ["Queue", "create"],
      ["Queue", "create"],
    ]);
  });

  it("requires two independent production confirmations", () => {
    expect(() =>
      assertProductionConfirmation(
        "production",
        { confirmProduction: true },
        null,
      ),
    ).toThrow("Production requires");
    expect(() =>
      assertProductionConfirmation(
        "production",
        { confirmProduction: false },
        "production",
      ),
    ).toThrow("Production requires");
    expect(() =>
      assertProductionConfirmation(
        "production",
        { confirmProduction: true },
        "production",
      ),
    ).not.toThrow();
  });

  it("renders an ID-complete config without named environments", () => {
    const rendered = renderDeploymentConfig(config, "preview", {
      d1: { id: "db-id" },
    });

    expect(rendered).not.toHaveProperty("env");
    expect(rendered.name).toBe("sessionbox-killer-preview");
    expect(rendered.workers_dev).toBe(true);
    expect(rendered.preview_urls).toBe(false);
    expect(rendered.routes).toEqual([
      {
        pattern: "preview.opensessionboard.com",
        custom_domain: true,
      },
    ]);
    expect(rendered.main).toBe("../workers/app/src/index.ts");
    expect(rendered.assets.directory).toBe("../apps/web/dist");
    expect(rendered.version_metadata).toEqual({ binding: "WORKER_VERSION" });
    expect(rendered.triggers).toEqual({ crons: ["17 3 * * *"] });
    expect(rendered.vars).toEqual(config.env.preview.vars);
    expect(rendered.analytics_engine_datasets).toEqual(
      config.env.preview.analytics_engine_datasets,
    );
    expect(rendered.d1_databases[0]).toMatchObject({
      binding: "DB",
      database_id: "db-id",
      migrations_dir: "../migrations",
    });
    expect(rendered.exports).toEqual({
      BaseAuthority: {
        storage: "sqlite",
        type: "durable-object",
      },
    });
    expect(rendered.durable_objects).toEqual({
      bindings: [
        {
          class_name: "BaseAuthority",
          name: "BASE_AUTHORITY",
        },
      ],
    });
  });

  it("preserves the production endpoint exposure policy", () => {
    const productionConfig = structuredClone(config) as Parameters<
      typeof renderDeploymentConfig
    >[0];
    const preview = productionConfig.env?.preview;
    if (!preview || !productionConfig.env) {
      throw new Error("Expected the test preview environment.");
    }
    productionConfig.env.production = {
      ...preview,
      name: "sessionbox-killer-prod",
      preview_urls: false,
      workers_dev: false,
    };

    const rendered = renderDeploymentConfig(productionConfig, "production", {
      d1: { id: "production-db-id" },
    });

    expect(rendered.workers_dev).toBe(false);
    expect(rendered.preview_urls).toBe(false);
  });
});
