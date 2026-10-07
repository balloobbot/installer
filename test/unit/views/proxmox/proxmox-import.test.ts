import { expect, fixture, html, waitUntil } from "@open-wc/testing";
import type WaSelect from "@home-assistant/webawesome/dist/components/select/select.js";
import { wizardState } from "../../../../src/state/wizard-state.js";
import type { ProxmoxStorage } from "../../../../src/api/types.js";
import {
  proxmoxEnableStorageImport,
  proxmoxListStorage,
} from "../../../../src/api/commands.js";
import "../../../../src/views/proxmox/proxmox-configure-view.js";
import type { ProxmoxConfigureView } from "../../../../src/views/proxmox/proxmox-configure-view.js";
import type { InfoDialog } from "../../../../src/components/info-dialog.js";
import {
  deferred,
  ipcError,
  mockTauriIpc,
  restoreTauriIpc,
  settle,
} from "../../tauri-ipc.js";

const session = {
  server_url: "https://pve.example:8006",
  ticket: "ticket",
  csrf_token: "csrf",
};
const directory: ProxmoxStorage = {
  name: "local",
  storage_type: "dir",
  active: true,
  content: ["backup"],
  available: 1e11,
  total: 2e11,
};
const disk: ProxmoxStorage = {
  ...directory,
  name: "local-lvm",
  storage_type: "lvmthin",
  content: ["images"],
};

describe("Proxmox import consent", () => {
  let writes: unknown[];
  let reads: number;
  let storages: ProxmoxStorage[];
  let enable: () => unknown;
  let list: () => unknown;

  beforeEach(() => {
    wizardState.startFlow("proxmox");
    wizardState.setSelection("proxmoxSession", session);
    writes = [];
    reads = 0;
    storages = [directory, disk];
    enable = () => {
      storages = [{ ...directory, content: ["backup", "import"] }, disk];
      return true;
    };
    list = () => storages;
    mockTauriIpc((cmd, args) => {
      switch (cmd) {
        case "proxmox_list_nodes":
          return [
            { name: "pve", status: "online" },
            { name: "pve2", status: "online" },
          ];
        case "proxmox_get_next_vm_id":
          return 100;
        case "proxmox_list_bridges":
          return [{ name: "vmbr0", network_type: "bridge", comments: null }];
        case "proxmox_list_storage":
          reads++;
          return list();
        case "proxmox_enable_storage_import":
          writes.push(args);
          return enable();
        default:
          throw new Error(`Unexpected IPC: ${cmd}`);
      }
    });
  });

  afterEach(() => {
    wizardState.reset();
    restoreTauriIpc();
  });

  async function mount() {
    const el = await fixture<ProxmoxConfigureView>(
      html`<proxmox-configure-view></proxmox-configure-view>`
    );
    // The node, storage and bridge dropdowns render once the lookups finish
    await waitUntil(
      () => el.shadowRoot!.querySelectorAll("wa-select").length >= 3
    );
    await settle();
    await el.updateComplete;
    return el;
  }

  function nodeSelect(el: ProxmoxConfigureView) {
    return el.shadowRoot!.querySelector("wa-select") as WaSelect;
  }

  function importSelect(el: ProxmoxConfigureView) {
    return el.shadowRoot!.querySelector(
      ".import-setting wa-select"
    ) as WaSelect | null;
  }

  async function click(el: ProxmoxConfigureView, label: string) {
    const button = [...el.shadowRoot!.querySelectorAll("wa-button")].find(
      (b) => b.textContent!.trim() === label
    ) as HTMLElement;
    expect(button, label).to.exist;
    button.click();
    await el.updateComplete;
  }

  async function approve(el: ProxmoxConfigureView) {
    await click(el, "Enable Import...");
    el.shadowRoot!.querySelector("info-dialog")!.dispatchEvent(
      new CustomEvent("dialog-primary")
    );
    await settle();
    await el.updateComplete;
  }

  it("does not mutate on load, storage selection, opening, or declining the dialog", async () => {
    storages.push({ ...directory, name: "other" });
    const el = await mount();
    expect(wizardState.getState().selections.proxmoxImportReady).to.be.false;
    const select = importSelect(el)!;
    select.value = "other";
    select.dispatchEvent(new Event("change"));
    await click(el, "Enable Import...");
    const dialog = el.shadowRoot!.querySelector("info-dialog") as InfoDialog;
    expect(dialog.open).to.be.true;
    expect(dialog.message).to.contain('"other"');
    expect(dialog.message).to.contain("cluster-wide");
    expect(dialog.message).to.contain("not automatically restore");
    dialog.dispatchEvent(new CustomEvent("dialog-secondary"));
    await el.updateComplete;
    expect(writes).to.deep.equal([]);
    expect(el.shadowRoot!.textContent).to.contain("Installation is paused");
    expect(
      el.shadowRoot!.querySelector<HTMLAnchorElement>(".import-setting a")!.href
    ).to.contain("pve.proxmox.com");
    expect(wizardState.getState().selections.proxmoxImportReady).to.be.false;
  });

  it("names the only candidate without an extra dropdown", async () => {
    const el = await mount();
    expect(importSelect(el)).to.be.null;
    expect(el.shadowRoot!.textContent).to.contain(
      'Import can be enabled on "local"'
    );
    await click(el, "Enable Import...");
    const dialog = el.shadowRoot!.querySelector("info-dialog") as InfoDialog;
    expect(dialog.message).to.contain('"local"');
    expect(writes).to.deep.equal([]);
  });

  it("sends the approved target, preserves VM storage, and refreshes before proceeding", async () => {
    const el = await mount();
    const refresh = deferred<ProxmoxStorage[]>();
    list = () => refresh.promise;
    await approve(el);
    expect(writes).to.deep.equal([{ session, node: "pve", storage: "local" }]);
    expect(reads).to.equal(2);
    expect(wizardState.getState().selections.proxmoxImportReady).to.be.false;
    refresh.resolve(storages);
    await settle();
    expect(wizardState.getState().selections.proxmoxImportReady).to.be.true;
    expect(wizardState.getState().selections.proxmoxStorage).to.equal(
      "local-lvm"
    );
  });

  it("does not prompt when active import storage exists, including a non-directory backend", async () => {
    storages.push({ ...directory, storage_type: "nfs", content: ["import"] });
    const el = await mount();
    expect(el.shadowRoot!.querySelector("info-dialog")).to.be.null;
    expect(wizardState.getState().selections.proxmoxImportReady).to.be.true;
    expect(writes).to.deep.equal([]);
  });

  it("offers only active directory candidates and ignores full or source-only import storage", async () => {
    storages = [
      disk,
      { ...directory, active: false },
      { ...directory, name: "full", available: 0, content: ["import"] },
      { ...directory, name: "esxi", storage_type: "esxi", content: ["import"] },
    ];
    const el = await mount();
    expect(importSelect(el)).to.be.null;
    expect(
      [...el.shadowRoot!.querySelectorAll("wa-button")].map((b) =>
        b.textContent!.trim()
      )
    ).not.to.include("Enable Import...");
    expect(el.shadowRoot!.textContent).to.contain(
      "No active directory storage"
    );
    expect(el.shadowRoot!.textContent).to.contain("Free up space");
    expect(wizardState.getState().selections.proxmoxImportReady).to.be.false;
  });

  for (const [code, message, shown] of [
    [
      "proxmox_action_required",
      "Your Proxmox user is missing Datastore.Allocate on /storage.",
      "Datastore.Allocate",
    ],
    [
      "proxmox_action_required",
      "Proxmox did not enable Import on storage 'local'. Refresh storage and try again; its configuration or your permissions may have changed.",
      "Refresh storage and try again",
    ],
    // Remote details stay out of the view; the code picks a safe message
    ["proxmox_api", "raw server response", "account permissions"],
  ]) {
    it(`keeps choices and allows explicit retry after ${code}: ${shown}`, async () => {
      const succeed = enable;
      enable = () => {
        throw ipcError(code, message);
      };
      const el = await mount();
      await approve(el);
      expect(
        el.shadowRoot!.querySelector("[role=alert]")!.textContent
      ).to.contain(shown);
      expect(el.shadowRoot!.textContent).not.to.contain("raw server response");
      expect(el.shadowRoot!.querySelectorAll("wa-select").length).to.equal(3);
      expect(wizardState.getState().selections.proxmoxImportReady).to.be.false;
      enable = succeed;
      await approve(el);
      expect(writes.length).to.equal(2);
      expect(wizardState.getState().selections.proxmoxImportReady).to.be.true;
    });
  }

  it("offers reconnect when enabling Import finds the session expired", async () => {
    enable = () => {
      throw ipcError(
        "proxmox_session_expired",
        "Proxmox session expired or invalid. Please reconnect to Proxmox."
      );
    };
    const el = await mount();
    await approve(el);
    expect(el.shadowRoot!.textContent).to.contain("Reconnect");
    expect(wizardState.getState().selections.proxmoxSession).to.be.undefined;
    expect(wizardState.getState().selections.proxmoxImportReady).to.be.false;
    expect(writes.length).to.equal(1);
  });

  it("keeps Next blocked when the post-change storage refresh fails and allows read-only retry", async () => {
    const el = await mount();
    list = () => {
      throw ipcError("proxmox_api", "storage refresh denied", true);
    };
    await approve(el);
    expect(el.shadowRoot!.querySelector("[role=alert]")).to.exist;
    expect(wizardState.getState().selections.proxmoxImportReady).to.be.false;
    list = () => storages;
    await click(el, "Try again");
    await waitUntil(
      () => wizardState.getState().selections.proxmoxImportReady === true
    );
    expect(writes.length).to.equal(1);
  });

  for (const result of ["success", "failure"]) {
    for (const change of ["node", "session", "detach"]) {
      it(`ignores stale ${result} after a ${change} change`, async () => {
        const pending = deferred<boolean>();
        enable = () => pending.promise;
        const el = await mount();
        await approve(el);
        if (change === "node") {
          const select = nodeSelect(el);
          expect(select.disabled).to.be.true;
          select.value = "pve2";
          select.dispatchEvent(new Event("change"));
        } else if (change === "session") {
          wizardState.setSelection("proxmoxSession", {
            ...session,
            ticket: "new-ticket",
          });
        } else {
          el.remove();
          wizardState.startFlow("sbc");
        }
        await settle();
        const before = wizardState.getState();
        const beforeReads = reads;
        if (result === "success") pending.resolve(true);
        else pending.reject(ipcError("proxmox_api", "obsolete session failed"));
        await settle();
        expect(wizardState.getState()).to.equal(before);
        expect(reads).to.equal(beforeReads);
        expect(el.shadowRoot!.querySelector(".import-setting [role=alert]")).to
          .be.null;
      });
    }
  }

  it("ignores a previous session's delayed storage read", async () => {
    const old = deferred<ProxmoxStorage[]>();
    list = () => old.promise;
    await fixture<ProxmoxConfigureView>(
      html`<proxmox-configure-view></proxmox-configure-view>`
    );
    await waitUntil(() => reads === 1);
    wizardState.setSelection("proxmoxSession", {
      ...session,
      ticket: "new-ticket",
    });
    old.resolve([{ ...directory, content: ["import", "images"] }]);
    await settle();
    expect(wizardState.getState().selections.proxmoxImportReady).to.be.false;
  });

  it("browser mock adds Import persistently without removing other content types", async () => {
    restoreTauriIpc();
    const mockSession = {
      ...session,
      server_url: "https://mock-import.example:8006",
    };
    const before = await proxmoxListStorage(mockSession, "pve");
    expect(before[0].content).not.to.include("import");
    expect(await proxmoxEnableStorageImport(mockSession, "pve", "local")).to.be
      .true;
    const after = await proxmoxListStorage(mockSession, "pve2");
    expect(after[0].content).to.deep.equal([...before[0].content, "import"]);
    expect(await proxmoxEnableStorageImport(mockSession, "pve", "local")).to.be
      .false;
  });
});
