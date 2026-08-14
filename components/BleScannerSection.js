import React, { useEffect, useState, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Alert,
  Switch
} from "react-native";
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
  STATIONARY_STEP_LIMIT,
  MOVING_STEP_LIMIT,
  DEAD_ZONE,
  APPROACH_SENSITIVITY,
  AWAY_SENSITIVITY,
  ONE_EURO_MIN_CUTOFF,
  ONE_EURO_BETA
} from "../services/BleScannerService.js";

export default function BleScannerSection() {
  const [isScanning, setIsScanning] = useState(false);
  const [devices, setDevices] = useState({});
  const [bluetoothStatus, setBluetoothStatus] = useState("Unknown");
  const [filterNamedOnly, setFilterNamedOnly] = useState(false);
  const [environmentalN, setEnvironmentalN] = useState(DEFAULT_ENV_N);
  const [txPower1m, setTxPower1m] = useState(DEFAULT_TX_POWER);
  const [isExpoGoNotice, setIsExpoGoNotice] = useState(false);

  const isScanningRef = useRef(false);
  const simIntervalRef = useRef(null);
  const managerRef = useRef(null);

  // Per-device filter state machines (independent from React render cycles)
  const trackersRef = useRef(new Map());
  const deviceMetaRef = useRef(new Map());

  // Keep tracker parameters updated if txPower or environmentalN changes
  useEffect(() => {
    trackersRef.current.forEach((tracker) => {
      tracker.updateParams(txPower1m, environmentalN);
    });
  }, [txPower1m, environmentalN]);

  // --------------------------------------------------------------------------
  // Independent UI Rendering Loop (UI_UPDATE_INTERVAL_MS = 100ms)
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
        if (state === "PoweredOff" && isScanningRef.current) {
          stopScan();
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
  }, []);

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
  // Start BLE Scan (Hardware scanning or Expo Go simulation stream)
  // --------------------------------------------------------------------------
  const startScan = async () => {
    try {
      const mgr = managerRef.current;

      // In Expo Go without custom native dev build, run realistic simulation stream
      if (!mgr) {
        setIsScanning(true);
        isScanningRef.current = true;

        const simulatedNodes = [
          { id: "BLE:Beacon:North-101", name: "Indoor Beacon North", baseRssi: -56, velocity: -0.15 },
          { id: "BLE:Beacon:Gateway-A", name: "Hallway Gateway BLE", baseRssi: -72, velocity: 0.20 },
          { id: "BLE:Beacon:Entrance", name: "Entrance Node", baseRssi: -84, velocity: 0.0 },
          { id: "C4:D3:5B:89:12:FA", name: "Smart Tag BLE", baseRssi: -65, velocity: -0.25 },
        ];

        let simTick = 0;
        simIntervalRef.current = setInterval(() => {
          simTick++;
          simNodesStream(simulatedNodes, simTick);
        }, 150);

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

      const isEnabled = await ensureBluetoothEnabled();
      if (!isEnabled) return;

      setIsScanning(true);
      isScanningRef.current = true;

      // Start continuous scanning with duplicate packets allowed for high-frequency RSSI stream
      mgr.startDeviceScan(
        null,
        { allowDuplicates: true },
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

  // Simulation packet generator for Expo Go
  const simNodesStream = (nodes, tick) => {
    nodes.forEach((node) => {
      // Simulate real RF multipath noise (+/- 2 dBm) around dynamic movement
      const noise = (Math.sin(tick * 0.4 + node.baseRssi) * 2) + ((Math.random() - 0.5) * 1.5);
      const dynamicRssi = Math.round(node.baseRssi + (Math.sin(tick * 0.08) * 10 * Math.sign(node.velocity || 1)) + noise);
      const clampedRssi = Math.min(-42, Math.max(-98, dynamicRssi));

      processIncomingPacket(node.id, node.name, clampedRssi, {
        txPowerLevel: -59,
        isConnectable: true,
      });
    });
  };

  const stopScan = () => {
    if (simIntervalRef.current) {
      clearInterval(simIntervalRef.current);
      simIntervalRef.current = null;
    }
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
  };

  // Convert device dictionary to sorted list (closest / strongest first)
  const deviceList = Object.values(devices)
    .filter((d) => !filterNamedOnly || (d.name && d.name.trim().length > 0))
    .sort((a, b) => {
      if (a.distance === null) return 1;
      if (b.distance === null) return -1;
      return a.distance - b.distance;
    });

  return (
    <View style={s.card}>
      {/* Header */}
      <View style={s.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={s.sectionTitle}>Fast & Smooth BLE Distance</Text>
          <Text style={s.subText}>
            Bluetooth: <Text style={{ fontWeight: "700", color: bluetoothStatus === "PoweredOn" ? "#1a7f37" : "#cf222e" }}>{bluetoothStatus}</Text>
          </Text>
        </View>
        {isScanning && (
          <View style={s.scanningBadge}>
            <ActivityIndicator size="small" color="#1f6feb" />
            <Text style={s.scanningText}>Live Tracking</Text>
          </View>
        )}
      </View>

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
          <Text style={s.paramText}>Lock: {INITIAL_SAMPLE_SIZE} pkts | 1€-Filter | 100ms UI</Text>
        </View>
      </View>

      {/* Device Count Summary */}
      <View style={s.summaryBar}>
        <Text style={s.summaryText}>
          Tracking: <Text style={{ fontWeight: "800", color: "#24292f" }}>{deviceList.length}</Text> BLE device{deviceList.length === 1 ? "" : "s"}
        </Text>
        <Text style={s.summaryHint}>Sorted by Proximity (Nearest first)</Text>
      </View>

      {/* Device Cards List */}
      {deviceList.length === 0 ? (
        <View style={s.emptyBox}>
          <Text style={s.emptyTitle}>
            {isScanning ? "Waiting for initial BLE packets..." : "Scanner is currently idle"}
          </Text>
          <Text style={s.emptySub}>
            {isScanning
              ? `Fast Lock will calculate initial distance on the first ${INITIAL_SAMPLE_SIZE} RSSI samples.`
              : "Tap 'Start BLE Scan' above to begin low-latency filtered distance tracking."}
          </Text>
        </View>
      ) : (
        <ScrollView style={s.deviceScroll} nestedScrollEnabled>
          {deviceList.map((device) => {
            const rawRssi = device.rawRssi || device.filteredRssi || -100;
            const quality = getSignalQuality(rawRssi);
            const isNamed = !!device.name;

            // Movement trend style helper
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
                    {device.isLocked ? (
                      <View style={s.lockedBadge}>
                        <Text style={s.lockedText}>⚡ Fast Locked</Text>
                      </View>
                    ) : (
                      <View style={s.lockingBadge}>
                        <Text style={s.lockingText}>
                          Locking ({device.sampleCount || 0}/{INITIAL_SAMPLE_SIZE})
                        </Text>
                      </View>
                    )}

                    <View style={[s.trendBadge, { backgroundColor: trendBg, borderColor: trendColor }]}>
                      <Text style={[s.trendText, { color: trendColor }]}>
                        {trendIcon} {trendLabel}
                      </Text>
                    </View>
                  </View>
                </View>

                {/* Primary Metric Hero: Smooth Distance */}
                <View style={s.heroMetricBox}>
                  <View style={s.heroLeft}>
                    <Text style={s.heroLabel}>ESTIMATED DISTANCE</Text>
                    <Text style={s.heroValue}>
                      {device.distance !== null ? `${device.distance}` : "--"}
                      <Text style={s.heroUnit}> meters</Text>
                    </Text>
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

                {/* Footer Info */}
                <View style={s.deviceFooter}>
                  <Text style={s.footerText}>
                    Last packet: {Math.max(0, Math.round((Date.now() - (device.lastSeen || Date.now())) / 1000))}s ago
                  </Text>
                  {device.targetDistance !== null && (
                    <Text style={s.footerText}>
                      Target: ~{device.targetDistance}m • {quality.label}
                    </Text>
                  )}
                </View>
              </View>
            );
          })}
        </ScrollView>
      )}
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
    alignItems: "flex-start",
    marginBottom: 10,
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
    backgroundColor: "#ddf4ff",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
  },
  scanningText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#0969da",
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
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#e1e4e8",
  },
  paramText: {
    fontSize: 10,
    color: "#57606a",
    fontFamily: "monospace",
    fontWeight: "600",
  },
  summaryBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  summaryText: {
    fontSize: 12,
    color: "#57606a",
  },
  summaryHint: {
    fontSize: 11,
    color: "#8c959f",
    fontStyle: "italic",
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
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
  },
  trendText: {
    fontSize: 10,
    fontWeight: "700",
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
});
