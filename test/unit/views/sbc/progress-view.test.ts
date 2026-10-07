import { expect, fixtureSync, html, waitUntil } from "@open-wc/testing";
import { MOCK_BLOCK_DEVICES } from "../../../../src/api/mock-data.js";
import { storeDriveSelection } from "../../../../src/utils/drive-selection.js";
import type { FlashRequest } from "../../../../src/api/types.js";
import { wizardState } from "../../../../src/state/wizard-state.js";
import "../../../../src/views/sbc/progress-view.js";
import type { ProgressView } from "../../../../src/views/sbc/progress-view.js";
import { mockTauriIpc, restoreTauriIpc } from "../../tauri-ipc.js";

describe("progress-view", () => {
  beforeEach(() => {
    wizardState.startFlow("sbc");
    // Nothing may reach the backend when the selections are incomplete
    mockTauriIpc((cmd) => {
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });
  });

  afterEach(() => {
    wizardState.reset();
    restoreTauriIpc();
  });

  it("sends the selected hardware serial to the backend recheck", async () => {
    storeDriveSelection(MOCK_BLOCK_DEVICES[0]);
    wizardState.setSelection("deviceConfig", {
      board: "rpi5-64",
      download_url: "https://example.test/haos.img.xz",
    });
    let request: FlashRequest | undefined;
    mockTauriIpc((cmd, args) => {
      if (cmd !== "flash_image")
        throw new Error(`Unexpected IPC command: ${cmd}`);
      request = (args as { request: FlashRequest }).request;
      return { success: false, error: "Fixture: no disk write" };
    });
    fixtureSync<ProgressView>(html`<progress-view></progress-view>`);
    await waitUntil(() => request !== undefined);
    expect(request!.expected_device.serial).to.equal(
      MOCK_BLOCK_DEVICES[0].serial
    );
  });

  it("reports a missing drive or device config to the app shell", async () => {
    // The app shell only shows Cancel and Try again after flash-error
    let errorEvents = 0;
    const onError = () => errorEvents++;
    document.addEventListener("flash-error", onError);

    try {
      const el = fixtureSync<ProgressView>(
        html`<progress-view></progress-view>`
      );
      await el.updateComplete;

      expect(el.hasError).to.be.true;
      expect(el.shadowRoot!.textContent).to.contain(
        "Missing drive or device configuration"
      );
      expect(errorEvents).to.equal(1);
    } finally {
      document.removeEventListener("flash-error", onError);
    }
  });
});
