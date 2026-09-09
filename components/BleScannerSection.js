import React, { useEffect, useState, useRef, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Alert,
  Switch,
  Dimensions,
  Platform,
  Linking,
} from "react-native";
import Svg, { Polyline, Circle, Line } from "react-native-svg";
import {
  getBleManager,
  getSignalQuality,
  requestBluetoothPermissions,
  ensureBluetoothEnabled,
  DeviceDistanceTracker,
  UI_UPDATE_INTERVAL_MS,
  INITIAL_SAMPLE_SIZE,
  DEFAULT_TX_POWER,
  DEFAULT_ENV_N,
  convertMeters,
  formatDistance,
  getDistanceConversions,
} from "../services/BleScannerService.js";
import { getAppSettings, subscribeAppSettings } from "../services/appSettingsStorage.js";
import BleDistanceRssiTestPanel from "./BleDistanceRssiTestPanel.js";

export default function BleScannerSection() {
  const initialSettings = getAppSettings();
  const [isScanning, setIsScanning] = useState(false);
  const [devices, setDevices] = useState({});
  const [bluetoothStatus, setBluetoothStatus] = useState("Unknown");
  const [filterNamedOnly, setFilterNamedOnly] = useState(false);
  const [environmentalN, setEnvironmentalN] = useState(initialSettings.pathLossN || DEFAULT_ENV_N);
  const [txPower1m, setTxPower1m] = useState(initialSettings.txPower || DEFAULT_TX_POWER);
  const [isExpoGoNotice, setIsExpoGoNotice] = useState(false);

  // Unit of distance measurement: 'm' (meters), 'ft' (feet), or 'in' (inches)
  const [distanceUnit, setDistanceUnit] = useState(initialSettings.distanceUnit || "m");

  // Single Focused Device for Dedicated Testing
  const [focusedDeviceId, setFocusedDeviceId] = useState(null);

  const isScanningRef = useRef(false);
  const simIntervalRef = useRef(null);
  const managerRef = useRef(null);

  // Per-device filter state machines (independent from React render cycles)
  const trackersRef = useRef(new Map());
  const deviceMetaRef = useRef(new Map());

  // Listen to in-app settings changes live
  useEffect(() => {
    const unsub = subscribeAppSettings((newCfg) => {
      if (newCfg.txPower) setTxPower1m(newCfg.txPower);
      if (newCfg.pathLossN) setEnvironmentalN(newCfg.pathLossN);
      if (newCfg.distanceUnit) setDistanceUnit(newCfg.distanceUnit);
    });
    return () => unsub();
  }, []);

  // Keep tracker parameters updated if txPower or environmentalN changes
  useEffect(() => {
    trackersRef.current.forEach((tracker) => {
      tracker.updateParams(txPower1m, environmentalN);
    });
  }, [txPower1m, environmentalN]);

  // --------------------------------------------------------------------------
  // Independent UI Rendering Loop (UI_UPDATE_INTERVAL_MS = 50ms)
  // --------------------------------------------------------------------------
  useEffect(() => {
    const uiInterval = setInterval(() => {
      if (trackersRef.current.size === 0) return;

      const updated = {};
      trackersRef.current.forEach((tracker, id) => {
        // Step distance through adaptive rate limiter
        tracker.stepDistance();
        const trackerState = tracker.getState();
        const meta = deviceMetaRef.current.get(id) || {};

        updated[id] = {
          ...meta,
          ...trackerState,
        };
      });

      setDevices(updated);
    }, UI_UPDATE_INTERVAL_MS);

    return () => clearInterval(uiInterval);
  }, []);

  // --------------------------------------------------------------------------
  const hasPromptedOffRef = useRef(false);

  // --------------------------------------------------------------------------
  // Bluetooth Turn On Popup Dialog
  // --------------------------------------------------------------------------
  const promptTurnOnBluetooth = useCallback(() => {
    const mgr = managerRef.current;
    Alert.alert(
      "Bluetooth is Turned Off",
      "Bluetooth is required to scan for nearby BLE beacons and estimate distance. Would you like to turn it on now?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Turn On",
          onPress: async () => {
            try {
              if (Platform.OS === "android" && mgr && mgr.enable) {
                await mgr.enable();
              } else {
                Linking.openSettings();
              }
            } catch (e) {
              Linking.openSettings();
            }
          },
        },
      ]
    );
  }, []);

  // --------------------------------------------------------------------------
  // BLE Manager Setup & State Listener
  // --------------------------------------------------------------------------
  useEffect(() => {
    const mgr = getBleManager();
    managerRef.current = mgr;

    if (!mgr) {
      setIsExpoGoNotice(true);
      setBluetoothStatus("Expo Go (Simulated / Standby)");
      return;
    }

    let subscription;
    try {
      subscription = mgr.onStateChange((state) => {
        setBluetoothStatus(state);
        if (state === "PoweredOff") {
          if (isScanningRef.current) {
            stopScan();
          }
          if (!hasPromptedOffRef.current) {
            hasPromptedOffRef.current = true;
            promptTurnOnBluetooth();
          }
        } else if (state === "PoweredOn") {
          hasPromptedOffRef.current = false;
        }
      }, true);
    } catch (e) {
      console.warn("Could not register onStateChange listener:", e);
    }

    return () => {
      subscription?.remove?.();
      if (isScanningRef.current) {
        try {
          mgr.stopDeviceScan();
        } catch (e) {}
      }
      if (simIntervalRef.current) {
        clearInterval(simIntervalRef.current);
      }
    };
  }, [promptTurnOnBluetooth]);

  const handleToggleScan = async () => {
    if (isScanning) {
      stopScan();
    } else {
      await startScan();
    }
  };

  // Helper to ingest a BLE packet for a device
  const processIncomingPacket = (id, name, rawRssi, extraMeta = {}) => {
    let tracker = trackersRef.current.get(id);
    if (!tracker) {
      tracker = new DeviceDistanceTracker(id, txPower1m, environmentalN);
      trackersRef.current.set(id, tracker);
    }

    tracker.addPacket(rawRssi);

    deviceMetaRef.current.set(id, {
      id,
      name: name || deviceMetaRef.current.get(id)?.name || null,
      txPowerLevel: extraMeta.txPowerLevel,
      isConnectable: extraMeta.isConnectable,
      ...extraMeta,
    });
  };

  // --------------------------------------------------------------------------
  // Start BLE Scan (Hardware scanning)
  // --------------------------------------------------------------------------
  const startScan = async () => {
    try {
      const mgr = managerRef.current;
      if (!mgr) {
        Alert.alert(
          "BLE Native Module Required",
          "Native Bluetooth scanning requires a development build (EAS build) with react-native-ble-plx. Please run on a native Android build."
        );
        return;
      }

      const hasPermission = await requestBluetoothPermissions();
      if (!hasPermission) {
        Alert.alert(
          "Permission Required",
          "Bluetooth and Location permissions are required to detect nearby BLE beacons and estimate distance."
        );
        return;
      }

      if (bluetoothStatus === "PoweredOff") {
        promptTurnOnBluetooth();
        return;
      }

      const isEnabled = await ensureBluetoothEnabled();
      if (!isEnabled) return;

      setIsScanning(true);
      isScanningRef.current = true;

      // Start continuous scanning with duplicate packets allowed and LowLatency mode (scanMode: 2)
      mgr.startDeviceScan(
        null,
        { allowDuplicates: true, scanMode: 2 },
        (error, scannedDevice) => {
          if (error) {
            console.warn("BLE Scan Error:", error);
            stopScan();
            return;
          }

          if (scannedDevice && scannedDevice.rssi !== null && scannedDevice.rssi !== undefined) {
            processIncomingPacket(
              scannedDevice.id,
              scannedDevice.name || scannedDevice.localName,
              scannedDevice.rssi,
              {
                txPowerLevel: scannedDevice.txPowerLevel,
                isConnectable: scannedDevice.isConnectable,
              }
            );
          }
        }
      );
    } catch (err) {
      console.error("Start Scan Exception:", err);
      Alert.alert("Scan Error", err.message || "Failed to start BLE scanning.");
      stopScan();
    }
  };

  const stopScan = () => {
    const mgr = managerRef.current;
    if (mgr) {
      try {
        mgr.stopDeviceScan();
      } catch (e) {
        console.warn("Error stopping BLE scan:", e);
      }
    }
    setIsScanning(false);
    isScanningRef.current = false;
  };

  const handleClearDevices = () => {
    trackersRef.current.clear();
    deviceMetaRef.current.clear();
    setDevices({});
    setFocusedDeviceId(null);
  };

  const handleResetFocusedFilter = () => {
    if (!focusedDeviceId) return;
    const tracker = trackersRef.current.get(focusedDeviceId);
    if (tracker) {
      tracker.reset();
    }
  };



  // Convert device dictionary to sorted list (closest / strongest first)
  const deviceList = Object.values(devices)
    .filter((d) => !filterNamedOnly || (d.name && d.name.trim().length > 0))
    .sort((a, b) => {
      if (a.distance === null) return 1;
      if (b.distance === null) return -1;
      return a.distance - b.distance;
    });

  const focusedDevice = focusedDeviceId ? (devices[focusedDeviceId] || deviceMetaRef.current.get(focusedDeviceId)) : null;

  return (
    <View style={s.card}>
      {/* Header */}
      <View style={s.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={s.sectionTitle}>
            {focusedDevice ? "🎯 Focused Target Testing" : "Fast & Smooth BLE Distance"}
          </Text>
          <Text style={s.subText}>
            Bluetooth: <Text style={{ fontWeight: "700", color: bluetoothStatus === "PoweredOn" ? "#1a7f37" : "#cf222e" }}>{bluetoothStatus}</Text> • 50ms Low-Latency
          </Text>
        </View>
        {isScanning && (
          <View style={s.scanningBadge}>
            <ActivityIndicator size="small" color="#1f6feb" />
            <Text style={s.scanningText}>Live 20 FPS</Text>
          </View>
        )}
      </View>

      {/* Bluetooth Turned Off Alert Banner */}
      {bluetoothStatus === "PoweredOff" && (
        <View style={s.btOffBanner}>
          <View style={{ flex: 1 }}>
            <Text style={s.btOffTitle}>⚠️ Bluetooth is Turned Off</Text>
            <Text style={s.btOffSub}>
              Enable Bluetooth to discover nearby BLE beacons and estimate distance.
            </Text>
          </View>
          <Pressable style={s.btOffBtn} onPress={promptTurnOnBluetooth}>
            <Text style={s.btOffBtnText}>Turn On</Text>
          </Pressable>
        </View>
      )}

      {/* Control Buttons */}
      <View style={s.btnRow}>
        <Pressable
          onPress={handleToggleScan}
          style={[s.mainBtn, isScanning ? s.btnStop : s.btnStart]}
        >
          <Text style={s.mainBtnText}>
            {isScanning ? "Stop BLE Scan" : "Start BLE Scan"}
          </Text>
        </Pressable>
        <Pressable
          onPress={handleClearDevices}
          style={s.secondaryBtn}
        >
          <Text style={s.secondaryBtnText}>Clear List</Text>
        </Pressable>
      </View>

      {/* ==================================================================== */}
      {/* VIEW MODE A: FOCUSED SINGLE DEVICE TESTING DASHBOARD */}
      {/* ==================================================================== */}
      {focusedDevice ? (
        <View style={s.focusedContainer}>
          {/* Back to All Devices Navigation Button */}
          <View style={s.focusedNavRow}>
            <Pressable
              onPress={() => setFocusedDeviceId(null)}
              style={s.backBtn}
            >
              <Text style={s.backBtnText}>⬅️ Back to All Devices</Text>
            </Pressable>
            <Pressable
              onPress={handleResetFocusedFilter}
              style={s.resetFilterBtn}
            >
              <Text style={s.resetFilterText}>🔄 Re-Lock Filter</Text>
            </Pressable>
          </View>

          {/* Focused Device Header */}
          <View style={s.focusedHeaderCard}>
            <View style={{ flex: 1 }}>
              <Text style={s.focusedName}>{focusedDevice.name || "Unnamed Target Beacon"}</Text>
              <Text style={s.focusedId}>UUID / MAC: {focusedDevice.id || focusedDeviceId}</Text>
            </View>
            <View style={s.focusedStatusGroup}>
              {focusedDevice.isLocked ? (
                <View style={s.lockedBadge}>
                  <Text style={s.lockedText}>⚡ Fast Locked</Text>
                </View>
              ) : (
                <View style={s.lockingBadge}>
                  <Text style={s.lockingText}>Locking ({focusedDevice.sampleCount || 0}/{INITIAL_SAMPLE_SIZE})</Text>
                </View>
              )}
            </View>
          </View>

          {/* Big Hero Distance Display with Multi-Unit Conversions */}
          <View style={s.focusedHeroBox}>
            <View style={s.heroTitleRow}>
              <Text style={s.focusedHeroTitle}>ESTIMATED PHYSICAL DISTANCE</Text>
              {/* Mini Unit Selector Button Group */}
              <View style={s.heroMiniToggle}>
                {[
                  { id: "m", label: "m" },
                  { id: "ft", label: "ft" },
                  { id: "in", label: "in" },
                ].map((u) => (
                  <Pressable
                    key={u.id}
                    onPress={() => setDistanceUnit(u.id)}
                    style={[s.miniToggleBtn, distanceUnit === u.id && s.miniToggleBtnActive]}
                  >
                    <Text style={[s.miniToggleText, distanceUnit === u.id && s.miniToggleTextActive]}>
                      {u.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>

            <View style={s.focusedDistanceRow}>
              <Text style={s.focusedDistanceNumber}>
                {formatDistance(focusedDevice.distance, distanceUnit).value}
              </Text>
              <Text style={s.focusedDistanceUnit}>
                {formatDistance(focusedDevice.distance, distanceUnit).label}
              </Text>
            </View>

            {/* Live All-Unit Conversion Strip (Simultaneous m, ft, in Readouts) */}
            {focusedDevice.distance !== undefined && focusedDevice.distance !== null && (
              <View style={s.allConversionStrip}>
                <Text style={s.allConversionTitle}>LIVE CONVERSIONS (TAP TO SELECT UNIT):</Text>
                <View style={s.allConversionPills}>
                  {/* Meters Pill */}
                  <Pressable
                    onPress={() => setDistanceUnit("m")}
                    style={[s.allConvPill, distanceUnit === "m" && s.allConvPillActive]}
                  >
                    <Text style={[s.allConvUnit, distanceUnit === "m" && s.allConvTextActive]}>Meters (m)</Text>
                    <Text style={[s.allConvVal, distanceUnit === "m" && s.allConvTextActive]}>
                      {focusedDevice.distance.toFixed(2)} m
                    </Text>
                  </Pressable>

                  {/* Feet Pill */}
                  <Pressable
                    onPress={() => setDistanceUnit("ft")}
                    style={[s.allConvPill, distanceUnit === "ft" && s.allConvPillActive]}
                  >
                    <Text style={[s.allConvUnit, distanceUnit === "ft" && s.allConvTextActive]}>Feet (ft)</Text>
                    <Text style={[s.allConvVal, distanceUnit === "ft" && s.allConvTextActive]}>
                      {(focusedDevice.distance * 3.28084).toFixed(2)} ft
                    </Text>
                  </Pressable>

                  {/* Inches Pill */}
                  <Pressable
                    onPress={() => setDistanceUnit("in")}
                    style={[s.allConvPill, distanceUnit === "in" && s.allConvPillActive]}
                  >
                    <Text style={[s.allConvUnit, distanceUnit === "in" && s.allConvTextActive]}>Inches (in)</Text>
                    <Text style={[s.allConvVal, distanceUnit === "in" && s.allConvTextActive]}>
                      {(focusedDevice.distance * 39.3701).toFixed(1)} in
                    </Text>
                  </Pressable>
                </View>
              </View>
            )}

            {/* Proximity Category Pill */}
            <View style={s.proximityPillRow}>
              {focusedDevice.distance !== undefined && focusedDevice.distance !== null && (
                <View style={[
                  s.proximityPill,
                  focusedDevice.distance < 1.5 ? s.pillClose : (focusedDevice.distance < 4.0 ? s.pillMedium : s.pillFar)
                ]}>
                  <Text style={s.proximityPillText}>
                    {focusedDevice.distance < 1.5
                      ? `📍 Immediate Proximity (< ${distanceUnit === "ft" ? "4.9 ft" : distanceUnit === "in" ? "59.1 in" : "1.5m"})`
                      : (focusedDevice.distance < 4.0
                          ? `🚶 Room Range (${distanceUnit === "ft" ? "4.9 - 13.1 ft" : distanceUnit === "in" ? "59.1 - 157.5 in" : "1.5 - 4.0m"})`
                          : `📡 Distant Beacon (> ${distanceUnit === "ft" ? "13.1 ft" : distanceUnit === "in" ? "157.5 in" : "4.0m"})`)}
                  </Text>
                </View>
              )}


              {/* Movement Trend Indicator */}
              <View style={[
                s.trendBadge,
                focusedDevice.trend === "approaching" ? s.trendApproaching : (focusedDevice.trend === "moving_away" ? s.trendAway : s.trendStationary)
              ]}>
                <Text style={s.trendText}>
                  {focusedDevice.trend === "approaching" ? "🟢 Approaching (Moving Closer)" : (focusedDevice.trend === "moving_away" ? "🟠 Moving Away" : "⚪ Stationary (Stable)")}
                </Text>
              </View>
            </View>
          </View>

          {/* Signal Metrics Dual Box */}
          <View style={s.signalMetricsRow}>
            <View style={s.signalMetricBox}>
              <Text style={s.signalMetricLabel}>1€ FILTERED RSSI</Text>
              <Text style={s.signalMetricVal}>{focusedDevice.filteredRssi !== undefined && focusedDevice.filteredRssi !== null ? `${focusedDevice.filteredRssi}` : "--"} <Text style={s.heroUnit}>dBm</Text></Text>
            </View>
            <View style={s.signalMetricBox}>
              <Text style={s.signalMetricLabel}>RAW PACKET RSSI</Text>
              <Text style={s.signalMetricVal}>{focusedDevice.rawRssi || "--"} <Text style={s.heroUnit}>dBm</Text></Text>
            </View>
            <View style={s.signalMetricBox}>
              <Text style={s.signalMetricLabel}>STREAM RATE</Text>
              <Text style={[s.signalMetricVal, { color: "#1a7f37" }]}>~20 FPS</Text>
            </View>
          </View>

          {/* Live Distance History Sparkline Graph */}
          {focusedDevice.distanceHistory && focusedDevice.distanceHistory.length > 1 && (
            <View style={s.sparklineCard}>
              <View style={s.sparklineHeader}>
                <Text style={s.sparklineTitle}>Live Distance Trail (Last 20 Points)</Text>
                <Text style={s.sparklineSub}>
                  Latest: {formatDistance(focusedDevice.distance, distanceUnit).value} {distanceUnit} • Target: {formatDistance(focusedDevice.targetDistance, distanceUnit).value} {distanceUnit}
                </Text>
              </View>
              <DistanceSparkline history={focusedDevice.distanceHistory} />
            </View>
          )}


          {/* Real-time Beacon Calibration Controls */}
          <View style={s.calibrationCard}>
            <Text style={s.calibrationTitle}>Real-time Beacon Calibration</Text>
            <View style={s.calibControlsRow}>
              {/* TxPower Adjuster */}
              <View style={s.calibItem}>
                <Text style={s.calibLabel}>TxPower@1m: {txPower1m} dBm</Text>
                <View style={s.plusMinusRow}>
                  <Pressable onPress={() => setTxPower1m(p => p - 1)} style={s.calibBtn}><Text style={s.calibBtnText}>-1</Text></Pressable>
                  <Pressable onPress={() => setTxPower1m(p => p + 1)} style={s.calibBtn}><Text style={s.calibBtnText}>+1</Text></Pressable>
                </View>
              </View>

              {/* Environmental N Adjuster */}
              <View style={s.calibItem}>
                <Text style={s.calibLabel}>Path Loss (n): {environmentalN.toFixed(1)}</Text>
                <View style={s.plusMinusRow}>
                  <Pressable onPress={() => setEnvironmentalN(n => Number(Math.max(1.5, n - 0.1).toFixed(1)))} style={s.calibBtn}><Text style={s.calibBtnText}>-0.1</Text></Pressable>
                  <Pressable onPress={() => setEnvironmentalN(n => Number(Math.min(4.0, n + 0.1).toFixed(1)))} style={s.calibBtn}><Text style={s.calibBtnText}>+0.1</Text></Pressable>
                </View>
              </View>
            </View>
          </View>

          {/* Distance vs RSSI Testing & Graph Suite */}
          <BleDistanceRssiTestPanel
            devices={devices}
            focusedDeviceId={focusedDeviceId}
            distanceUnit={distanceUnit}
            txPower1m={txPower1m}
            environmentalN={environmentalN}
          />
        </View>
      ) : (
        /* ==================================================================== */
        /* VIEW MODE B: ALL DISCOVERED DEVICES LIST */
        /* ==================================================================== */
        <>
          {/* Distance Unit Selector Toolbar */}
          <View style={s.unitToolbar}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text style={s.unitToolbarLabel}>📏 Choose Unit:</Text>
            </View>
            <View style={s.unitButtonGroup}>
              {[
                { id: "m", label: "Meters (m)" },
                { id: "ft", label: "Feet (ft)" },
                { id: "in", label: "Inches (in)" },
              ].map((item) => (
                <Pressable
                  key={item.id}
                  onPress={() => setDistanceUnit(item.id)}
                  style={[s.unitButton, distanceUnit === item.id && s.unitButtonActive]}
                >
                  <Text
                    style={[
                      s.unitButtonText,
                      distanceUnit === item.id && s.unitButtonTextActive,
                    ]}
                  >
                    {item.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          {/* Pipeline Config & Tuning Indicators */}
          <View style={s.filterRow}>
            <View style={s.switchItem}>
              <Text style={s.filterLabel}>Named Only</Text>
              <Switch
                value={filterNamedOnly}
                onValueChange={setFilterNamedOnly}
                trackColor={{ false: "#d0d7de", true: "#80ccff" }}
                thumbColor={filterNamedOnly ? "#1f6feb" : "#f6f8fa"}
              />
            </View>
            <View style={s.paramBadge}>
              <Text style={s.paramText}>Lock: {INITIAL_SAMPLE_SIZE} pkts | 1€-Filter | 50ms UI</Text>
            </View>
          </View>

          {/* Device Count Summary */}
          <View style={s.summaryBar}>
            <Text style={s.summaryText}>
              Tracking: <Text style={{ fontWeight: "800", color: "#24292f" }}>{deviceList.length}</Text> BLE device{deviceList.length === 1 ? "" : "s"}
            </Text>
            <Text style={s.summaryHint}>Tap "Focus" to isolate 1 device</Text>
          </View>

          {/* Device Cards List */}
          {deviceList.length === 0 ? (
            <View style={s.emptyBox}>
              <Text style={s.emptyTitle}>
                {isScanning ? "Scanning with LowLatency hardware mode..." : "Scanner is currently idle"}
              </Text>
              <Text style={s.emptySub}>
                {isScanning
                  ? "Instant lock will display physical distance on packet #1."
                  : "Tap 'Start BLE Scan' above to detect nearby beacons."}
              </Text>
            </View>
          ) : (
            <ScrollView style={s.deviceScroll} nestedScrollEnabled>
              {deviceList.map((device) => {
                const rawRssi = device.rawRssi || device.filteredRssi || -100;
                const quality = getSignalQuality(rawRssi);
                const isNamed = !!device.name;

                let trendLabel = "Stationary";
                let trendColor = "#57606a";
                let trendBg = "#f6f8fa";
                let trendIcon = "⚪";

                if (device.trend === "approaching") {
                  trendLabel = "Approaching";
                  trendColor = "#1a7f37";
                  trendBg = "#dafbe1";
                  trendIcon = "🟢";
                } else if (device.trend === "moving_away") {
                  trendLabel = "Moving Away";
                  trendColor = "#d29922";
                  trendBg = "#fff8c5";
                  trendIcon = "🟠";
                }

                return (
                  <View key={device.id} style={s.deviceCard}>
                    {/* Header: Name + Badges */}
                    <View style={s.deviceHeader}>
                      <View style={{ flex: 1, marginRight: 8 }}>
                        <Text style={[s.deviceName, !isNamed && s.unnamedDevice]}>
                          {device.name || "Unknown BLE Beacon"}
                        </Text>
                        <Text style={s.deviceId}>ID: {device.id}</Text>
                      </View>

                      <View style={{ alignItems: "flex-end", gap: 4 }}>
                        <View style={[s.trendBadge, { backgroundColor: trendBg, borderColor: trendColor }]}>
                          <Text style={[s.trendText, { color: trendColor }]}>
                            {trendIcon} {trendLabel}
                          </Text>
                        </View>
                      </View>
                    </View>

                    {/* Primary Metric Hero: Smooth Distance with Dynamic Unit & Conversions */}
                    <View style={s.heroMetricBox}>
                      <View style={s.heroLeft}>
                        <Text style={s.heroLabel}>ESTIMATED DISTANCE</Text>
                        <Text style={s.heroValue}>
                          {formatDistance(device.distance, distanceUnit).value}
                          <Text style={s.heroUnit}> {formatDistance(device.distance, distanceUnit).label}</Text>
                        </Text>
                        {device.distance !== null && (
                          <View style={s.deviceConversionsRow}>
                            {distanceUnit !== "m" && (
                              <Text style={s.deviceConversionSub}>• {device.distance.toFixed(2)}m </Text>
                            )}
                            {distanceUnit !== "ft" && (
                              <Text style={s.deviceConversionSub}>• {(device.distance * 3.28084).toFixed(2)}ft </Text>
                            )}
                            {distanceUnit !== "in" && (
                              <Text style={s.deviceConversionSub}>• {(device.distance * 39.3701).toFixed(1)}in</Text>
                            )}
                          </View>
                        )}
                      </View>

                      <View style={s.heroDivider} />

                      <View style={s.heroRight}>
                        <Text style={s.heroLabel}>SIGNAL (1€ FILTERED)</Text>
                        <Text style={[s.rssiValue, { color: quality.color }]}>
                          {device.filteredRssi !== null ? device.filteredRssi : rawRssi}{" "}
                          <Text style={s.heroUnit}>dBm</Text>
                        </Text>
                        <Text style={s.rawRssiSub}>Raw: {device.rawRssi || "--"} dBm</Text>
                      </View>
                    </View>

                    {/* Signal Bar */}
                    <View style={s.barContainer}>
                      <View
                        style={[
                          s.barFill,
                          {
                            width: `${quality.percentage}%`,
                            backgroundColor: quality.color
                          }
                        ]}
                      />
                    </View>

                    {/* Footer Row + Focus Test Button */}
                    <View style={s.deviceFooter}>
                      <Text style={s.footerText}>
                        Last packet: {Math.max(0, Math.round((Date.now() - (device.lastSeen || Date.now())) / 1000))}s ago
                      </Text>
                      <Pressable
                        onPress={() => setFocusedDeviceId(device.id)}
                        style={s.focusSelectBtn}
                      >
                        <Text style={s.focusSelectBtnText}>🎯 Focus & Test Device</Text>
                      </Pressable>
                    </View>
                  </View>
                );
              })}
            </ScrollView>
          )}

          {/* Distance vs RSSI Testing & Graph Suite */}
          <BleDistanceRssiTestPanel
            devices={devices}
            focusedDeviceId={null}
            distanceUnit={distanceUnit}
            txPower1m={txPower1m}
            environmentalN={environmentalN}
          />
        </>
      )}

    </View>
  );
}

// ----------------------------------------------------------------------------
// Live Distance Sparkline Mini Chart Component (Auto-Adjusted Width)
// ----------------------------------------------------------------------------
function DistanceSparkline({ history }) {
  if (!history || history.length < 2) return null;

  const [sparklineWidth, setSparklineWidth] = useState(0);
  const screenWidth = Dimensions.get("window").width;
  const width = sparklineWidth > 100 ? sparklineWidth : Math.max(200, Math.min(screenWidth - 72, 360));
  const height = 70;
  const pad = 8;

  const minVal = Math.max(0, Math.min(...history) - 0.3);
  const maxVal = Math.max(...history) + 0.5;
  const span = Math.max(1, maxVal - minVal);

  const stepX = (width - pad * 2) / (history.length - 1);
  const points = history.map((val, idx) => {
    const x = pad + idx * stepX;
    const y = height - pad - ((val - minVal) / span) * (height - pad * 2);
    return { x, y, val };
  });

  const polyPoints = points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const latestPt = points[points.length - 1];

  return (
    <View
      style={{ alignItems: "center", marginVertical: 4, width: "100%" }}
      onLayout={(e) => {
        const w = Math.round(e.nativeEvent.layout.width);
        if (w > 50 && Math.abs(w - sparklineWidth) > 3) setSparklineWidth(w);
      }}
    >
      <Svg width={width} height={height}>
        {/* Baseline grid */}
        <Line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} stroke="#e1e4e8" strokeDasharray="3,3" />
        <Line x1={pad} y1={pad} x2={width - pad} y2={pad} stroke="#e1e4e8" strokeDasharray="3,3" />

        {/* Trail Polyline */}
        <Polyline
          points={polyPoints}
          fill="none"
          stroke="#1f6feb"
          strokeWidth="3"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* Highlight latest point */}
        {latestPt && (
          <Circle cx={latestPt.x} cy={latestPt.y} r="5" fill="#1f6feb" stroke="#ffffff" strokeWidth="2" />
        )}
      </Svg>
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: "white",
    borderRadius: 14,
    padding: 14,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: "#d0d7de",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 2,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
    flexWrap: "wrap",
    gap: 8,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: "#24292f",
  },
  subText: {
    fontSize: 12,
    color: "#57606a",
    marginTop: 2,
  },
  scanningBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#dafbe1",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
  },
  scanningText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#1a7f37",
  },
  btnRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 10,
  },
  mainBtn: {
    flex: 2,
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  btnStart: {
    backgroundColor: "#1f6feb",
  },
  btnStop: {
    backgroundColor: "#cf222e",
  },
  mainBtnText: {
    color: "white",
    fontWeight: "700",
    fontSize: 14,
  },
  secondaryBtn: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#d0d7de",
    backgroundColor: "#f6f8fa",
  },
  secondaryBtnText: {
    color: "#57606a",
    fontWeight: "700",
    fontSize: 13,
  },
  filterRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 6,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: "#f0f2f5",
    marginBottom: 10,
    flexWrap: "wrap",
    gap: 8,
  },
  switchItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  filterLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#57606a",
  },
  paramBadge: {
    backgroundColor: "#f6f8fa",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#e1e4e8",
    flexShrink: 1,
  },
  paramText: {
    fontSize: 10,
    color: "#57606a",
    fontFamily: Platform.OS === "android" ? "monospace" : "Menlo",
    fontWeight: "600",
  },
  summaryBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
    flexWrap: "wrap",
    gap: 6,
  },
  summaryText: {
    fontSize: 12,
    color: "#57606a",
  },
  summaryHint: {
    fontSize: 11,
    color: "#0969da",
    fontWeight: "600",
  },
  emptyBox: {
    paddingVertical: 24,
    paddingHorizontal: 12,
    alignItems: "center",
    backgroundColor: "#f6f8fa",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#e1e4e8",
  },
  emptyTitle: {
    fontWeight: "700",
    fontSize: 14,
    color: "#24292f",
    marginBottom: 4,
    textAlign: "center",
  },
  emptySub: {
    fontSize: 12,
    color: "#57606a",
    textAlign: "center",
    lineHeight: 18,
  },
  deviceScroll: {
    maxHeight: 340,
  },
  deviceCard: {
    backgroundColor: "#ffffff",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#e1e4e8",
    padding: 12,
    marginBottom: 10,
    shadowColor: "#000",
    shadowOpacity: 0.03,
    shadowRadius: 4,
  },
  deviceHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 8,
  },
  deviceName: {
    fontSize: 14,
    fontWeight: "800",
    color: "#24292f",
  },
  unnamedDevice: {
    color: "#57606a",
    fontWeight: "600",
  },
  deviceId: {
    fontSize: 11,
    fontFamily: "monospace",
    color: "#8c959f",
    marginTop: 1,
  },
  lockedBadge: {
    backgroundColor: "#dafbe1",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#1a7f37",
  },
  lockedText: {
    fontSize: 10,
    fontWeight: "800",
    color: "#1a7f37",
  },
  lockingBadge: {
    backgroundColor: "#fff8c5",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#d29922",
  },
  lockingText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#9a6700",
  },
  trendBadge: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
  },
  trendText: {
    fontSize: 10,
    fontWeight: "700",
  },
  trendApproaching: {
    backgroundColor: "#dafbe1",
    borderColor: "#1a7f37",
  },
  trendAway: {
    backgroundColor: "#fff8c5",
    borderColor: "#d29922",
  },
  trendStationary: {
    backgroundColor: "#f6f8fa",
    borderColor: "#d0d7de",
  },
  heroMetricBox: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#f6f8fa",
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "#ebeef2",
  },
  heroLeft: {
    flex: 1.2,
  },
  heroRight: {
    flex: 1,
    alignItems: "flex-end",
  },
  heroDivider: {
    width: 1,
    height: 36,
    backgroundColor: "#d0d7de",
    marginHorizontal: 8,
  },
  heroLabel: {
    fontSize: 9,
    fontWeight: "700",
    color: "#57606a",
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  heroValue: {
    fontSize: 20,
    fontWeight: "900",
    color: "#1f6feb",
  },
  rssiValue: {
    fontSize: 15,
    fontWeight: "800",
  },
  rawRssiSub: {
    fontSize: 10,
    color: "#8c959f",
    marginTop: 1,
  },
  heroUnit: {
    fontSize: 11,
    fontWeight: "600",
    color: "#57606a",
  },
  barContainer: {
    height: 4,
    backgroundColor: "#eaeef2",
    borderRadius: 2,
    overflow: "hidden",
    marginBottom: 6,
  },
  barFill: {
    height: "100%",
    borderRadius: 2,
  },
  deviceFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  footerText: {
    fontSize: 10,
    color: "#8c959f",
  },
  focusSelectBtn: {
    backgroundColor: "#ddf4ff",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#54aeff",
  },
  focusSelectBtnText: {
    fontSize: 11,
    fontWeight: "800",
    color: "#0969da",
  },

  // Focused Mode Specific Styles
  focusedContainer: {
    marginTop: 4,
  },
  focusedNavRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  backBtn: {
    backgroundColor: "#f6f8fa",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#d0d7de",
  },
  backBtnText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#1f6feb",
  },
  resetFilterBtn: {
    backgroundColor: "#fff8c5",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#d29922",
  },
  resetFilterText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#9a6700",
  },
  focusedHeaderCard: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: "#f6f8fa",
    padding: 10,
    borderRadius: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#e1e4e8",
  },
  focusedName: {
    fontSize: 15,
    fontWeight: "800",
    color: "#24292f",
  },
  focusedId: {
    fontSize: 10,
    fontFamily: "monospace",
    color: "#8c959f",
    marginTop: 2,
  },
  focusedStatusGroup: {
    alignItems: "flex-end",
  },
  focusedHeroBox: {
    backgroundColor: "#ffffff",
    borderRadius: 14,
    borderWidth: 2,
    borderColor: "#1f6feb",
    padding: 16,
    alignItems: "center",
    marginBottom: 10,
    shadowColor: "#1f6feb",
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
  },
  focusedHeroTitle: {
    fontSize: 10,
    fontWeight: "800",
    color: "#57606a",
    letterSpacing: 1,
    marginBottom: 6,
  },
  focusedDistanceRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 6,
    marginVertical: 4,
  },
  focusedDistanceNumber: {
    fontSize: 44,
    fontWeight: "900",
    color: "#1f6feb",
    fontVariant: ["tabular-nums"],
  },
  focusedDistanceUnit: {
    fontSize: 18,
    fontWeight: "700",
    color: "#57606a",
  },
  proximityPillRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 8,
    flexWrap: "wrap",
    justifyContent: "center",
  },
  proximityPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
  },
  pillClose: {
    backgroundColor: "#dafbe1",
    borderColor: "#1a7f37",
  },
  pillMedium: {
    backgroundColor: "#ddf4ff",
    borderColor: "#0969da",
  },
  pillFar: {
    backgroundColor: "#fff8c5",
    borderColor: "#d29922",
  },
  proximityPillText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#24292f",
  },
  signalMetricsRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 10,
  },
  signalMetricBox: {
    flex: 1,
    backgroundColor: "#f6f8fa",
    padding: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#e1e4e8",
    alignItems: "center",
  },
  signalMetricLabel: {
    fontSize: 9,
    fontWeight: "700",
    color: "#57606a",
    marginBottom: 2,
  },
  signalMetricVal: {
    fontSize: 14,
    fontWeight: "800",
    color: "#24292f",
  },
  sparklineCard: {
    backgroundColor: "#f6f8fa",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#e1e4e8",
    padding: 10,
    marginBottom: 10,
  },
  sparklineHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  sparklineTitle: {
    fontSize: 11,
    fontWeight: "700",
    color: "#24292f",
  },
  sparklineSub: {
    fontSize: 10,
    color: "#57606a",
  },
  calibrationCard: {
    backgroundColor: "#ffffff",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#e1e4e8",
    padding: 10,
    marginBottom: 6,
  },
  calibrationTitle: {
    fontSize: 12,
    fontWeight: "800",
    color: "#24292f",
    marginBottom: 6,
  },
  calibControlsRow: {
    flexDirection: "row",
    gap: 8,
  },
  calibItem: {
    flex: 1,
    backgroundColor: "#f6f8fa",
    padding: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#ebeef2",
  },
  calibLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: "#57606a",
    marginBottom: 4,
  },
  plusMinusRow: {
    flexDirection: "row",
    gap: 6,
  },
  calibBtn: {
    flex: 1,
    backgroundColor: "#ffffff",
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#d0d7de",
    alignItems: "center",
  },
  btOffBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff1f0",
    borderWidth: 1,
    borderColor: "#ffa39e",
    borderRadius: 10,
    padding: 10,
    marginBottom: 10,
    gap: 8,
  },
  btOffTitle: {
    fontSize: 12,
    fontWeight: "800",
    color: "#cf1322",
  },
  btOffSub: {
    fontSize: 10,
    color: "#820014",
    marginTop: 2,
    lineHeight: 14,
  },
  btOffBtn: {
    backgroundColor: "#cf1322",
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
  },
  btOffBtnText: {
    color: "#ffffff",
    fontSize: 11,
    fontWeight: "800",
  },

  // Distance Unit Toolbar & Buttons
  unitToolbar: {
    backgroundColor: "#f6f8fa",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#e1e4e8",
    paddingVertical: 8,
    paddingHorizontal: 10,
    marginBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 6,
  },
  unitToolbarLabel: {
    fontSize: 12,
    fontWeight: "800",
    color: "#24292f",
  },
  unitButtonGroup: {
    flexDirection: "row",
    gap: 5,
    flexWrap: "wrap",
  },
  unitButton: {
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: "#d0d7de",
    backgroundColor: "#ffffff",
  },
  unitButtonActive: {
    backgroundColor: "#1f6feb",
    borderColor: "#1f6feb",
  },
  unitButtonText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#57606a",
  },
  unitButtonTextActive: {
    color: "#ffffff",
  },

  // Focused Hero Header & Mini Toggle
  heroTitleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    width: "100%",
    marginBottom: 4,
  },
  heroMiniToggle: {
    flexDirection: "row",
    gap: 3,
    backgroundColor: "#f6f8fa",
    padding: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#d0d7de",
  },
  miniToggleBtn: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 4,
  },
  miniToggleBtnActive: {
    backgroundColor: "#1f6feb",
  },
  miniToggleText: {
    fontSize: 10,
    fontWeight: "800",
    color: "#57606a",
  },
  miniToggleTextActive: {
    color: "#ffffff",
  },

  // All-Unit Live Conversion Strip
  allConversionStrip: {
    width: "100%",
    backgroundColor: "#f6f8fa",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#e1e4e8",
    padding: 8,
    marginTop: 6,
    marginBottom: 6,
  },
  allConversionTitle: {
    fontSize: 9,
    fontWeight: "800",
    color: "#57606a",
    letterSpacing: 0.5,
    marginBottom: 6,
    textAlign: "center",
  },
  allConversionPills: {
    flexDirection: "row",
    gap: 6,
    justifyContent: "space-between",
  },
  allConvPill: {
    flex: 1,
    backgroundColor: "#ffffff",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#d0d7de",
    paddingVertical: 6,
    paddingHorizontal: 4,
    alignItems: "center",
  },
  allConvPillActive: {
    backgroundColor: "#ddf4ff",
    borderColor: "#1f6feb",
    borderWidth: 1.5,
  },
  allConvUnit: {
    fontSize: 9,
    color: "#57606a",
    fontWeight: "700",
  },
  allConvVal: {
    fontSize: 12,
    fontWeight: "900",
    color: "#24292f",
    marginTop: 2,
  },
  allConvTextActive: {
    color: "#0969da",
    fontWeight: "800",
  },

  // Device card conversion subtext
  deviceConversionsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginTop: 4,
    gap: 4,
  },
  deviceConversionSub: {
    fontSize: 10,
    color: "#0969da",
    fontWeight: "700",
    backgroundColor: "#f0f8ff",
    borderWidth: 1,
    borderColor: "#d0e8ff",
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
});

