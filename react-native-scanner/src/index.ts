/**
 * TrackCore barcode camera for React Native.
 *
 * Optional. `@trackcore/react-native` does not depend on this package, so an
 * app that only searches for food does not link `react-native-camera-kit`.
 *
 * ```tsx
 * const session = new BarcodeScanSession();
 * const pending = session.scanAndLookup(client);
 * return <TrackCoreBarcodeScanner session={session} />;
 * ```
 */

export { TrackCoreBarcodeScanner } from "./scanner";
export {
  BarcodeScanSession,
  PRODUCT_BARCODE_TYPES,
  ScanDebounce,
  TrackCoreCameraError,
  cameraErrorFrom,
  ensureCameraAccess,
  isCameraGranted,
  productFormat,
  type BarcodeLookupClient,
  type ProductBarcodeFormat,
  type ScanErrorCode,
  type ScannedBarcode,
} from "./scan";
