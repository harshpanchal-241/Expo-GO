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
  calculateDistance,
  getSignalQuality,
  requestBluetoothPermissions,
  ensureBluetoothEnabled,
  isBleSupported
} from "../services/BleScannerService.js";

export default function BleScannerSection() {
  const [isScanning, setIsScanning] = useState(false);
  const [devices, setDevices] = useState({});
  const [bluetoothStatus, setBluetoothStatus] = useState("Unknown");
  const [filterNamedOnly, setFilterNamedOnly] = useState(false);
  const [environmentalN, setEnvironmentalN] = useState(2.2); // Indoor exponent
  const [txPower1m, setTxPower1m] = useState(-59); // RSSI at 1 meter
  const [isExpoGoNotice, setIsExpoGoNotice] = useState(false);
  
  const isScanningRef = useRef(false);
  const simIntervalRef = useRef(null);
  const managerRef = useRef(null);

  useEffect(() => {
    const mgr = getBleManager();
    managerRef.current = mgr;

    if (!mgr) {
      setIsExpoGoNotice(true);
      setBluetoothStatus("Expo Go (Simulated / Standby)");
      return;
    }

    // Monitor Bluetooth Adapter State
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

  const startScan = async () => {
    try {
      const mgr = managerRef.current;

      // If in Expo Go where react-native-ble-plx native module isn't linked, run simulation demo beacons
      if (!mgr) {
        setIsScanning(true);
        isScanningRef.current = true;
        
        // Populate initial simulated BLE beacons
        const initialBeacons = [
          { id: "BLE:Beacon:Room-101", name: "Indoor Beacon North", baseRssi: -58 },
          { id: "BLE:Beacon:Hallway-A", name: "Hallway Gateway BLE", baseRssi: -71 },
          { id: "BLE:Beacon:Entrance", name: "Entrance Node", baseRssi: -84 },
          { id: "FE:4C:29:88:1A:05", name: null, baseRssi: -90 }
        ];

        simIntervalRef.current = setInterval(() => {
          setDevices((prev) => {
            const updated = { ...prev };
            const now = Date.now();

            initialBeacons.forEach((b) => {
              // Add slight random fluctuation (+/- 3 dBm) to simulate physical movement
              const jitter = Math.floor(Math.random() * 5) - 2;
              const currentRssi = Math.min(-40, Math.max(-98, b.baseRssi + jitter));
              const existing = updated[b.id];
              const smoothedRssi = existing
                ? Math.round(existing.rssi * 0.4 + currentRssi * 0.6)
                : currentRssi;
              const smoothedDist = calculateDistance(smoothedRssi, txPower1m, environmentalN);

              updated[b.id] = {
                id: b.id,
                name: b.name,
                rssi: smoothedRssi,
                distance: smoothedDist,
                txPowerLevel: -59,
                isConnectable: true,
                lastSeen: now,
              };
            });
            return updated;
          });
        }, 1200);
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

      // Start device scan with allowDuplicates true to get real-time continuous RSSI updates
      mgr.startDeviceScan(
        null,
        { allowDuplicates: true },
        (error, scannedDevice) => {
          if (error) {
            console.warn("BLE Scan Error:", error);
            stopScan();
            return;
          }

          if (scannedDevice) {
            const now = Date.now();
            const currentRssi = scannedDevice.rssi || -100;

            setDevices((prev) => {
              const existing = prev[scannedDevice.id];
              // Apply exponential smoothing to RSSI if device was already seen to prevent jitter
              const smoothedRssi = existing
                ? Math.round(existing.rssi * 0.4 + currentRssi * 0.6)
                : currentRssi;

              const smoothedDist = calculateDistance(smoothedRssi, txPower1m, environmentalN);

              return {
                ...prev,
                [scannedDevice.id]: {
                  id: scannedDevice.id,
                  name: scannedDevice.name || scannedDevice.localName || null,
                  rssi: smoothedRssi,
                  distance: smoothedDist,
                  txPowerLevel: scannedDevice.txPowerLevel,
                  isConnectable: scannedDevice.isConnectable,
                  lastSeen: now,
                }
              };
            });
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
    setDevices({});
  };

  // Convert device dictionary to sorted array
  const deviceList = Object.values(devices)
    .filter((d) => !filterNamedOnly || (d.name && d.name.trim().length > 0))
    .sort((a, b) => b.rssi - a.rssi); // Closest / strongest first

  return (
    <View style={s.card}>
      {/* Header */}
      <View style={s.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={s.sectionTitle}>Nearby BLE Beacon & RSSI Scanner</Text>
          <Text style={s.subText}>
            Bluetooth: <Text style={{ fontWeight: "700", color: bluetoothStatus === "PoweredOn" ? "#1a7f37" : "#cf222e" }}>{bluetoothStatus}</Text> • Formula: $10^{`{(Tx - RSSI) / (10n)}`}$
          </Text>
        </View>
        {isScanning && (
          <View style={s.scanningBadge}>
            <ActivityIndicator size="small" color="#1f6feb" />
            <Text style={s.scanningText}>Scanning</Text>
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

      {/* Filter & Calibration Options */}
      <View style={s.filterRow}>
        <View style={s.switchItem}>
          <Text style={s.filterLabel}>Named Devices Only</Text>
          <Switch
            value={filterNamedOnly}
            onValueChange={setFilterNamedOnly}
            trackColor={{ false: "#d0d7de", true: "#80ccff" }}
            thumbColor={filterNamedOnly ? "#1f6feb" : "#f6f8fa"}
          />
        </View>
        <View style={s.paramBadge}>
          <Text style={s.paramText}>Tx@1m: {txPower1m}dBm | n: {environmentalN}</Text>
        </View>
      </View>

      {/* Device Count Summary */}
      <View style={s.summaryBar}>
        <Text style={s.summaryText}>
          Discovered: <Text style={{ fontWeight: "800", color: "#24292f" }}>{deviceList.length}</Text> active BLE signal{deviceList.length === 1 ? "" : "s"}
        </Text>
        <Text style={s.summaryHint}>Sorted by Proximity (Strongest RSSI first)</Text>
      </View>

      {/* Device List */}
      {deviceList.length === 0 ? (
        <View style={s.emptyBox}>
          <Text style={s.emptyTitle}>
            {isScanning ? "Searching for nearby BLE devices..." : "Scanner is currently idle"}
          </Text>
          <Text style={s.emptySub}>
            {isScanning
              ? "Ensure Bluetooth beacons, fitness bands, or BLE hardware are broadcasting."
              : "Tap 'Start BLE Scan' above to request Bluetooth permissions and detect nearby signals."}
          </Text>
        </View>
      ) : (
        <ScrollView style={s.deviceScroll} nestedScrollEnabled>
          {deviceList.map((device) => {
            const quality = getSignalQuality(device.rssi);
            const isNamed = !!device.name;

            return (
              <View key={device.id} style={s.deviceCard}>
                <View style={s.deviceHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={[s.deviceName, !isNamed && s.unnamedDevice]}>
                      {device.name || "Unknown BLE Device / Beacon"}
                    </Text>
                    <Text style={s.deviceId}>ID: {device.id}</Text>
                  </View>
                  <View style={[s.qualityBadge, { backgroundColor: quality.bg, borderColor: quality.color }]}>
                    <Text style={[s.qualityText, { color: quality.color }]}>
                      {quality.label}
                    </Text>
                  </View>
                </View>

                {/* Metrics Row: RSSI + Estimated Distance */}
                <View style={s.metricRow}>
                  <View style={s.metricItem}>
                    <Text style={s.metricTitle}>Signal Strength</Text>
                    <Text style={[s.metricNumber, { color: quality.color }]}>
                      {device.rssi} <Text style={s.metricUnit}>dBm</Text>
                    </Text>
                  </View>

                  <View style={s.metricDivider} />

                  <View style={s.metricItem}>
                    <Text style={s.metricTitle}>Est. Distance</Text>
                    <Text style={s.distNumber}>
                      {device.distance !== null ? `~${device.distance}` : "--"}{" "}
                      <Text style={s.metricUnit}>meters</Text>
                    </Text>
                  </View>
                </View>

                {/* Signal Strength Visual Bar */}
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
                    Last seen: {Math.max(0, Math.round((Date.now() - device.lastSeen) / 1000))}s ago
                  </Text>
                  {device.txPowerLevel !== undefined && (
                    <Text style={s.footerText}>TxPower: {device.txPowerLevel} dBm</Text>
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
    fontSize: 11,
    color: "#57606a",
    fontFamily: "monospace",
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
    maxHeight: 280,
  },
  deviceCard: {
    backgroundColor: "#ffffff",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#e1e4e8",
    padding: 10,
    marginBottom: 8,
    shadowColor: "#000",
    shadowOpacity: 0.02,
    shadowRadius: 3,
  },
  deviceHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 6,
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
  qualityBadge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
  },
  qualityText: {
    fontSize: 11,
    fontWeight: "800",
  },
  metricRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#f6f8fa",
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 8,
    marginVertical: 6,
  },
  metricItem: {
    flex: 1,
    alignItems: "center",
  },
  metricDivider: {
    width: 1,
    height: 24,
    backgroundColor: "#d0d7de",
  },
  metricTitle: {
    fontSize: 10,
    fontWeight: "600",
    color: "#57606a",
    textTransform: "uppercase",
  },
  metricNumber: {
    fontSize: 16,
    fontWeight: "800",
  },
  distNumber: {
    fontSize: 16,
    fontWeight: "800",
    color: "#1f6feb",
  },
  metricUnit: {
    fontSize: 11,
    fontWeight: "500",
    color: "#57606a",
  },
  barContainer: {
    height: 5,
    backgroundColor: "#eaeef2",
    borderRadius: 3,
    overflow: "hidden",
    marginTop: 2,
    marginBottom: 6,
  },
  barFill: {
    height: "100%",
    borderRadius: 3,
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
