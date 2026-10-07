import { test, expect, type Page } from "@playwright/test";

type TestWindow = typeof window & {
  __TAURI__: object;
  __TAURI_INTERNALS__: {
    invoke: (cmd: string, args: unknown) => Promise<unknown>;
    transformCallback: () => number;
  };
  importWrites: unknown[];
};

async function configure(page: Page, failFirst = false) {
  await page.goto("/");
  await page.locator("welcome-view wa-button").click();
  await page.locator('option-card[title="Proxmox server"]').click();
  await expect(page.locator("proxmox-connect-view")).toBeVisible();
  await page.evaluate(
    ({ failure }) => {
      const win = window as TestWindow;
      win.__TAURI__ = {};
      win.importWrites = [];
      let enabled = false;
      win.__TAURI_INTERNALS__ = {
        transformCallback: () => 1,
        invoke: async (cmd, args) => {
          switch (cmd) {
            case "log_frontend_event":
              return undefined;
            case "proxmox_certificate_fingerprint":
              return null;
            case "proxmox_connect":
              return {
                server_url: (args as { credentials: { server_url: string } })
                  .credentials.server_url,
                ticket: "fixture",
                csrf_token: "fixture",
              };
            case "proxmox_list_nodes":
              return [
                { name: "pve", status: "online" },
                { name: "pve2", status: "online" },
              ];
            case "proxmox_get_next_vm_id":
              return 100;
            case "proxmox_list_bridges":
              return [
                { name: "vmbr0", network_type: "bridge", comments: null },
              ];
            case "get_haos_release":
              return { version: "18.3", assets: [] };
            case "proxmox_list_storage":
              return [
                {
                  name: "local",
                  storage_type: "dir",
                  active: true,
                  content: enabled ? ["backup", "import"] : ["backup"],
                  available: 1e11,
                  total: 2e11,
                },
                {
                  name: "local-lvm",
                  storage_type: "lvmthin",
                  active: true,
                  content: ["images"],
                  available: 1e11,
                  total: 2e11,
                },
              ];
            case "proxmox_enable_storage_import":
              win.importWrites.push(args);
              if (failure && win.importWrites.length === 1)
                throw {
                  code: "proxmox_action_required",
                  message:
                    "Your Proxmox user is missing Datastore.Allocate on /storage.",
                  retryable: false,
                  details: {},
                };
              enabled = true;
              return true;
            default:
              throw new Error(`Unexpected command: ${cmd}`);
          }
        },
      };
    },
    { failure: failFirst }
  );
  await page.locator("#server-url").fill("https://pve.example:8006");
  await page.locator("#password").fill("fixture");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Enable Import...", exact: true })
  ).toBeVisible();
}

async function writeCount(page: Page) {
  return page.evaluate(() => (window as TestWindow).importWrites.length);
}

for (const width of [1100, 390]) {
  test(`explicit consent, decline, refresh, and navigation at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 850 });
    await configure(page);
    const next = page.getByRole("button", { name: "Next", exact: true });
    const enable = page.getByRole("button", {
      name: "Enable Import...",
      exact: true,
    });
    await expect(next).toBeDisabled();
    expect(await writeCount(page)).toBe(0);
    await enable.click();
    const dialog = page.getByRole("dialog", {
      name: "Enable Import on storage?",
    });
    await expect(dialog).toBeVisible();
    const message = page.locator("info-dialog .dialog-message");
    await expect(message).toContainText('"local"');
    await expect(message).toContainText("cluster-wide");
    await expect(message).toContainText("remains enabled after installation");
    await expect(message).toContainText("not automatically restore");
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(850);
    await page.screenshot({
      path: testInfo.outputPath(`import-consent-${width}.png`),
      animations: "disabled",
    });
    expect(await writeCount(page)).toBe(0);
    await page.getByRole("button", { name: "Not now", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole("status")).toContainText(
      "Installation is paused"
    );
    await expect(
      page.getByRole("link", {
        name: "Proxmox directory storage documentation",
      })
    ).toHaveAttribute("href", /pve.proxmox.com/);
    await expect(next).toBeDisabled();
    expect(await writeCount(page)).toBe(0);
    await page.getByRole("button", { name: "Refresh storage" }).click();
    await expect(enable).toBeVisible();
    expect(await writeCount(page)).toBe(0);
    await enable.click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    expect(await writeCount(page)).toBe(0);
    await enable.click();
    await page
      .getByRole("button", { name: "Enable Import", exact: true })
      .click();
    await expect(next).toBeEnabled();
    expect(await writeCount(page)).toBe(1);
    await next.click();
    await expect(page.locator("proxmox-confirm-view")).toBeVisible();
    await page.getByRole("button", { name: /Back/ }).click();
    await expect(page.locator("proxmox-configure-view")).toBeVisible();
    await expect(next).toBeEnabled();
    expect(await writeCount(page)).toBe(1);
  });

  test(`permission failure can retry or return to connection at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 850 });
    await configure(page, true);
    await page
      .getByRole("button", { name: "Enable Import...", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Enable Import", exact: true })
      .click();
    await expect(
      page.locator("proxmox-configure-view").getByRole("alert")
    ).toContainText("Datastore.Allocate");
    await expect(
      page.getByRole("button", { name: "Next", exact: true })
    ).toBeDisabled();
    expect(await writeCount(page)).toBe(1);
    await page
      .getByRole("button", { name: "Enable Import...", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Enable Import", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Next", exact: true })
    ).toBeEnabled();
    expect(await writeCount(page)).toBe(2);
    await page.getByRole("button", { name: /Back/ }).click();
    await expect(page.locator("proxmox-connect-view")).toBeVisible();
  });
}
