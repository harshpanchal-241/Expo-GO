// ============================================================================
// USER CONFIGURABLE PARAMETERS (Optimized for Ultra-Low Latency & Fast Response)
// ============================================================================
export const INITIAL_SAMPLE_SIZE = 2;       // Instant fast lock (1-2 packets)
export const MEDIAN_WINDOW = 3;             // Rolling median filter size
export const UI_UPDATE_INTERVAL_MS = 50;    // UI refresh rate in ms (20 FPS for silky response)
export const STATIONARY_STEP_LIMIT = 0.50;  // Max distance change (m) per update when stable
export const MOVING_STEP_LIMIT = 2.00;      // Max distance change (m) per update when moving
export const DEAD_ZONE = 0.12;              // Ignore tiny noise fluctuations (m) when stationary
export const APPROACH_SENSITIVITY = 1.4;    // High-speed reaction multiplier when getting closer
export const AWAY_SENSITIVITY = 1.2;        // High-speed reaction multiplier when moving away
export const ONE_EURO_MIN_CUTOFF = 1.2;     // Baseline frequency in Hz (smooth when stationary)
export const ONE_EURO_BETA = 0.45;          // Responsiveness factor (zero lag when moving)
export const DEFAULT_TX_POWER = -59;        // Measured RSSI at 1 meter (dBm)
export const DEFAULT_ENV_N = 2.2;           // Path loss exponent for indoor environment
// ============================================================================

import { Platform, PermissionsAndroid, Alert, Linking, NativeModules } from "react-native";

let BleManager = null;
try {
  const bleModule = require("react-native-ble-plx");
  BleManager = bleModule.BleManager;
} catch (e) {
  console.warn("react-native-ble-plx could not be loaded:", e);
}

// Singleton BLE manager instance
let bleManagerInstance = null;
let bleInitError = null;

export function isBleSupported() {
  return !!(
    BleManager &&
    (NativeModules.BleClientModule || NativeModules.BleClient || NativeModules.RNBLE)
  );
}

export function getBleManager() {
  if (bleInitError) return null;
  if (!bleManagerInstance) {
    if (!BleManager) {
      bleInitError = "BLE module not loaded";
      return null;
    }
    try {
      bleManagerInstance = new BleManager();
    } catch (err) {
      console.warn("Failed to instantiate BleManager (Expo Go does not support native BLE without custom build):", err);
      bleInitError = err;
      return null;
    }
  }
  return bleManagerInstance;
}

// ============================================================================
// LOW-PASS & ONE-EURO FILTER IMPLEMENTATION
// ============================================================================
class LowPassFilter {
  constructor(alpha = 1.0, initVal = 0) {
    this.alpha = alpha;
    this.s = initVal;
    this.initialized = false;
  }

  filter(val, alpha = this.alpha) {
    if (!this.initialized) {
      this.s = val;
      this.initialized = true;
      return val;
    }
    this.s = alpha * val + (1.0 - alpha) * this.s;
    return this.s;
  }

  last() {
    return this.s;
  }

  reset() {
    this.initialized = false;
  }
}

export class OneEuroFilter {
  constructor(minCutoff = ONE_EURO_MIN_CUTOFF, beta = ONE_EURO_BETA, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.xFilter = new LowPassFilter(1);
    this.dxFilter = new LowPassFilter(1);
    this.lastTime = null;
  }

  alpha(cutoff, dt) {
    const tau = 1.0 / (2.0 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / dt);
  }

  filter(val, timestamp = Date.now(), betaOverride = null, minCutoffOverride = null) {
    if (this.lastTime === null) {
      this.lastTime = timestamp;
      this.xFilter.filter(val);
      this.dxFilter.filter(0);
      return val;
    }

    const dt = Math.max(0.001, (timestamp - this.lastTime) / 1000.0);
    this.lastTime = timestamp;

    const prevX = this.xFilter.last();
    const dx = (val - prevX) / dt;
    const edx = this.dxFilter.filter(dx, this.alpha(this.dCutoff, dt));

    const curBeta = betaOverride !== null ? betaOverride : this.beta;
    const curMinCutoff = minCutoffOverride !== null ? minCutoffOverride : this.minCutoff;

    const cutoff = curMinCutoff + curBeta * Math.abs(edx);
    return this.xFilter.filter(val, this.alpha(cutoff, dt));
  }

  reset() {
    this.lastTime = null;
    this.xFilter.reset();
    this.dxFilter.reset();
  }
}

// ============================================================================
// PER-DEVICE FAST & SMOOTH DISTANCE TRACKER
// ============================================================================
export class DeviceDistanceTracker {
  constructor(deviceId, txPower = DEFAULT_TX_POWER, envN = DEFAULT_ENV_N) {
    this.deviceId = deviceId;
    this.txPower = txPower;
    this.envN = envN;

    this.initialSamples = [];
    this.rollingWindow = [];
    this.recentDistances = [];
    this.isLocked = false;

    this.oneEuro = new OneEuroFilter(ONE_EURO_MIN_CUTOFF, ONE_EURO_BETA);

    this.rawRssi = null;
    this.filteredRssi = null;
    this.targetDistance = null;
    this.currentDistance = null;
    this.trend = "stationary"; // "approaching" | "stationary" | "moving_away"
    this.lastPacketTime = Date.now();
  }

  updateParams(txPower, envN) {
    this.txPower = txPower;
    this.envN = envN;
    if (this.filteredRssi !== null) {
      this.targetDistance = this.rssiToDistance(this.filteredRssi);
    }
  }

  rssiToDistance(rssi) {
    if (!rssi || rssi === 0) return null;
    const ratio = (this.txPower - rssi) / (10 * this.envN);
    return Math.pow(10, ratio);
  }

  addPacket(rawRssi, timestamp = Date.now()) {
    if (typeof rawRssi !== "number" || isNaN(rawRssi)) return;

    // Outlier rejection for impossible BLE RSSI values
    if (rawRssi < -115 || rawRssi > -10) return;

    this.rawRssi = rawRssi;
    this.lastPacketTime = timestamp;

    // ------------------------------------------------------------------------
    // PHASE 1: Fast Initial Lock (Show instant estimate on packet #1 & #2)
    // ------------------------------------------------------------------------
    if (!this.isLocked) {
      this.initialSamples.push(rawRssi);
      this.rollingWindow.push(rawRssi);

      const initDist = this.rssiToDistance(rawRssi);
      this.targetDistance = initDist;
      if (this.currentDistance === null) {
        this.currentDistance = initDist;
        this.recentDistances = [initDist];
      }
      this.filteredRssi = rawRssi;

      if (this.initialSamples.length >= INITIAL_SAMPLE_SIZE) {
        const sorted = [...this.initialSamples].sort((a, b) => a - b);
        const medianRssi = sorted[Math.floor(sorted.length / 2)];
        this.filteredRssi = medianRssi;
        this.oneEuro.filter(medianRssi, timestamp);
        const refinedDist = this.rssiToDistance(medianRssi);
        this.targetDistance = refinedDist;
        this.currentDistance = refinedDist;
        this.recentDistances = [refinedDist];
        this.isLocked = true;
      }
      return;
    }

    // ------------------------------------------------------------------------
    // PHASE 2: Tracking Mode (Rolling Median + One-Euro Filter)
    // ------------------------------------------------------------------------
    this.rollingWindow.push(rawRssi);
    if (this.rollingWindow.length > MEDIAN_WINDOW) {
      this.rollingWindow.shift();
    }

    const sortedWindow = [...this.rollingWindow].sort((a, b) => a - b);
    const medianWindowRssi = sortedWindow[Math.floor(sortedWindow.length / 2)];

    // Adaptive One-Euro tuning based on current detected trend
    let beta = ONE_EURO_BETA;
    let minCutoff = ONE_EURO_MIN_CUTOFF;

    if (this.trend === "approaching") {
      beta *= APPROACH_SENSITIVITY;
      minCutoff *= 1.8; // Open up cutoff frequency for instantaneous approach tracking
    } else if (this.trend === "moving_away") {
      beta *= AWAY_SENSITIVITY;
      minCutoff *= 1.5;
    } else {
      // Stationary: high stability
      minCutoff *= 0.8;
    }

    this.filteredRssi = this.oneEuro.filter(medianWindowRssi, timestamp, beta, minCutoff);
    this.targetDistance = this.rssiToDistance(this.filteredRssi);

    // Update movement trend
    this.updateTrend(this.targetDistance);
  }

  updateTrend(newTargetDist) {
    if (newTargetDist === null) return;
    this.recentDistances.push(newTargetDist);
    if (this.recentDistances.length > 4) {
      this.recentDistances.shift();
    }

    if (this.recentDistances.length < 2) {
      this.trend = "stationary";
      return;
    }

    const first = this.recentDistances[0];
    const last = this.recentDistances[this.recentDistances.length - 1];
    const diff = last - first;

    if (diff < -0.20) {
      this.trend = "approaching";
    } else if (diff > 0.25) {
      this.trend = "moving_away";
    } else {
      this.trend = "stationary";
    }
  }

  // --------------------------------------------------------------------------
  // Dynamic Rate Limiter & Dead Zone Step (Smooth & Zero Lag)
  // --------------------------------------------------------------------------
  stepDistance() {
    if (this.targetDistance === null) return null;
    if (this.currentDistance === null) {
      this.currentDistance = this.targetDistance;
      return Number(this.currentDistance.toFixed(2));
    }

    const diff = this.targetDistance - this.currentDistance;
    const absDiff = Math.abs(diff);

    // Dead Zone: ignore microscopic noise jitter when stationary
    if (this.trend === "stationary" && absDiff < DEAD_ZONE) {
      return Number(this.currentDistance.toFixed(2));
    }

    // Adaptive step limit based on state
    let stepLimit;
    if (this.trend === "approaching") {
      stepLimit = MOVING_STEP_LIMIT * APPROACH_SENSITIVITY;
    } else if (this.trend === "moving_away") {
      stepLimit = MOVING_STEP_LIMIT * AWAY_SENSITIVITY;
    } else {
      stepLimit = STATIONARY_STEP_LIMIT;
    }

    // Proportional dynamic step: closes 50% of gap or stepLimit per tick (fast convergence without spikes)
    const dynamicStep = Math.max(stepLimit, absDiff * 0.50);
    const step = Math.sign(diff) * Math.min(absDiff, dynamicStep);
    this.currentDistance += step;

    return Number(this.currentDistance.toFixed(2));
  }

  getState() {
    return {
      isLocked: this.isLocked,
      sampleCount: this.initialSamples.length,
      rawRssi: this.rawRssi,
      filteredRssi: this.filteredRssi !== null ? Math.round(this.filteredRssi) : this.rawRssi,
      distance: this.currentDistance !== null ? Number(this.currentDistance.toFixed(2)) : null,
      targetDistance: this.targetDistance !== null ? Number(this.targetDistance.toFixed(2)) : null,
      trend: this.trend,
      lastSeen: this.lastPacketTime
    };
  }

  reset() {
    this.initialSamples = [];
    this.rollingWindow = [];
    this.recentDistances = [];
    this.isLocked = false;
    this.oneEuro.reset();
    this.rawRssi = null;
    this.filteredRssi = null;
    this.targetDistance = null;
    this.currentDistance = null;
    this.trend = "stationary";
  }
}

/**
 * Calculates raw estimated physical distance (in meters) from RSSI
 */
export function calculateDistance(rssi, measuredPower = DEFAULT_TX_POWER, pathLossExponent = DEFAULT_ENV_N) {
  if (!rssi || rssi === 0) return null;
  const ratio = (measuredPower - rssi) / (10 * pathLossExponent);
  const distance = Math.pow(10, ratio);
  return Number(distance.toFixed(2));
}

/**
 * Categorize RSSI into human readable signal quality and color scheme
 */
export function getSignalQuality(rssi) {
  if (rssi >= -60) {
    return { label: "Excellent", color: "#1a7f37", bg: "#dafbe1", percentage: 100 };
  } else if (rssi >= -72) {
    return { label: "Good", color: "#0969da", bg: "#ddf4ff", percentage: 75 };
  } else if (rssi >= -85) {
    return { label: "Fair", color: "#d29922", bg: "#fff8c5", percentage: 45 };
  } else {
    return { label: "Weak", color: "#cf222e", bg: "#ffebe9", percentage: 20 };
  }
}

/**
 * Request all necessary Bluetooth and Location permissions across Android versions
 */
export async function requestBluetoothPermissions() {
  if (Platform.OS === "android") {
    const apiLevel = Platform.Version;

    // Android 12+ (API level 31+)
    if (apiLevel >= 31) {
      const granted = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      ]);

      const scanGranted = granted[PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN] === PermissionsAndroid.RESULTS.GRANTED;
      const connectGranted = granted[PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT] === PermissionsAndroid.RESULTS.GRANTED;
      const locationGranted = granted[PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION] === PermissionsAndroid.RESULTS.GRANTED;

      return scanGranted && connectGranted && locationGranted;
    } else {
      // Android < 12 requires Location permission to scan for BLE beacons
      const granted = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
      ]);

      const fineGranted = granted[PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION] === PermissionsAndroid.RESULTS.GRANTED;
      const coarseGranted = granted[PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION] === PermissionsAndroid.RESULTS.GRANTED;

      return fineGranted || coarseGranted;
    }
  }

  // iOS permissions are handled automatically via Info.plist dialog upon initial BLE call
  return true;
}

/**
 * Prompt user to enable Bluetooth adapter if it's currently powered off
 */
export async function ensureBluetoothEnabled() {
  const manager = getBleManager();
  if (!manager) return false;
  try {
    const state = await manager.state();
    if (state === "PoweredOff") {
      if (Platform.OS === "android") {
        try {
          await manager.enable();
          return true;
        } catch (e) {
          Alert.alert(
            "Bluetooth is Disabled",
            "Please turn on Bluetooth in your device settings to scan for nearby BLE beacons.",
            [
              { text: "Cancel", style: "cancel" },
              { text: "Open Settings", onPress: () => Linking.openSettings() }
            ]
          );
          return false;
        }
      } else {
        Alert.alert(
          "Bluetooth is Disabled",
          "Please turn on Bluetooth in Settings to discover nearby beacons.",
          [
            { text: "Cancel", style: "cancel" },
            { text: "Open Settings", onPress: () => Linking.openSettings() }
          ]
        );
        return false;
      }
    }
    return state === "PoweredOn";
  } catch (err) {
    console.warn("Error checking Bluetooth state:", err);
    return false;
  }
}
