import { useEffect, useRef, type ReactElement } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import CameraKit, { Camera, type CameraApi } from "react-native-camera-kit";

import {
  BarcodeScanSession,
  PRODUCT_BARCODE_TYPES,
  TrackCoreCameraError,
  cameraErrorFrom,
  ensureCameraAccess,
} from "./scan";

type Authorization = {
  checkDeviceCameraAuthorizationStatus?: () => Promise<unknown>;
  requestDeviceCameraAuthorization?: () => Promise<unknown>;
};

/**
 * The camera view. Mount it with a [BarcodeScanSession].
 *
 * `react-native-camera-kit` reads the barcode. This view asks it for UPC-A,
 * UPC-E, EAN-8 and EAN-13 only, and the session drops a repeat of the same
 * digits for two seconds.
 *
 * Declare camera permission in the host app. This package cannot write the
 * usage string, because that string is the app's:
 *
 * iOS `Info.plist`: `NSCameraUsageDescription`.
 * Android: `android.permission.CAMERA`.
 */
export function TrackCoreBarcodeScanner({
  session,
  style,
}: {
  /** Where decoded barcodes and permission failures are delivered. */
  session: BarcodeScanSession;
  /** Layout of the preview. Defaults to filling the parent. */
  style?: StyleProp<ViewStyle>;
}): ReactElement {
  const camera = useRef<CameraApi | null>(null);

  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      const api = authorizationOf(camera.current);
      const check = api?.checkDeviceCameraAuthorizationStatus;
      const request = api?.requestDeviceCameraAuthorization;
      if (check === undefined || request === undefined) return;
      ensureCameraAccess(check, request).catch((error: unknown) => {
        if (!alive) return;
        session.fail(error instanceof TrackCoreCameraError ? error : cameraErrorFrom(error));
      });
    }, 0);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [session]);

  return (
    <Camera
      ref={camera}
      style={style ?? { flex: 1 }}
      scanBarcode
      showFrame
      scanThrottleDelay={300}
      allowedBarcodeTypes={[...PRODUCT_BARCODE_TYPES]}
      onReadCode={(event) => {
        session.add(event.nativeEvent.codeStringValue, event.nativeEvent.codeFormat);
      }}
      onError={(event) => {
        session.fail(cameraErrorFrom(new Error(event.nativeEvent.errorMessage)));
      }}
    />
  );
}

function authorizationOf(ref: CameraApi | null): Authorization | null {
  const fromRef = ref as Authorization | null;
  if (typeof fromRef?.checkDeviceCameraAuthorizationStatus === "function") return fromRef;
  const kit = CameraKit as Authorization;
  if (typeof kit.checkDeviceCameraAuthorizationStatus === "function") return kit;
  return null;
}
