// ============================================================================
// BLE SCANNER & DISTANCE FILTER CONFIGURATION
// Multi-Stage Processing Pipeline:
// 1. Outlier Gating: Discards corrupted/unphysical RSSI values outside [-105, -15] dBm.
// 2. Rolling Median Filter: 5-sample window strips channel-hopping noise (ch 37/38/39).
// 3. One-Euro Adaptive Low-Pass Filter: Suppresses jitter at rest (0.35 Hz) with 0-lag tracking on movement.
// 4. Asymmetric dBm EMA: Smooths signal drops (body occlusion) more heavily than signal gains.
// 5. Log-Distance Path Loss: Converts filtered dBm to physical distance in meters.
// 6. Kinematic Slew-Rate Limiter: Restricts maximum displacement per tick to human walking speed (~1.6 m/s).
// 7. Stationary Hysteresis Dead-Zone: Locks distance output when micro-fluctuations occur at rest.
// ============================================================================

/** Number of initial packets required before locking initial distance estimate */
export const INITIAL_SAMPLE_SIZE = 3;

/** Rolling buffer size for median filtering (eliminates advertising channel-hopping spikes) */
export const MEDIAN_WINDOW = 5;

/** UI & state update interval in milliseconds (50ms = 20 FPS refresh rate) */
export const UI_UPDATE_INTERVAL_MS = 50;

/** Maximum allowed physical distance change (meters) per 50ms tick when stationary (~1.6 m/s max) */
export const STATIONARY_STEP_LIMIT = 0.08;

/** Maximum allowed physical distance change (meters) per 50ms tick during active movement */
export const MOVING_STEP_LIMIT = 0.15;

/** Hysteresis dead-band threshold (meters) to suppress numeric flickering at rest */
export const DEAD_ZONE = 0.15;

/** Speed reaction multiplier when distance is decreasing (approaching beacon) */
export const APPROACH_SENSITIVITY = 1.25;

/** Damping multiplier when distance is increasing (guards against human body shadowing dips) */
export const AWAY_SENSITIVITY = 1.05;

/** One-Euro baseline cutoff frequency (Hz). Lower = smoother at rest (eliminates stationary jitter) */
export const ONE_EURO_MIN_CUTOFF = 0.35;

/** One-Euro speed responsiveness factor (beta). Higher = faster response to sudden movements */
export const ONE_EURO_BETA = 0.06;

/** Default measured RSSI at exactly 1 meter distance (dBm) for calibration */
export const DEFAULT_TX_POWER = -59;

/** Default path loss exponent (n) for indoor multi-path environment (typically 2.0 to 2.8) */
export const DEFAULT_ENV_N = 2.2;
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

/**
 * Checks if native Bluetooth LE scanning is supported in the current runtime.
 */
export function isBleSupported() {
  return !!(
    BleManager &&
    (NativeModules.BleClientModule || NativeModules.BleClient || NativeModules.RNBLE)
  );
}

/**
 * Retrieves or lazily creates the singleton BleManager instance.
 */
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
// Reference: Casiez et al., "1€ Filter: A Simple Speed-based Low-pass Filter for Noisy Input"
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

/**
 * Adaptive One-Euro Filter
 * Dynamically adjusts cutoff frequency based on input signal rate of change (derivative).
 */
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
// Manages the complete signal filtering lifecycle for an individual BLE beacon.
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
    const ratio = (this.txPower - rssi) / (10 * Math.max(1.0, this.envN));
    return Math.pow(10, ratio);
  }

  addPacket(rawRssi, timestamp = Date.now()) {
    if (typeof rawRssi !== "number" || isNaN(rawRssi)) return;

    // Gated outlier rejection for impossible BLE RSSI values
    if (rawRssi < -105 || rawRssi > -15) return;

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
    // PHASE 2: Tracking Mode (Rolling Median + One-Euro Filter + Asymmetric EMA)
    // ------------------------------------------------------------------------
    this.rollingWindow.push(rawRssi);
    if (this.rollingWindow.length > MEDIAN_WINDOW) {
      this.rollingWindow.shift();
    }

    // 1. Median filter to eliminate single-packet spikes & channel-hopping jitter
    const sortedWindow = [...this.rollingWindow].sort((a, b) => a - b);
    const medianWindowRssi = sortedWindow[Math.floor(sortedWindow.length / 2)];

    // 2. Measure local variance to detect stationarity
    const mean = this.rollingWindow.reduce((acc, v) => acc + v, 0) / this.rollingWindow.length;
    const variance = this.rollingWindow.reduce((acc, v) => acc + (v - mean) ** 2, 0) / this.rollingWindow.length;
    const isQuiet = variance < 2.0; // stdDev < 1.4 dBm

    // 3. Adaptive One-Euro tuning based on trend & variance
    let beta = ONE_EURO_BETA;
    let minCutoff = ONE_EURO_MIN_CUTOFF;

    if (this.trend === "approaching") {
      beta *= APPROACH_SENSITIVITY;
      minCutoff *= 1.4;
    } else if (this.trend === "moving_away") {
      beta *= AWAY_SENSITIVITY;
      minCutoff *= 1.1;
    } else if (isQuiet) {
      // Stationary: clamp low cutoff for zero jitter
      minCutoff = 0.20;
    }

    const oneEuroVal = this.oneEuro.filter(medianWindowRssi, timestamp, beta, minCutoff);

    // 4. Asymmetric blending in dBm domain
    // (Body occlusion causes artificial RSSI drops; filter drops more heavily than signal increases)
    if (this.filteredRssi === null) {
      this.filteredRssi = oneEuroVal;
    } else {
      const alpha = oneEuroVal > this.filteredRssi ? 0.35 : 0.20;
      this.filteredRssi = alpha * oneEuroVal + (1.0 - alpha) * this.filteredRssi;
    }

    this.targetDistance = this.rssiToDistance(this.filteredRssi);

    // Update movement trend
    this.updateTrend(this.targetDistance);
  }

  updateTrend(newTargetDist) {
    if (newTargetDist === null) return;
    this.recentDistances.push(newTargetDist);
    if (this.recentDistances.length > 5) {
      this.recentDistances.shift();
    }

    if (this.recentDistances.length < 2) {
      this.trend = "stationary";
      return;
    }

    const first = this.recentDistances[0];
    const last = this.recentDistances[this.recentDistances.length - 1];
    const diff = last - first;

    if (diff < -0.25) {
      this.trend = "approaching";
    } else if (diff > 0.30) {
      this.trend = "moving_away";
    } else {
      this.trend = "stationary";
    }
  }

  // --------------------------------------------------------------------------
  // Kinematic Rate Limiter & Hysteresis Dead Zone Step (Smooth & Continuous)
  // --------------------------------------------------------------------------
  stepDistance() {
    if (this.targetDistance === null) return null;
    if (this.currentDistance === null) {
      this.currentDistance = this.targetDistance;
      return Number(this.currentDistance.toFixed(2));
    }

    const diff = this.targetDistance - this.currentDistance;
    const absDiff = Math.abs(diff);

    // Dead Zone Hysteresis: ignore microscopic noise jitter when stationary
    if (this.trend === "stationary" && absDiff < DEAD_ZONE) {
      return Number(this.currentDistance.toFixed(2));
    }

    // Adaptive step limit (kinematic walking speed limit)
    let stepLimit;
    if (this.trend === "approaching") {
      stepLimit = MOVING_STEP_LIMIT * APPROACH_SENSITIVITY;
    } else if (this.trend === "moving_away") {
      stepLimit = MOVING_STEP_LIMIT * AWAY_SENSITIVITY;
    } else {
      stepLimit = STATIONARY_STEP_LIMIT;
    }

    // Smooth proportional easing with kinematic ceiling
    const dynamicStep = Math.min(stepLimit, Math.max(0.02, absDiff * 0.30));
    const step = Math.sign(diff) * Math.min(absDiff, dynamicStep);
    this.currentDistance += step;

    const roundedDist = Number(this.currentDistance.toFixed(2));
    
    // Maintain distance history for live chart (last 20 points)
    if (!this.distanceHistory) this.distanceHistory = [];
    this.distanceHistory.push(roundedDist);
    if (this.distanceHistory.length > 20) {
      this.distanceHistory.shift();
    }

    return roundedDist;
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
      lastSeen: this.lastPacketTime,
      distanceHistory: this.distanceHistory || []
    };
  }

  reset() {
    this.initialSamples = [];
    this.rollingWindow = [];
    this.recentDistances = [];
    this.distanceHistory = [];
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
