# Indoor Navigation & PDR Testing App (Expo / React Native)

A cross-platform mobile application for real-time **Pedestrian Dead Reckoning (PDR)**, **Bluetooth Low Energy (BLE) Beacon Proximity Tracking**, and **Indoor Route Mapping**. Built with Expo, React Native, and EAS.

---

## 🌟 Key Features

### 🚶 1. Real-Time Pedestrian Dead Reckoning (PDR)
- **High-Precision Accelerometer FSM**:
  - 50 Hz continuous signal processing with dynamic gravity baseline removal and low-pass jitter filtering.
  - 3-state Finite State Machine (`IDLE` $\rightarrow$ `PEAK` $\rightarrow$ `VALLEY`) with refractory lockout ($260\text{ms}-1400\text{ms}$) for instantaneous, real-time step registration (<30ms latency).
  - Sensitivity presets: **High**, **Medium (Default)**, and **Low**.
- **Adaptive Weinberg Step Length Estimation**:
  - Dynamically calculates step length based on vertical bounce amplitude ($K = 0.74$ calibrated for $g$).
  - Toggle between Adaptive Weinberg ($0.60\text{m}-0.85\text{m}$) and Configurable Fixed Step Length ($0.70\text{m}$).
- **Continuous Circular Heading Engine**:
  - Continuous shortest-arc circular smoothing to prevent boundary discontinuities at $0^\circ$ and $\pm 180^\circ$.
  - Seamless forward zero calibration (**Set Heading Zero**).
  - Magnetometer azimuth fallback.
- **Interactive 2D Path Visualizer**:
  - Real-time SVG canvas with auto-scaling coordinate grid.
  - Live red directional arrow / cone indicator showing facing orientation.
  - Start point, live coordinates, and previous saved path overlay.
- **Loop Closure**:
  - One-tap drift elimination and coordinate re-centering back to $(0,0)$ upon completing closed-loop walks.
- **Path Storage & History**:
  - Save walked routes locally with step count, total distance, timestamps, and waypoint arrays.
  - Overlay or delete previous paths directly on the live map.

---

### 📶 2. BLE Beacon Scanner & Proximity Engine
- **Ultra-Low Latency Hardware Scanning**:
  - Android & iOS BLE scanning powered by `react-native-ble-plx` in `ScanMode.LowLatency`.
- **Adaptive 1-Euro Signal Filtering**:
  - Eliminates RSSI multi-path noise and signal fluctuations while preserving instantaneous response during rapid movements.
- **Distance Estimation**:
  - Log-Distance Path Loss Model: $d = 10^{\frac{\text{TxPower} - \text{RSSI}}{10 \cdot n}}$
  - Real-time calibration controls for **TxPower at 1m** and **Environmental Path Loss Exponent ($n$)**.
- **Focused Single-Device Testing Mode**:
  - Isolate and test a single beacon with live distance sparkline mini-charts, signal quality gauges, and movement trends (*Approaching*, *Stationary*, *Moving Away*).

---

### 🔄 3. Over-The-Air (OTA) Updates (EAS Updates)
- Built-in global **OTA Update Card** accessible across all screens.
- Check for new updates, download bundles in background, and reload instantly without reinstalling the APK.

---

## 📱 Hardware & Sensor Requirements

| Sensor | Purpose |
|---|---|
| **Accelerometer** | 50 Hz real-time step impact and bounce detection |
| **DeviceMotion / Gyroscope** | Yaw angle and smooth turn tracking |
| **Magnetometer** | Compass heading and ambient magnetic flux ($\mu\text{T}$) |
| **Bluetooth Low Energy (BLE)** | Beacon discovery and proximity distance estimation |

---

## 🚀 Getting Started

### Prerequisites
- **Node.js**: v20.x or higher
- **Expo CLI**: `npx expo`
- **EAS CLI**: `npx eas-cli` (for cloud builds and OTA updates)
- Android / iOS device with sensors and Bluetooth enabled.

### 1. Installation
Clone the repository and install dependencies:
```bash
git clone https://github.com/harshpanchal-241/Expo-GO.git
cd Expo-GO
npm install
```

### 2. Running Locally in Development
```bash
# Start local Metro bundler
npx expo start

# If using a physical device on different Wi-Fi subnet:
npx expo start --tunnel
```

---

## 🛠️ Building & Deploying with EAS

### 1. Build Standalone Android APK (Preview)
```bash
# Create an internal test APK via EAS Cloud
npx eas build --profile preview --platform android
```

### 2. Publish Over-The-Air (OTA) Updates
To push code updates directly to installed apps without rebuilding the APK:
```bash
# Publish to the preview channel
npx eas update --channel preview --message "Your update description"

# Or publish to production
npx eas update --channel production --message "Release update"
```

---

## 🚶 Testing PDR Walking Accuracy

1. Open the app and select **🚶 PDR Step Tracking**.
2. Hold the phone flat in your hand with the top edge pointing forward in your walking direction.
3. Tap **Set Heading Zero** to calibrate the forward direction ($0^\circ$).
4. Tap **Start Tracking**.
5. Walk a measured route (e.g. 10m straight or a 10m × 5m rectangle):
   - Check that steps increment immediately with each footstep.
   - Verify that turning right plots $+X$ (Right) and turning left plots $-X$ (Left).
   - Check the live red pointer on the map indicating your heading.
6. Return to your starting point and tap **Stop**.
7. Tap **Close Loop** to eliminate residual drift, or tap **Save Path** to store the route.

---

## 📂 Project Structure

```
├── App.android.js          # Main Android application component (PDR + BLE + OTA)
├── App.ios.js              # Main iOS application component
├── App.js                  # Platform router
├── components/
│   ├── BleScannerSection.js # BLE Beacon discovery, 1€-filter, and focused test mode
│   └── OtaUpdateCard.js     # Global EAS OTA update status and trigger button
├── services/
│   └── BleScannerService.js # BLE Manager, 1€-filter algorithm, distance model
├── PathStorage.js          # Persistent local storage for saved routes (AsyncStorage)
├── app.json                # Expo application configuration, permissions, and updates URL
├── eas.json                # EAS Build & Channel configuration
└── package.json            # Dependencies and scripts
```

---

## 📄 License
Private project for Indoor Navigation and PDR research.
