import { test as base, expect, type Page } from "@playwright/test";

export { expect };

/**
 * The browser mock's Proxmox storage only accepts Import once the user agreed
 * to enable it, so the configure step asks first. A revisit of the same server
 * in the same page finds it enabled and does not ask again.
 */
export async function approveProxmoxImport(page: Page) {
  const enable = page.getByRole("button", {
    name: "Enable Import...",
    exact: true,
  });
  const next = page.getByRole("button", { name: "Next", exact: true });
  await expect
    .poll(async () => (await enable.isVisible()) || (await next.isEnabled()))
    .toBe(true);
  if (!(await enable.isVisible())) return;

  await enable.click();
  await page
    .getByRole("button", { name: "Enable Import", exact: true })
    .click();
  await expect(enable).toHaveCount(0);
}

/** Explicit platform input to getPlatform(), independent of the browser project. */
export const test = base.extend<{ platform: "default" | "macos" }>({
  platform: ["default", { option: true }],
  page: async ({ page, platform }, use) => {
    if (platform === "macos") {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "userAgent", {
          value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
          configurable: true,
        });
      });
    }
    await use(page);
  },
});
