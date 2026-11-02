# @trackcore/react-native-scanner

Optional React Native camera for TrackCore barcode lookup. The core
`@trackcore/react-native` package does not depend on this one.

The camera is `react-native-camera-kit`. It decodes the barcode. This package
asks it for UPC-A, UPC-E, EAN-8 and EAN-13, and it does not emit the same
digits again for two seconds.

```tsx
const session = new BarcodeScanSession();
const pending = session.scanAndLookup(client);
return <TrackCoreBarcodeScanner session={session} />;
```

A miss from the server is a result. A missing declaration is
`camera_permission_missing`. A denial is `camera_permission_denied`, and
`canReprompt` says whether the OS will ask again.

## iOS

```xml
<key>NSCameraUsageDescription</key>
<string>Scan a food barcode.</string>
```

## Android

```xml
<uses-permission android:name="android.permission.CAMERA" />
```
