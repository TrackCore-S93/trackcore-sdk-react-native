import {
  BarcodeScanSession,
  ScanDebounce,
  cameraErrorFrom,
  ensureCameraAccess,
  isCameraGranted,
  productFormat,
} from "../src/scan";

describe("product formats", () => {
  it("keeps UPC and EAN and drops QR", () => {
    expect(productFormat("ean-13")).toBe("EAN_13");
    expect(productFormat("upc_a")).toBe("UPC_A");
    expect(productFormat("upc-e")).toBe("UPC_E");
    expect(productFormat("ean-8")).toBe("EAN_8");
    expect(productFormat("qr")).toBeNull();
    expect(productFormat("code-128")).toBeNull();
  });
});

describe("debounce", () => {
  it("suppresses the same code inside the window and emits a different one", () => {
    let now = 1_000;
    const debounce = new ScanDebounce(2000, () => now);
    const cola = { code: "3017624010701", format: "EAN_13" as const };
    const other = { code: "96385074", format: "EAN_8" as const };
    expect(debounce.consider(cola)).toEqual(cola);
    now += 500;
    expect(debounce.consider(cola)).toBeNull();
    expect(debounce.consider(other)).toEqual(other);
    now += 2000;
    expect(debounce.consider(other)).toEqual(other);
  });
});

describe("permission", () => {
  it("treats a missing usage description as camera_permission_missing", () => {
    const error = cameraErrorFrom(
      new Error(
        "This app has crashed because it attempted to access privacy-sensitive data without a usage description. NSCameraUsageDescription",
      ),
    );
    expect(error.code).toBe("camera_permission_missing");
    expect(error.canReprompt).toBe(false);
  });

  it("treats a refusal as camera_permission_denied", async () => {
    const denied = cameraErrorFrom(new Error("The user declined"));
    expect(denied.code).toBe("camera_permission_denied");
    expect(denied.canReprompt).toBe(false);

    expect(isCameraGranted(true)).toBe(true);
    expect(isCameraGranted("granted")).toBe(true);
    expect(isCameraGranted(false)).toBe(false);

    await expect(ensureCameraAccess(async () => false, async () => false)).rejects.toMatchObject({
      code: "camera_permission_denied",
      canReprompt: false,
    });
    await expect(
      ensureCameraAccess(async () => {
        throw new Error("Info.plist must contain NSCameraUsageDescription");
      }, async () => true),
    ).rejects.toMatchObject({ code: "camera_permission_missing" });
  });
});

describe("session", () => {
  it("looks up the next accepted code and ignores a repeat and a QR", async () => {
    let now = 0;
    const session = new BarcodeScanSession(2000, () => now);
    const seen: string[] = [];
    session.scan((code) => seen.push(code.code));
    const pending = session.scanAndLookup({
      barcode: { lookup: async (code) => ({ status: "found", code }) },
    });
    session.add("3017624010701", "ean-13");
    session.add("3017624010701", "ean-13");
    session.add("https://example", "qr");
    await expect(pending).resolves.toEqual({ status: "found", code: "3017624010701" });
    expect(seen).toEqual(["3017624010701"]);
    now += 2000;
    session.add("96385074", "ean-8");
    expect(seen).toEqual(["3017624010701", "96385074"]);
  });

  it("rejects a lookup that is waiting when permission fails", async () => {
    const session = new BarcodeScanSession();
    const pending = session.scanAndLookup({
      barcode: { lookup: async () => ({}) },
    });
    session.fail(cameraErrorFrom(new Error("denied")));
    await expect(pending).rejects.toMatchObject({ code: "camera_permission_denied" });
  });
});
