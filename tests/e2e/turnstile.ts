import type { Page } from "@playwright/test";

export async function mockTurnstile(page: Page): Promise<void> {
  await page.route("**/api/v1/public/security/turnstile", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ site_key: "1x00000000000000000000AA" }),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.route("**/turnstile/v0/api.js?render=explicit", async (route) => {
    await route.fulfill({
      body: `(() => {
        let sequence = 0;
        const widgets = new Map();
        window.turnstile = {
          render(container, options) {
            const id = "test-widget-" + (++sequence);
            widgets.set(id, options);
            container.textContent = "Security check complete";
            queueMicrotask(() => options.callback("test-token-" + sequence));
            return id;
          },
          remove(id) { widgets.delete(id); },
          reset(id) {
            const options = widgets.get(id);
            if (options) queueMicrotask(() => options.callback("test-token-" + (++sequence)));
          },
        };
      })();`,
      contentType: "text/javascript",
      status: 200,
    });
  });
}
