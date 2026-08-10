import { createServer } from "node:http";

import { createTestHarness } from "wrangler";

const hostname = "127.0.0.1";
const port = 8787;
const origin = `http://${hostname}:${port}`;
const harness = createTestHarness({
  workers: [{ configPath: "workers/app/wrangler.jsonc" }],
});

await harness.listen();

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const server = createServer(async (incoming, outgoing) => {
  try {
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
