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
  // Check if NativeModules has BleClientModule linked
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

/**
 * Calculates estimated physical distance (in meters) from RSSI
 * using the Log-Distance Path Loss Model:
 * Distance = 10 ^ ((MeasuredPower - RSSI) / (10 * n))
 *
 * @param {number} rssi - Received Signal Strength Indication (dBm)
 * @param {number} measuredPower - Expected RSSI at 1 meter distance (default: -59 dBm)
 * @param {number} pathLossExponent - Environmental path loss exponent (default: 2.2 for indoor)
 * @returns {number|null} estimated distance in meters rounded to 2 decimal places
 */
export function calculateDistance(rssi, measuredPower = -59, pathLossExponent = 2.2) {
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
