import { localize } from "../../localization/localize.js";
import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { wizardState } from "../../state/wizard-state.js";
import { openExternalUrl } from "../../utils/external-url.js";
import "../../components/info-dialog.js";

@customElement("minipc-setup-method-view")
export class MiniPCSetupMethodView extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      align-items: center;
      height: 100%;
    }

    h2 {
      font-size: 1.5rem;
      font-weight: 400;
      color: var(--ha-text-color, #212121);
      margin: 0 0 0.5rem 0;
      text-align: center;
    }

    .subtitle {
      font-size: 1rem;
      color: var(--ha-secondary-text-color, #727272);
      margin: 0 0 2rem 0;
      text-align: center;
      max-width: 500px;
    }

    .options {
      display: flex;
      flex-direction: column;
      gap: 1rem;
      width: 100%;
      max-width: 500px;
    }

    .option-card {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: 1.5rem;
      background-color: var(--ha-card-background, #ffffff);
      border: 2px solid var(--ha-border-color, #e0e0e0);
      border-radius: 12px;
      cursor: pointer;
      transition:
        border-color 0.2s ease,
        box-shadow 0.2s ease;
    }

    .option-card:hover {
      border-color: var(--ha-primary-color, #03a9f4);
      box-shadow: 0 2px 8px rgba(3, 169, 244, 0.15);
    }

    @media (prefers-color-scheme: dark) {
      .option-card {
        background-color: var(--ha-card-background, #1e1e1e);
        border-color: var(--ha-border-color, #333333);
      }

      .option-card:hover {
        box-shadow: 0 2px 8px rgba(3, 169, 244, 0.25);
      }
    }

    .option-icon {
      width: 48px;
      height: 48px;
      flex-shrink: 0;
    }

    .option-icon img {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }

    .option-content {
      flex: 1;
    }

    .option-title {
      font-size: 1.125rem;
      font-weight: 500;
      color: var(--ha-text-color, #212121);
      margin: 0 0 0.25rem 0;
    }

    .option-description {
      font-size: 0.875rem;
      color: var(--ha-secondary-text-color, #727272);
      margin: 0;
      line-height: 1.4;
    }

    .option-arrow {
      font-size: 1.25rem;
      color: var(--ha-secondary-text-color, #9e9e9e);
    }
  `;

  @state()
  private _showUsbDialog = false;

  render() {
    return html`
      <h2>
        ${localize("views.minipc.setup_method_view.how_will_you_install")}
      </h2>
      <p class="subtitle">
        ${localize(
          "views.minipc.setup_method_view.choose_how_you_want_to_install_home_assistant_on_your_mini_pc"
        )}
      </p>

      <div class="options">
        <div class="option-card" @click=${this._onConnectDrive}>
          <div class="option-icon">
            <img
              src="/assets/icons/drive-connect.svg"
              alt=${localize("views.minipc.setup_method_view.connect_drive")}
            />
          </div>
          <div class="option-content">
            <p class="option-title">
              ${localize(
                "views.minipc.setup_method_view.i_can_connect_the_drive"
              )}
            </p>
            <p class="option-description">
              ${localize(
                "views.minipc.setup_method_view.connect_the_ssd_or_nvme_drive_from_your_mini_pc_to_this_computer_via_usb_ad"
              )}
            </p>
          </div>
          <span class="option-arrow">→</span>
        </div>

        <div class="option-card" @click=${this._onUsbBoot}>
          <div class="option-icon">
            <img
              src="/assets/icons/usb-boot.svg"
              alt=${localize("views.minipc.setup_method_view.usb_boot")}
            />
          </div>
          <div class="option-content">
            <p class="option-title">
              ${localize(
                "views.minipc.setup_method_view.i_need_to_boot_from_usb"
              )}
            </p>
            <p class="option-description">
              ${localize(
                "views.minipc.setup_method_view.create_a_bootable_usb_drive_to_install_home_assistant_directly_on_the_mini_"
              )}
            </p>
          </div>
          <span class="option-arrow">→</span>
        </div>
      </div>

      <info-dialog
        ?open=${this._showUsbDialog}
        title=${localize(
          "views.minipc.setup_method_view.usb_boot_installation"
        )}
        message=${localize(
          "views.minipc.setup_method_view.creating_bootable_usb_drives_is_not_supported_by_this_installer_however_we_"
        )}
        primaryLabel=${localize("common.view_instructions")}
        secondaryLabel=${localize("common.go_back")}
        @dialog-primary=${this._onOpenDocs}
        @dialog-secondary=${this._onCloseDialog}
      ></info-dialog>
    `;
  }

  private _onConnectDrive() {
    wizardState.setSelection("installMethod", "direct");
    wizardState.nextStep();
  }

  private _onUsbBoot() {
    this._showUsbDialog = true;
  }

  private _onCloseDialog() {
    this._showUsbDialog = false;
  }

  private async _onOpenDocs() {
    this._showUsbDialog = false;
    await openExternalUrl(
      "https://www.home-assistant.io/installation/generic-x86-64"
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "minipc-setup-method-view": MiniPCSetupMethodView;
  }
}
