/**
 * Barcode reads from `react-native-camera-kit`, before they become a React view.
 *
 * The same digits are emitted once per debounce window (barcode.md US-10).
 * QR and every non-product symbology are dropped. Permission failures are
 * named: `camera_permission_missing` when the host app has not declared the
 * permission, `camera_permission_denied` when the end user or the OS refused.
 */

export type ProductBarcodeFormat = "UPC_A" | "UPC_E" | "EAN_8" | "EAN_13";

export type ScanErrorCode = "camera_permission_missing" | "camera_permission_denied";

/** A product barcode the camera decoded. */
export interface ScannedBarcode {
  readonly code: string;
  readonly format: ProductBarcodeFormat;
}

/** A scan that stopped before a barcode was read. */
export class TrackCoreCameraError extends Error {
  readonly code: ScanErrorCode;
  /** Whether the OS will show the permission prompt again. */
  readonly canReprompt: boolean;

  constructor(code: ScanErrorCode, message: string, canReprompt: boolean) {
    super(message);
    this.name = "TrackCoreCameraError";
    this.code = code;
    this.canReprompt = canReprompt;
  }
}

const DEFAULT_WINDOW_MS = 2000;

/** Product formats `react-native-camera-kit` is asked to read. QR is absent. */
export const PRODUCT_BARCODE_TYPES = ["ean-13", "ean-8", "upc-a", "upc-e"] as const;

/**
 * Maps a camera-kit `codeFormat` onto a TrackCore symbology.
 * Anything else, including `qr`, is ignored.
 */
export function productFormat(codeFormat: string): ProductBarcodeFormat | null {
  switch (codeFormat.toLowerCase().replace(/_/g, "-")) {
    case "upc-a":
      return "UPC_A";
    case "upc-e":
      return "UPC_E";
    case "ean-8":
      return "EAN_8";
    case "ean-13":
      return "EAN_13";
    default:
      return null;
  }
}

/** Same-code suppression. A different code is accepted immediately. */
export class ScanDebounce {
  private code: string | null = null;
  private at = 0;

  constructor(
    readonly windowMs: number = DEFAULT_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** The code to emit, or null when this read is inside the window. */
  consider(next: ScannedBarcode): ScannedBarcode | null {
    const at = this.now();
    if (this.code === next.code && at - this.at < this.windowMs) return null;
    this.code = next.code;
    this.at = at;
    return next;
  }
}

/**
 * Turns a camera-kit authorization result into granted or not.
 * The library has returned both a boolean and a status string.
 */
export function isCameraGranted(value: unknown): boolean {
  return value === true || value === "authorized" || value === "granted";
}

/** A thrown camera-kit or OS error, named for the caller. */
export function cameraErrorFrom(error: unknown): TrackCoreCameraError {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const missing =
    lower.includes("nscamerausagedescription") ||
    lower.includes("info.plist") ||
    lower.includes("privacy-sensitive") ||
    (lower.includes("manifest") && lower.includes("camera"));
  if (missing) {
    return new TrackCoreCameraError(
      "camera_permission_missing",
      "The app has not declared camera permission. Add NSCameraUsageDescription on iOS and android.permission.CAMERA on Android.",
      false,
    );
  }
  return new TrackCoreCameraError("camera_permission_denied", "Camera access was denied.", false);
}

export interface BarcodeLookupClient {
  barcode: {
    lookup(code: string): Promise<unknown>;
  };
}

/**
 * Holds decoded barcodes for [TrackCoreBarcodeScanner] and for `scanAndLookup`.
 * Construct one, render the scanner with it, then read [scan] or call
 * [scanAndLookup].
 */
export class BarcodeScanSession {
  private readonly debounce: ScanDebounce;
  private readonly listeners = new Set<(code: ScannedBarcode) => void>();
  private readonly waiters: Array<{
    resolve: (code: ScannedBarcode) => void;
    reject: (error: TrackCoreCameraError) => void;
  }> = [];
  private failure: TrackCoreCameraError | null = null;
  private closed = false;

  constructor(windowMs: number = DEFAULT_WINDOW_MS, now?: () => number) {
    this.debounce = new ScanDebounce(windowMs, now);
  }

  /** Subscribe to decoded product barcodes. Returns the unsubscribe function. */
  scan(listener: (code: ScannedBarcode) => void): () => void {
    const failure = this.failure;
    if (failure !== null) throw failure;
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** One detector event. Duplicates and non-product codes are dropped. */
  add(code: string, codeFormat: string): void {
    if (this.closed || this.failure !== null) return;
    const trimmed = code.trim();
    if (trimmed === "") return;
    const format = productFormat(codeFormat);
    if (format === null) return;
    const accepted = this.debounce.consider({ code: trimmed, format });
    if (accepted === null) return;
    for (const listener of this.listeners) listener(accepted);
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter.resolve(accepted);
  }

  /** Stops the session with [error]. Later reads throw the same error. */
  fail(error: TrackCoreCameraError): void {
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  /**
   * The lookup of the next accepted barcode.
   * A server miss is the resolved value. A permission failure rejects.
   */
  scanAndLookup(client: BarcodeLookupClient): Promise<unknown> {
    const failure = this.failure;
    if (failure !== null) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      this.waiters.push({
        resolve: (code) => {
          Promise.resolve(client.barcode.lookup(code.code)).then(resolve, reject);
        },
        reject,
      });
    });
  }

  /** Drops listeners. Does not close the native camera; unmount the view. */
  stop(): void {
    this.closed = true;
    this.listeners.clear();
    this.waiters.length = 0;
  }
}

/**
 * Asks camera-kit whether the camera may open.
 * [check] and [request] are `CameraApi`'s authorization methods.
 */
export async function ensureCameraAccess(
  check: () => Promise<unknown>,
  request: () => Promise<unknown>,
): Promise<void> {
  let checked: unknown;
  try {
    checked = await check();
  } catch (error) {
    throw cameraErrorFrom(error);
  }
  if (isCameraGranted(checked)) return;
  let requested: unknown;
  try {
    requested = await request();
  } catch (error) {
    throw cameraErrorFrom(error);
  }
  if (isCameraGranted(requested)) return;
  throw new TrackCoreCameraError("camera_permission_denied", "Camera access was denied.", false);
}
