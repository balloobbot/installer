import type { BlockDevice } from "../api/types.js";
import { wizardState, type WizardSelections } from "../state/wizard-state.js";

/**
 * Snapshot of the drive the user picked, taken at selection time.
 *
 * The device id doubles as the path handed to the backend (`/dev/sda`,
 * `disk2`, `\\.\PhysicalDrive1`), and the OS is free to hand that same path to
 * a different device once the original is unplugged. Compare the hardware
 * serial when available, along with the size, model and vendor.
 *
 * `undefined` means the value is unknown.
 */
export interface DriveIdentity {
  id: string;
  name: string;
  size?: number;
  model?: string;
  vendor?: string;
  serial?: string;
}

export function driveIdentity(drive: BlockDevice): DriveIdentity {
  return {
    id: drive.id,
    name: drive.name,
    size: drive.size,
    // The backend sends null for a value the device does not report.
    model: drive.model ?? undefined,
    vendor: drive.vendor ?? undefined,
    serial: drive.serial ?? undefined,
  };
}

/**
 * Whether the current snapshot still matches the selected device.
 *
 * `name` is deliberately excluded: it is a display label some enumerators
 * build from the mount state, so it can change while the device does not.
 * An unknown size never matches, since every enumerated device has one.
 * Only require a serial when it was known at selection time.
 */
export function isSameDrive(
  selected: DriveIdentity,
  current: DriveIdentity
): boolean {
  return (
    selected.id === current.id &&
    selected.size !== undefined &&
    selected.size === current.size &&
    selected.model === current.model &&
    selected.vendor === current.vendor &&
    (selected.serial === undefined || selected.serial === current.serial)
  );
}

/** Drives smaller than this (1 GB) are not offered as flash targets. */
export const MIN_DRIVE_SIZE_BYTES = 1_000_000_000;

/**
 * Enumeration returns every disk, internal ones included, so this is the gate
 * for what the SBC flow offers: a drive must be removable and at least
 * {@link MIN_DRIVE_SIZE_BYTES}. The pre-erase re-checks use it too, so they
 * accept exactly the drives the picker offers.
 */
export function isEligibleFlashTarget(drive: BlockDevice): boolean {
  return drive.removable && drive.size >= MIN_DRIVE_SIZE_BYTES;
}

/**
 * The eligible drive in `drives` that is still the one described by
 * `identity`.
 */
export function findDrive(
  drives: BlockDevice[],
  identity: DriveIdentity
): BlockDevice | null {
  return (
    drives
      .filter(isEligibleFlashTarget)
      .find((drive) => isSameDrive(identity, driveIdentity(drive))) ?? null
  );
}

/** The stored selection, or null when nothing is selected. */
export function readDriveSelection(
  selections: WizardSelections
): DriveIdentity | null {
  if (!selections.drive) {
    return null;
  }
  return {
    id: selections.drive,
    name: selections.driveName || "",
    size: selections.driveSize,
    model: selections.driveModel,
    vendor: selections.driveVendor,
    serial: selections.driveSerial,
  };
}

/** Record the full identity, not just the path, so it can be re-checked later. */
export function storeDriveSelection(drive: BlockDevice) {
  const identity = driveIdentity(drive);
  wizardState.setSelection("drive", identity.id);
  wizardState.setSelection("driveName", identity.name);
  wizardState.setSelection("driveSize", identity.size);
  wizardState.setSelection("driveModel", identity.model);
  wizardState.setSelection("driveVendor", identity.vendor);
  wizardState.setSelection("driveSerial", identity.serial);
}

export function clearDriveSelection() {
  wizardState.setSelection("drive", undefined);
  wizardState.setSelection("driveName", undefined);
  wizardState.setSelection("driveSize", undefined);
  wizardState.setSelection("driveModel", undefined);
  wizardState.setSelection("driveVendor", undefined);
  wizardState.setSelection("driveSerial", undefined);
}
