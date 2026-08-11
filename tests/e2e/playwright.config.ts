import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 8787);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("E2E_PORT must be a valid TCP port.");
}
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: ".",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["blob"], ["github"]] : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "pnpm preview:e2e",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    url: `${baseURL}/health/live`,
  },
});
