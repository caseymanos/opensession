import { createServer } from "node:http";
import { build } from "esbuild";

import { createTestHarness } from "wrangler";

const hostname = "127.0.0.1";
const port = 8787;
const origin = `http://${hostname}:${port}`;
const harness = createTestHarness({
  workers: [
    {
      configPath: "workers/app/wrangler.jsonc",
      secrets: {
        AUTH_HASH_PEPPER:
          "portal-browser-proof-pepper-with-at-least-32-characters",
      },
      vars: {
        FEATURE_FLAGS: {
          ai: false,
          embeds: false,
          email: true,
          integrations: false,
          webhooks: false,
          writes: true,
        },
      },
    },
  ],
});

await harness.listen();
const worker = harness.getWorker();
const migrateD1 = worker["apply" + "D1Migrations"].bind(worker);
await migrateD1("DB");
const fixtureBundle = await build({
  bundle: true,
  entryPoints: ["tests/e2e/portal-authority-fixture.ts"],
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const fixtureSource = fixtureBundle.outputFiles[0]?.text;
if (!fixtureSource) throw new Error("Portal authority fixture did not build.");
const fixtureModule = await import(
  `data:text/javascript;base64,${Buffer.from(fixtureSource).toString("base64")}`
);
const environment = await worker.getEnv();
await fixtureModule.seedPortalAuthorityBrowserProof(environment.DB);
let invitationCounter = 0;

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const server = createServer(async (incoming, outgoing) => {
  try {
    const requestUrl = new URL(incoming.url ?? "/", origin);
    if (
      incoming.method === "POST" &&
      requestUrl.pathname === fixtureModule.portalAuthorityInvitationEndpoint
    ) {
      invitationCounter += 1;
      const token = await fixtureModule.issuePortalAuthorityBrowserProof(
        environment.DB,
        origin,
        `run_${invitationCounter}`,
      );
      outgoing.writeHead(201, {
        "Cache-Control": "no-store",
        "Content-Type": "application/json",
      });
      outgoing.end(JSON.stringify({ token }));
      return;
    }
    const headers = [];
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) {
        for (const item of value) headers.push([name, item]);
      } else if (value !== undefined) {
        headers.push([name, value]);
      }
    }

    const method = incoming.method ?? "GET";
    const body =
      method === "GET" || method === "HEAD"
        ? undefined
        : await requestBody(incoming);
    const response = await harness.fetch(
      new URL(incoming.url ?? "/", origin).toString(),
      {
        method,
        headers,
        ...(body?.byteLength ? { body } : {}),
      },
    );

    const responseHeaders = Object.fromEntries(response.headers);
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) responseHeaders["set-cookie"] = cookies;
    outgoing.writeHead(response.status, responseHeaders);
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(error);
    if (!outgoing.headersSent) outgoing.writeHead(500);
    outgoing.end();
  }
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  await harness.close();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

server.listen(port, hostname, () => {
  console.log(`E2E Worker listening on ${origin}`);
});
