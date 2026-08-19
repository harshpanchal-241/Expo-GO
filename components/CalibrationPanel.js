// ============================================================================
// CalibrationPanel — Per-Beacon RSSI Calibration UI (Stage 3)
// ============================================================================

import React, { useState, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  ActivityIndicator,
} from "react-native";

export default function CalibrationPanel({
  beaconNum,       // 1 or 2
  beaconName,      // display name
  pipeline,        // RssiFilterPipeline instance
  txPower,         // current saved txPower
  pathLossN,       // current path-loss n
  onSaveTxPower,   // (value) → updates config
  onSavePathLossN, // (value) → updates config (only for B1 to avoid duplication)
}) {
  const [collecting,  setCollecting]  = useState(false);
  const [progress,    setProgress]    = useState(0);
  const [result,      setResult]      = useState(null);
  const [txInput,     setTxInput]     = useState(String(txPower));
  const [nInput,      setNInput]      = useState(String(pathLossN));
  const progressRef = useRef(0);
  const intervalRef = useRef(null);

  const pipelineState = pipeline?.getState?.() ?? {};
  const { rawRssi, filteredRssi } = pipelineState;

  // Live distance estimate using current txPower and n
  const distM = (filteredRssi !== null)
    ? Math.pow(10, (txPower - filteredRssi) / (10 * pathLossN))
    : null;
  const distFt = distM !== null ? distM * 3.28084 : null;

  async function startCalibration() {
    if (!pipeline) return;
    setCollecting(true);
    setProgress(0);
    setResult(null);

    // Inline 3-second collection using pipeline
    const DURATION_MS = 3000;
    const samples = [];
    const start = Date.now();

    intervalRef.current = setInterval(() => {
      if (pipeline.rawRssi !== null) samples.push(pipeline.rawRssi);
      const p = Math.min(1, (Date.now() - start) / DURATION_MS);
      setProgress(p);

      if (p >= 1) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
        setCollecting(false);
        setProgress(1);

        if (samples.length > 0) {
          const sorted = [...samples].sort((a, b) => a - b);
          const median = sorted[Math.floor(sorted.length / 2)];
          setResult(median);
          setTxInput(String(median));
          onSaveTxPower?.(median);
        }
      }
    }, 100);
  }

  function applyManualTxPower() {
    const val = parseFloat(txInput);
    if (isFinite(val) && val < 0) onSaveTxPower?.(val);
  }

  function applyManualN() {
    const val = parseFloat(nInput);
    if (isFinite(val) && val > 0) onSavePathLossN?.(val);
  }

  const statusColor = rawRssi === null ? "#8c959f" : rawRssi > -70 ? "#1a7f37" : rawRssi > -82 ? "#d29922" : "#cf222e";

  return (
    <View style={styles.card}>
      {/* Header */}
      <View style={styles.row}>
        <View style={[styles.badge, { backgroundColor: beaconNum === 1 ? "#ddf4ff" : "#f3f0ff" }]}>
          <Text style={[styles.badgeText, { color: beaconNum === 1 ? "#0369a1" : "#6d28d9" }]}>
            B{beaconNum}
          </Text>
        </View>
        <Text style={styles.beaconName} numberOfLines={1}>{beaconName || `Beacon ${beaconNum}`}</Text>
      </View>

      {/* Live RSSI readout */}
      <View style={styles.readoutRow}>
        <ReadoutCell label="Raw RSSI"      value={rawRssi      != null ? `${rawRssi} dBm`       : "—"} color={statusColor} />
        <ReadoutCell label="Filtered RSSI" value={filteredRssi != null ? `${filteredRssi} dBm`  : "—"} color={statusColor} />
        <ReadoutCell label="Est. Distance" value={distFt       != null ? `${distFt.toFixed(1)} ft` : "—"} color="#1f6feb" />
      </View>

      {/* Calibrate at 1 m */}
      <Text style={styles.instruction}>
        Stand ~1 ft from beacon, then tap Collect to measure RSSI@1m.
      </Text>

      {collecting ? (
        <View style={styles.progressRow}>
          <ActivityIndicator size="small" color="#1f6feb" />
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${(progress * 100).toFixed(0)}%` }]} />
          </View>
          <Text style={styles.progressLabel}>{(progress * 100).toFixed(0)}%</Text>
        </View>
      ) : (
        <Pressable style={styles.collectBtn} onPress={startCalibration}>
          <Text style={styles.collectBtnText}>📡 Collect RSSI @ 1 ft</Text>
        </Pressable>
      )}

      {result !== null && (
        <Text style={styles.resultText}>✅ Calibrated: {result} dBm saved as TX Power</Text>
      )}

      {/* Manual override */}
      <View style={styles.manualRow}>
        <Text style={styles.manualLabel}>TX Power (dBm)</Text>
        <TextInput
          style={styles.manualInput}
          value={txInput}
          onChangeText={setTxInput}
          keyboardType="numeric"
          onBlur={applyManualTxPower}
          returnKeyType="done"
          onSubmitEditing={applyManualTxPower}
        />
      </View>

      {beaconNum === 1 && (
        <View style={styles.manualRow}>
          <Text style={styles.manualLabel}>Path Loss n (shared)</Text>
          <TextInput
            style={styles.manualInput}
            value={nInput}
            onChangeText={setNInput}
            keyboardType="numeric"
            onBlur={applyManualN}
            returnKeyType="done"
            onSubmitEditing={applyManualN}
          />
        </View>
      )}
    </View>
  );
}

function ReadoutCell({ label, value, color }) {
  return (
    <View style={styles.readoutCell}>
      <Text style={styles.readoutLabel}>{label}</Text>
      <Text style={[styles.readoutValue, { color }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: "#d0d7de",
    marginBottom: 10,
  },
  row:  { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  badgeText: { fontWeight: "800", fontSize: 12 },
  beaconName: { fontWeight: "700", fontSize: 13, color: "#24292f", flex: 1 },

  readoutRow:  { flexDirection: "row", gap: 8, marginBottom: 10 },
  readoutCell: { flex: 1, backgroundColor: "#f6f8fa", borderRadius: 8, padding: 8, alignItems: "center" },
  readoutLabel:{ fontSize: 10, color: "#8c959f", fontWeight: "600", marginBottom: 3 },
  readoutValue:{ fontSize: 13, fontWeight: "800" },

  instruction: { fontSize: 11, color: "#57606a", marginBottom: 8, fontStyle: "italic" },

  progressRow:  { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  progressTrack:{ flex: 1, height: 6, backgroundColor: "#e1e4e8", borderRadius: 3, overflow: "hidden" },
  progressFill: { height: "100%", backgroundColor: "#1f6feb", borderRadius: 3 },
  progressLabel:{ fontSize: 11, fontWeight: "700", color: "#1f6feb", width: 32 },

  collectBtn:     { backgroundColor: "#eef5ff", borderRadius: 8, paddingVertical: 10, alignItems: "center",
                    borderWidth: 1, borderColor: "#54aeff", marginBottom: 8 },
  collectBtnText: { fontSize: 13, fontWeight: "700", color: "#0969da" },

  resultText: { fontSize: 12, color: "#1a7f37", fontWeight: "700", marginBottom: 8 },

  manualRow:  { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 6 },
  manualLabel:{ fontSize: 12, color: "#57606a", fontWeight: "600" },
  manualInput:{ borderWidth: 1, borderColor: "#d0d7de", borderRadius: 8, paddingHorizontal: 10,
                paddingVertical: 6, fontSize: 13, fontWeight: "700", color: "#24292f",
                backgroundColor: "#f6f8fa", width: 90, textAlign: "right" },
});
