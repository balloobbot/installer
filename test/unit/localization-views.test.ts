import { expect } from "@open-wc/testing";
import { render } from "lit";
import "../../src/components/app-shell.js";
import messages from "../../src/localization/en.json";
import {
  setLanguage,
  type MessageKey,
} from "../../src/localization/localize.js";
import { DEFAULT_UTM_VM_NAME } from "../../src/state/vm-defaults.js";
import { wizardState } from "../../src/state/wizard-state.js";
import { mockTauriIpc, restoreTauriIpc } from "./tauri-ipc.js";

interface RenderView extends HTMLElement {
  render(): unknown;
}

function view(tag: string, fields: Record<string, unknown> = {}): RenderView {
  return Object.assign(
    document.createElement(tag),
    fields
  ) as unknown as RenderView;
}

// Detached views exercise the real templates without starting install pipelines.
function output(element: RenderView): HTMLDivElement {
  const container = document.createElement("div");
  render(element.render(), container);
  return container;
}

describe("localized view contracts", () => {
  const original = { ...messages };
  const now = Date.now;

  afterEach(() => {
    restoreTauriIpc();
    Object.assign(messages, original);
    setLanguage(["en"]);
    Date.now = now;
    wizardState.reset();
  });

  function replace(key: MessageKey, text: string) {
    messages[key] = text;
    setLanguage(["en"]);
  }

  it("preserves the default unnamed-drive warning and installed UTM version", () => {
    const dialog = output(view("app-shell")).querySelector(
      "confirm-dialog"
    ) as RenderView;
    expect(
      output(dialog).querySelector(".dialog-message")?.textContent?.trim()
    ).to.equal(
      "All data on the selected drive will be permanently erased. This action cannot be undone."
    );
    const utm = output(
      view("utm-check-view", {
        _loading: false,
        _utmStatus: { installed: true, version: "4.7" },
      })
    );
    expect(utm.querySelector(".status-title")?.textContent?.trim()).to.equal(
      "UTM is installed (v4.7)"
    );
  });

  it("uses whole unnamed-device success sentences and preserves named-device text", () => {
    const element = view("success-view");
    expect(
      output(element).querySelector(".subtitle")?.textContent?.trim()
    ).to.equal("Home Assistant has been installed on your device");
    expect(
      output(element).querySelectorAll(".step-text")[1]?.textContent?.trim()
    ).to.equal("Insert it into your device and power it on");
    replace("sbc.success_installed_unknown_device", "Installed fixture.");
    replace("sbc.success_insert_unknown_device", "Insert fixture.");
    expect(
      output(element).querySelector(".subtitle")?.textContent?.trim()
    ).to.equal("Installed fixture.");
    expect(
      output(element).querySelectorAll(".step-text")[1]?.textContent?.trim()
    ).to.equal("Insert fixture.");
    Object.assign(element, {
      _wizardState: {
        ...wizardState.getState(),
        selections: { deviceName: "Raspberry Pi 5" },
      },
    });
    expect(
      output(element).querySelector(".subtitle")?.textContent?.trim()
    ).to.equal("Home Assistant has been installed on your Raspberry Pi 5");
    expect(
      output(element).querySelectorAll(".step-text")[1]?.textContent?.trim()
    ).to.equal("Insert it into Raspberry Pi 5 and power it on");
  });

  for (const tag of [
    "confirmation-view",
    "proxmox-confirm-view",
    "utm-confirm-view",
  ]) {
    it(`${tag} localizes version failure separately from loading and a known version`, async () => {
      const element = view(tag) as RenderView & {
        _loadInfo(): Promise<void>;
        _loadHaosVersion(): Promise<void>;
      };
      expect(output(element).textContent).to.contain("Loading...");
      mockTauriIpc((command) => {
        expect(command).to.equal("get_haos_release");
        throw new Error("Release lookup fixture failure");
      });
      const load = () =>
        tag === "confirmation-view"
          ? element._loadHaosVersion()
          : element._loadInfo();
      await load();
      expect(output(element).textContent).to.contain("Version Unknown");
      expect(output(element).textContent).not.to.contain("Loading...");
      replace("common.version_unknown", "Unavailable release fixture");
      expect(output(element).textContent).to.contain(
        "Unavailable release fixture"
      );
      mockTauriIpc(() => ({ version: "17.0" }));
      await load();
      expect(output(element).textContent).to.contain("Version 17.0");
      expect(output(element).textContent).not.to.contain(
        "Unavailable release fixture"
      );
    });
  }

  it("uses a whole catalog warning when the app has no drive name", () => {
    wizardState.reset();
    replace(
      "components.confirm_dialog.erase_warning_unknown",
      "Unknown-target warning fixture."
    );
    const dialog = output(view("app-shell")).querySelector(
      "confirm-dialog"
    ) as RenderView & { driveName: string };
    expect(dialog.driveName).to.equal("");
    expect(
      output(dialog).querySelector(".dialog-message")?.textContent?.trim()
    ).to.equal("Unknown-target warning fixture.");
  });

  for (const tag of ["proxmox-progress-view", "utm-progress-view"]) {
    it(`${tag} gets its pending ETA from the catalog`, () => {
      replace("views.sbc.progress_view.calculating", "Pending ETA fixture");
      const content = output(
        view(tag, {
          _stage: "downloading",
          _totalBytes: 1024,
          _bytesProcessed: 0,
        })
      );
      expect(content.textContent).to.contain("Pending ETA fixture");
      expect(content.textContent).not.to.contain("Calculating...");
    });
  }

  it("lets the installed-version catalog own spacing, wrapping, and order", () => {
    replace("utm.installed_with_version", "{version}: installed fixture");
    replace("utm.version", "[release {version}]");
    const element = view("utm-check-view", {
      _loading: false,
      _utmStatus: { installed: true, version: "4.7" },
    });
    const content = output(element);
    expect(
      content.querySelector(".status-title")?.textContent?.trim()
    ).to.equal("[release 4.7]: installed fixture");
    expect(content.querySelector(".version-info")?.textContent).to.equal(
      "[release 4.7]"
    );
    Object.assign(element, { _utmStatus: { installed: true, version: null } });
    expect(
      output(element).querySelector(".status-title")?.textContent?.trim()
    ).to.equal("UTM is installed");
  });

  it("keeps the VM name placeholder as data and separates disk from pool labels", () => {
    replace("brand.home_assistant", "Brand translation fixture");
    replace("proxmox.storage_pool", "Pool fixture");
    replace("vm.disk_storage", "Disk fixture");
    const utm = output(view("utm-configure-view"));
    expect(
      utm.querySelector(".name-input")?.getAttribute("placeholder")
    ).to.equal(DEFAULT_UTM_VM_NAME);
    for (const tag of ["utm-confirm-view", "proxmox-confirm-view"]) {
      const content = output(view(tag));
      expect(content.textContent).to.contain("Disk fixture");
      expect(content.textContent).not.to.contain("Pool fixture");
    }
    expect(
      output(view("proxmox-configure-view", { _loading: false })).textContent
    ).to.contain("Pool fixture");
  });

  for (const tag of [
    "progress-view",
    "proxmox-progress-view",
    "utm-progress-view",
  ]) {
    for (const [seconds, phrase] of [
      [59, "Less than a minute"],
      [60, "About 1 minute"],
      [3599, "About 60 minutes"],
      [3600, "About 1h 0m"],
    ] as const) {
      it(`${tag} preserves the ${seconds}-second ETA boundary`, () => {
        Date.now = () => 10000;
        const element = view(tag, {
          _stageStartTime: 9000,
          _stageStartBytes: 0,
          _bytesProcessed: 1,
          _totalBytes: seconds + 1,
          _progress: {
            stage: "downloading",
            progress: 1,
            bytes_processed: 1,
            total_bytes: seconds + 1,
            message: "",
          },
        }) as unknown as { _calculateEta(): string | null };
        expect(element._calculateEta()).to.equal(
          phrase + (tag === "progress-view" ? "" : " remaining")
        );
      });
    }
  }

  it("uses regional Intl grouping in actual size and VM formatters without changing units", () => {
    setLanguage(["en-IN"]);
    const drive = view("drive-card", { driveSize: 123456 * 1024 ** 4 });
    expect(output(drive).querySelector(".size")?.textContent).to.equal(
      "1,23,456.0 TB"
    );
    const confirmation = view("confirmation-view") as unknown as {
      _formatSize(bytes: number): string;
    };
    expect(confirmation._formatSize(1.25 * 1024 ** 4)).to.equal("1.3 TB");
    for (const tag of [
      "utm-configure-view",
      "proxmox-configure-view",
      "utm-confirm-view",
      "proxmox-confirm-view",
    ]) {
      const element = view(tag) as unknown as {
        _formatMemory(mb: number): string;
        _formatDiskSize(gb: number): string;
      };
      expect(element._formatMemory(123456 * 1024)).to.equal(
        "1,23,456 GB" + (tag.includes("confirm-view") ? " RAM" : "")
      );
      expect(element._formatDiskSize(1.5 * 1024)).to.equal("1.5 TB");
    }
  });

  for (const tag of [
    "progress-view",
    "proxmox-progress-view",
    "utm-progress-view",
  ]) {
    it(`${tag} formats the actual rendered percentage`, () => {
      setLanguage(["en-IN"]);
      const element = view(tag, {
        _stage: "downloading",
        _totalBytes: 100,
        _bytesProcessed: 12.5,
        _progress:
          tag === "progress-view"
            ? {
                stage: "downloading",
                progress: 12.5,
                bytes_processed: 12.5,
                total_bytes: 100,
                message: "",
              }
            : 12.5,
      });
      expect(
        output(element).querySelector(".percentage")?.textContent?.trim()
      ).to.equal("12.5%");
    });
  }
});
