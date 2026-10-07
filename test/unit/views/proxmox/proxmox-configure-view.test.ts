import {
  expect,
  fixture,
  fixtureSync,
  html,
  waitUntil,
} from "@open-wc/testing";
import type { ProxmoxStorage } from "../../../../src/api/types.js";
import { wizardState } from "../../../../src/state/wizard-state.js";
import "../../../../src/views/proxmox/proxmox-configure-view.js";
import type { ProxmoxConfigureView } from "../../../../src/views/proxmox/proxmox-configure-view.js";
import {
  type Deferred,
  deferred,
  mockTauriIpc,
  restoreTauriIpc,
  settle,
} from "../../tauri-ipc.js";

/** Mount the view and wait for the node and storage lookups to settle */
async function mount(): Promise<ProxmoxConfigureView> {
  const el = await fixture<ProxmoxConfigureView>(html`
    <proxmox-configure-view></proxmox-configure-view>
  `);
  // Both dropdowns only render once their lookups have finished, which is
  // also when the view saves what it settled on
  await waitUntil(
    () => el.shadowRoot!.querySelectorAll(".select-dropdown").length === 2,
    "the node and storage dropdowns never loaded",
    { timeout: 4000 }
  );
  await el.updateComplete;
  return el;
}

describe("proxmox-configure-view", () => {
  beforeEach(() => {
    wizardState.startFlow("proxmox");
    // The view needs a session to look up nodes and storage
    wizardState.setSelection("proxmoxSession", {
      server_url: "https://192.168.1.100:8006",
      ticket: "mock-ticket",
      csrf_token: "mock-csrf",
    });
  });

  afterEach(() => {
    wizardState.reset();
    restoreTauriIpc();
  });

  it("saves the defaults on a first visit", async () => {
    await mount();

    const selections = wizardState.getState().selections;
    // The mocked server offers nodes pve/pve2 and storage local/local-lvm
    expect(selections.proxmoxNode).to.equal("pve");
    expect(selections.proxmoxStorage).to.equal("local");
    expect(selections.proxmoxVmId).to.equal(100);
    expect(selections.vmName).to.equal("home-assistant");
    expect(selections.cpuCores).to.equal(4);
    expect(selections.memoryMb).to.equal(4096);
    expect(selections.diskSizeGb).to.equal(32);
  });

  it("keeps the existing selections when the step is revisited", async () => {
    // What the user picked before stepping back to the connection step
    wizardState.setSelection("proxmoxNode", "pve2");
    wizardState.setSelection("proxmoxStorage", "local-lvm");
    wizardState.setSelection("proxmoxVmId", 250);
    wizardState.setSelection("vmName", "my-ha");
    wizardState.setSelection("cpuCores", 8);
    wizardState.setSelection("memoryMb", 8192);
    wizardState.setSelection("diskSizeGb", 64);

    const el = await mount();

    const selections = wizardState.getState().selections;
    expect(selections.proxmoxNode).to.equal("pve2");
    expect(selections.proxmoxStorage).to.equal("local-lvm");
    expect(selections.proxmoxVmId).to.equal(250);
    expect(selections.vmName).to.equal("my-ha");
    expect(selections.cpuCores).to.equal(8);
    expect(selections.memoryMb).to.equal(8192);
    expect(selections.diskSizeGb).to.equal(64);

    // And they are what the form shows, not just what is in the state
    const [nodeSelect, storageSelect] = el.shadowRoot!.querySelectorAll(
      "select.select-dropdown"
    ) as NodeListOf<HTMLSelectElement>;
    expect(nodeSelect.value).to.equal("pve2");
    expect(storageSelect.value).to.equal("local-lvm");
    const text = el.shadowRoot!.textContent!;
    expect(text).to.contain("8 cores");
    expect(text).to.contain("8 GB");
    expect(text).to.contain("64 GB");
  });

  it("falls back to an available node when the restored one is gone", async () => {
    wizardState.setSelection("proxmoxNode", "retired-node");

    await mount();

    expect(wizardState.getState().selections.proxmoxNode).to.equal("pve");
  });

  it("falls back to available storage when the restored one is gone", async () => {
    wizardState.setSelection("proxmoxStorage", "retired-storage");

    await mount();

    expect(wizardState.getState().selections.proxmoxStorage).to.equal("local");
  });

  it("does not save after being detached during the storage lookup", async () => {
    const storageCalled = deferred<void>();
    const storage = deferred<ProxmoxStorage[]>();
    mockTauriIpc((cmd) => {
      switch (cmd) {
        case "proxmox_list_nodes":
          return [{ name: "pve", status: "online" }];
        case "proxmox_get_next_vm_id":
          return 100;
        case "proxmox_list_storage":
          storageCalled.resolve();
          return storage.promise;
      }
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });

    const el = fixtureSync<ProxmoxConfigureView>(html`
      <proxmox-configure-view></proxmox-configure-view>
    `);
    await storageCalled.promise;

    // Leave the step while storage is still loading, then let it finish
    el.remove();
    storage.resolve([
      {
        name: "local",
        storage_type: "dir",
        content: ["images"],
        available: 100,
        total: 100,
        active: true,
      },
    ]);
    await settle();

    const selections = wizardState.getState().selections;
    expect(selections.proxmoxNode).to.be.undefined;
    expect(selections.proxmoxStorage).to.be.undefined;
    expect(selections.proxmoxVmId).to.be.undefined;
  });

  it("ignores a storage lookup for a node that is no longer selected", async () => {
    const storageFor = (node: string): ProxmoxStorage[] => [
      {
        name: `${node}-storage`,
        storage_type: "dir",
        content: ["images"],
        available: 100,
        total: 100,
        active: true,
      },
    ];
    // After the first visit's lookup, hold each node's storage lookup open
    const pending = new Map<string, Deferred<ProxmoxStorage[]>>();
    let firstLookup = true;
    mockTauriIpc((cmd, args) => {
      switch (cmd) {
        case "proxmox_list_nodes":
          return [
            { name: "pve", status: "online" },
            { name: "pve2", status: "online" },
          ];
        case "proxmox_get_next_vm_id":
          return 100;
        case "proxmox_list_storage": {
          const { node } = args as { node: string };
          if (firstLookup) {
            firstLookup = false;
            return storageFor(node);
          }
          const lookup = deferred<ProxmoxStorage[]>();
          pending.set(node, lookup);
          return lookup.promise;
        }
      }
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });

    const el = await mount();
    const nodeSelect = el.shadowRoot!.querySelector(
      "select.select-dropdown"
    ) as HTMLSelectElement;
    const pickNode = (node: string) => {
      nodeSelect.value = node;
      nodeSelect.dispatchEvent(new Event("change"));
    };

    // Switch to pve2 and straight back, then have pve2's lookup finish last
    pickNode("pve2");
    pickNode("pve");
    pending.get("pve")!.resolve(storageFor("pve"));
    await settle();
    pending.get("pve2")!.resolve(storageFor("pve2"));
    await settle();

    const selections = wizardState.getState().selections;
    expect(selections.proxmoxNode).to.equal("pve");
    expect(selections.proxmoxStorage).to.equal("pve-storage");
  });

  it("ignores an older lookup for the same node that fails after a newer one succeeded", async () => {
    const storageFor = (node: string): ProxmoxStorage[] => [
      {
        name: `${node}-storage`,
        storage_type: "dir",
        content: ["images"],
        available: 100,
        total: 100,
        active: true,
      },
    ];
    // After the first visit's lookup, hold each storage lookup open in order
    const pending: Deferred<ProxmoxStorage[]>[] = [];
    let firstLookup = true;
    mockTauriIpc((cmd, args) => {
      switch (cmd) {
        case "proxmox_list_nodes":
          return [
            { name: "pve", status: "online" },
            { name: "pve2", status: "online" },
          ];
        case "proxmox_get_next_vm_id":
          return 100;
        case "proxmox_list_storage": {
          const { node } = args as { node: string };
          if (firstLookup) {
            firstLookup = false;
            return storageFor(node);
          }
          const lookup = deferred<ProxmoxStorage[]>();
          pending.push(lookup);
          return lookup.promise;
        }
      }
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });

    const el = await mount();
    const nodeSelect = el.shadowRoot!.querySelector(
      "select.select-dropdown"
    ) as HTMLSelectElement;
    const pickNode = (node: string) => {
      nodeSelect.value = node;
      nodeSelect.dispatchEvent(new Event("change"));
    };

    // pve2, pve, pve2 again: two pve2 lookups are open at once
    pickNode("pve2");
    pickNode("pve");
    pickNode("pve2");
    const [olderPve2, pve, newerPve2] = pending;
    newerPve2.resolve(storageFor("pve2"));
    await settle();
    pve.resolve(storageFor("pve"));
    olderPve2.reject("storage unavailable");
    await settle();

    const selections = wizardState.getState().selections;
    expect(selections.proxmoxNode).to.equal("pve2");
    expect(selections.proxmoxStorage).to.equal("pve2-storage");
    expect(el.shadowRoot!.textContent).to.not.contain("storage unavailable");
  });

  it("blocks Next when the restored node is gone and the new node's lookup fails", async () => {
    wizardState.setSelection("proxmoxNode", "retired-node");
    wizardState.setSelection("proxmoxStorage", "retired-storage");
    mockTauriIpc((cmd) => {
      switch (cmd) {
        case "proxmox_list_nodes":
          return [{ name: "pve", status: "online" }];
        case "proxmox_get_next_vm_id":
          return 100;
        case "proxmox_list_storage":
          throw "storage unavailable";
      }
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });

    // The storage dropdown never renders when its lookup fails, so wait for
    // the save instead of using mount()
    await fixture<ProxmoxConfigureView>(html`
      <proxmox-configure-view></proxmox-configure-view>
    `);
    await waitUntil(
      () => wizardState.getState().selections.proxmoxNode !== "retired-node",
      "the view never replaced the retired node"
    );

    const selections = wizardState.getState().selections;
    expect(selections.proxmoxNode).to.equal("pve");
    expect(selections.proxmoxConfigureReady).to.be.false;
  });

  it("preserves the restored storage but blocks Next when its lookup fails", async () => {
    wizardState.setSelection("proxmoxNode", "pve");
    wizardState.setSelection("proxmoxStorage", "local-lvm");
    mockTauriIpc((cmd) => {
      switch (cmd) {
        case "proxmox_list_nodes":
          return [{ name: "pve", status: "online" }];
        case "proxmox_get_next_vm_id":
          return 100;
        case "proxmox_list_storage":
          throw "storage unavailable";
      }
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });

    // The storage dropdown never renders when its lookup fails, so wait for
    // the error instead of using mount()
    const el = await fixture<ProxmoxConfigureView>(html`
      <proxmox-configure-view></proxmox-configure-view>
    `);
    await waitUntil(
      () => el.shadowRoot!.textContent!.includes("storage unavailable"),
      "the storage lookup never failed"
    );

    const selections = wizardState.getState().selections;
    expect(selections.proxmoxNode).to.equal("pve");
    expect(selections.proxmoxStorage).to.equal("local-lvm");
    expect(selections.proxmoxConfigureReady).to.be.false;
  });

  for (const failingCommand of [
    "proxmox_list_nodes",
    "proxmox_list_storage",
    "proxmox_get_next_vm_id",
  ]) {
    it(`retries ${failingCommand} in place and keeps VM settings`, async () => {
      wizardState.setSelection("proxmoxNode", "pve");
      wizardState.setSelection("proxmoxStorage", "local");
      wizardState.setSelection("proxmoxVmId", 250);
      wizardState.setSelection("vmName", "my-ha");
      wizardState.setSelection("cpuCores", 8);
      wizardState.setSelection("memoryMb", 8192);
      wizardState.setSelection("diskSizeGb", 64);
      const nodes = deferred<{ name: string; status: string }[]>();
      const calls: string[] = [];
      let failing = true;
      mockTauriIpc((cmd) => {
        calls.push(cmd);
        if (failing && cmd === failingCommand) {
          throw { message: "Temporary failure", session_expired: false };
        }
        switch (cmd) {
          case "proxmox_list_nodes":
            return failing
              ? [{ name: "pve", status: "online" }]
              : nodes.promise;
          case "proxmox_get_next_vm_id":
            return 100;
          case "proxmox_list_storage":
            return [
              {
                name: "local",
                active: true,
                content: ["images"],
                available: 100,
              },
            ];
        }
        throw new Error(`Unexpected IPC command: ${cmd}`);
      });
      const el = await fixture<ProxmoxConfigureView>(html`
        <proxmox-configure-view></proxmox-configure-view>
      `);
      await waitUntil(() => !!el.shadowRoot!.querySelector("[role=alert]"));
      expect(el.shadowRoot!.textContent).to.contain("Temporary failure");
      expect(wizardState.getState().selections.proxmoxConfigureReady).to.be
        .false;
      expect(wizardState.getState().selections.proxmoxSession).to.exist;

      failing = false;
      calls.length = 0;
      const retry = el.shadowRoot!.querySelector("wa-button")!;
      expect(retry.textContent).to.contain("Try again");
      retry.click();
      retry.click();
      await el.updateComplete;
      expect(el.shadowRoot!.textContent).to.contain("Loading nodes...");
      expect(wizardState.getState().selections.proxmoxConfigureReady).to.be
        .false;
      nodes.resolve([{ name: "pve", status: "online" }]);
      await waitUntil(
        () => wizardState.getState().selections.proxmoxConfigureReady === true
      );
      expect(calls).to.deep.equal([
        "proxmox_list_nodes",
        "proxmox_get_next_vm_id",
        "proxmox_list_storage",
      ]);
      const selections = wizardState.getState().selections;
      expect(selections.proxmoxStorage).to.equal("local");
      expect(selections.proxmoxVmId).to.equal(250);
      expect(selections.vmName).to.equal("my-ha");
      expect(selections.cpuCores).to.equal(8);
      expect(selections.memoryMb).to.equal(8192);
      expect(selections.diskSizeGb).to.equal(64);
      expect(el.shadowRoot!.querySelector("[role=alert]")).to.be.null;
    });

    it(`offers reconnect when ${failingCommand} rejects an expired session`, async () => {
      wizardState.nextStep();
      wizardState.setSelection("proxmoxConnected", true);
      mockTauriIpc((cmd) => {
        if (cmd === failingCommand) {
          throw {
            message: "Session expired. Please reconnect.",
            session_expired: true,
          };
        }
        if (cmd === "proxmox_list_nodes")
          return [{ name: "pve", status: "online" }];
        if (cmd === "proxmox_get_next_vm_id") return 100;
        throw new Error(`Unexpected IPC command: ${cmd}`);
      });
      const el = await fixture<ProxmoxConfigureView>(html`
        <proxmox-configure-view></proxmox-configure-view>
      `);
      await waitUntil(() => !!el.shadowRoot!.querySelector("[role=alert]"));
      expect(wizardState.getState().selections.proxmoxSession).to.be.undefined;
      expect(wizardState.getState().selections.proxmoxConnected).to.be.false;
      expect(wizardState.getState().selections.proxmoxConfigureReady).to.be
        .false;
      const reconnect = el.shadowRoot!.querySelector("wa-button")!;
      expect(reconnect.textContent).to.contain("Reconnect");
      reconnect.click();
      expect(wizardState.currentStep!.id).to.equal("connection");
    });
  }

  it("ignores an authentication failure after leaving the step", async () => {
    const nodes = deferred<never>();
    mockTauriIpc((cmd) => {
      if (cmd === "proxmox_list_nodes") return nodes.promise;
      if (cmd === "proxmox_get_next_vm_id") return 100;
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });
    const el = await fixture<ProxmoxConfigureView>(html`
      <proxmox-configure-view></proxmox-configure-view>
    `);
    el.remove();
    nodes.reject({ message: "Expired", session_expired: true });
    await settle();
    expect(wizardState.getState().selections.proxmoxSession).to.exist;
  });

  it("offers reconnect when the session is missing", async () => {
    wizardState.setSelection("proxmoxSession", undefined);
    const el = await fixture<ProxmoxConfigureView>(html`
      <proxmox-configure-view></proxmox-configure-view>
    `);
    expect(el.shadowRoot!.querySelector("wa-button")!.textContent).to.contain(
      "Reconnect"
    );
  });

  it("keeps a non-default storage through reconnect and revalidation", async () => {
    wizardState.nextStep();
    wizardState.setSelection("proxmoxNode", "pve2");
    wizardState.setSelection("proxmoxStorage", "local-lvm");
    const session = wizardState.getState().selections.proxmoxSession;
    mockTauriIpc(() => {
      throw { message: "Session expired", session_expired: true };
    });
    const el = await fixture<ProxmoxConfigureView>(html`
      <proxmox-configure-view></proxmox-configure-view>
    `);
    await waitUntil(() => !!el.shadowRoot!.querySelector("[role=alert]"));
    el.shadowRoot!.querySelector("wa-button")!.click();
    el.remove();
    expect(wizardState.currentStep!.id).to.equal("connection");
    expect(wizardState.getState().selections.proxmoxStorage).to.equal(
      "local-lvm"
    );

    restoreTauriIpc();
    wizardState.setSelection("proxmoxSession", session);
    wizardState.nextStep();
    const reconnected = await mount();
    expect(wizardState.getState().selections.proxmoxConfigureReady).to.be.true;
    expect(wizardState.getState().selections.proxmoxStorage).to.equal(
      "local-lvm"
    );
    expect(
      reconnected.shadowRoot!.querySelectorAll("select")[1].value
    ).to.equal("local-lvm");
  });

  it("keeps stored choices when leaving during a lookup", async () => {
    wizardState.setSelection("proxmoxNode", "pve2");
    wizardState.setSelection("proxmoxStorage", "local-lvm");
    const nodes = deferred<never>();
    mockTauriIpc((cmd) => (cmd === "proxmox_list_nodes" ? nodes.promise : 100));
    const el = await fixture<ProxmoxConfigureView>(html`
      <proxmox-configure-view></proxmox-configure-view>
    `);
    expect(wizardState.getState().selections.proxmoxConfigureReady).to.be.false;
    el.remove();
    nodes.reject("network failed");
    await settle();
    expect(wizardState.getState().selections.proxmoxStorage).to.equal(
      "local-lvm"
    );
    expect(wizardState.getState().selections.proxmoxNode).to.equal("pve2");
  });
});
