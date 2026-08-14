# PDR Test — Expo Go (No Android Studio)

## Requirements
- Node.js 20.19+ on Windows
- Expo Go on your phone
- PC and phone on the same Wi-Fi

## Run
Open PowerShell in this folder:

```powershell
npm install
npx expo install --fix
npx expo start
```

Scan the QR code with Expo Go.

If LAN mode cannot connect:
```powershell
npx expo start --tunnel
```

## Test procedure
1. Measure a 10 m straight path.
2. Count your steps.
3. Calculate step length = 10 / steps.
4. Enter it in the app.
5. Hold phone flat, screen up, top edge facing forward.
6. Tap **Set Heading Zero**.
7. Tap **Start**.
8. Walk a 10 m × 5 m rectangle and return to the start.
9. Tap **Stop**.
10. Check the drawn path and **Drift from start**.

This version is intentionally PDR-only: no BLE, Kalman, or map matching.
