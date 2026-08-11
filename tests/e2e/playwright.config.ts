import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 8787);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("E2E_PORT must be a valid TCP port.");
}
const localBaseURL = `http://127.0.0.1:${port}`;
const remoteBaseURL = process.env.E2E_BASE_URL?.trim();
if (remoteBaseURL) {
  const parsed = new URL(remoteBaseURL);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("E2E_BASE_URL must be a credential-free HTTPS origin.");
  }
}
const baseURL = remoteBaseURL ?? localBaseURL;
const projects = [
  { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
  { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ...(process.env.E2E_CROSS_BROWSER === "1"
    ? [
        { name: "desktop-firefox", use: { ...devices["Desktop Firefox"] } },
        { name: "desktop-webkit", use: { ...devices["Desktop Safari"] } },
      ]
    : []),
];

export default defineConfig({
  testDir: ".",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["blob"], ["github"]] : "list",
  use: {
    baseURL,
    screenshot: "only-on-failure",
    trace: remoteBaseURL ? "off" : "on-first-retry",
    video: "retain-on-failure",
  },
  projects,
  webServer: remoteBaseURL
    ? undefined
    : {
        command: "pnpm preview:e2e",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        url: `${localBaseURL}/health/live`,
      },
});
