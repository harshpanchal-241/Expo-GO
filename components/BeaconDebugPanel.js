// ============================================================================
// BeaconDebugPanel — Live positioning debug info
// ============================================================================

import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  Switch,
} from "react-native";

export default function BeaconDebugPanel({
  debugInfo,        // from useTwoBeaconPositioning
  beacon1Name,
  beacon2Name,
  showOverlays,
  onToggleOverlays,
}) {
  const [groundTruth, setGroundTruth] = useState({ x: null, y: null });
  const [gtXInput,    setGtXInput]    = useState("");
  const [gtYInput,    setGtYInput]    = useState("");
  const [expanded,    setExpanded]    = useState(true);
  const [unit,        setUnit]        = useState("ft"); // "ft" | "m" | "in"

  const { b1 = {}, b2 = {},
    bleX = 0, bleY = 0,
    pdrX = 0, pdrY = 0,
    fusedX = 0, fusedY = 0,
    confidence = 0,
    b1Available = false, b2Available = false,
  } = debugInfo || {};

  const errorFt = (groundTruth.x !== null && groundTruth.y !== null)
    ? Math.hypot(fusedX - groundTruth.x, fusedY - groundTruth.y).toFixed(2)
    : null;

  function applyGroundTruth() {
    const x = parseFloat(gtXInput);
    const y = parseFloat(gtYInput);
    if (isFinite(x) && isFinite(y)) setGroundTruth({ x, y });
  }

  const confPct = (confidence * 100).toFixed(0);
  const confColor = confidence > 0.65 ? "#1a7f37" : confidence > 0.35 ? "#d29922" : "#cf222e";

  function formatCoord(feetVal) {
    if (feetVal === null || feetVal === undefined || isNaN(feetVal)) return "—";
    if (unit === "m") return `${(feetVal * 0.3048).toFixed(2)}m`;
    if (unit === "in") return `${(feetVal * 12).toFixed(1)}in`;
    return `${feetVal.toFixed(2)}ft`;
  }

  return (
    <View style={styles.card}>
      {/* Header with Unit Selector */}
      <View style={styles.headerRow}>
        <Pressable onPress={() => setExpanded(e => !e)} style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1 }}>
          <Text style={styles.title}>🔍 Live Debug Panel</Text>
          <Text style={styles.chevron}>{expanded ? "▲" : "▼"}</Text>
        </Pressable>

        {/* Distance Unit Segmented Buttons */}
        <View style={styles.unitSelector}>
          {[
            { id: "ft", label: "ft" },
            { id: "m",  label: "m" },
            { id: "in", label: "in" },
          ].map((u) => (
            <Pressable
              key={u.id}
              onPress={() => setUnit(u.id)}
              style={[styles.unitBtn, unit === u.id && styles.unitBtnActive]}
            >
              <Text style={[styles.unitBtnText, unit === u.id && styles.unitBtnTextActive]}>
                {u.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {expanded && (
        <>
          {/* Beacon 1 */}
          <BeaconRow
            label={`B1 — ${beacon1Name || "Beacon 1"}`}
            available={b1Available}
            rawRssi={b1.rawRssi}
            filteredRssi={b1.filteredRssi}
            distanceFt={b1.distanceFt}
            weight={b1.weight}
            color="#0369a1"
            unit={unit}
          />

          {/* Beacon 2 */}
          <BeaconRow
            label={`B2 — ${beacon2Name || "Beacon 2"}`}
            available={b2Available}
            rawRssi={b2.rawRssi}
            filteredRssi={b2.filteredRssi}
            distanceFt={b2.distanceFt}
            weight={b2.weight}
            color="#6d28d9"
            unit={unit}
          />

          {/* Position table */}
          <View style={styles.posTable}>
            <View style={styles.posRow}>
              <Text style={styles.posLabel}>BLE Position</Text>
              <Text style={styles.posValue}>
                X: {formatCoord(bleX)}  Y: {formatCoord(bleY)}
              </Text>
            </View>
            <View style={styles.posRow}>
              <Text style={styles.posLabel}>PDR Position</Text>
              <Text style={styles.posValue}>
                X: {formatCoord(pdrX)}  Y: {formatCoord(pdrY)}
              </Text>
            </View>
            <View style={[styles.posRow, { borderBottomWidth: 0 }]}>
              <Text style={[styles.posLabel, { fontWeight: "800", color: "#1d4ed8" }]}>Fused Position</Text>
              <Text style={[styles.posValue, { fontWeight: "800", color: "#1d4ed8" }]}>
                X: {formatCoord(fusedX)}  Y: {formatCoord(fusedY)}
              </Text>
            </View>
          </View>

          {/* Confidence bar */}
          <View style={styles.confRow}>
            <Text style={styles.confLabel}>Confidence</Text>
            <View style={styles.confTrack}>
              <View style={[styles.confFill, { width: `${confPct}%`, backgroundColor: confColor }]} />
            </View>
            <Text style={[styles.confPct, { color: confColor }]}>{confPct}%</Text>
          </View>

          {/* Ground truth error */}
          <View style={styles.gtRow}>
            <Text style={styles.gtLabel}>Ground Truth ({unit})</Text>
            <View style={styles.gtInputs}>
              <TextInput
                style={styles.gtInput}
                placeholder="X"
                value={gtXInput}
                onChangeText={setGtXInput}
                keyboardType="numeric"
                returnKeyType="done"
                onSubmitEditing={applyGroundTruth}
              />
              <TextInput
                style={styles.gtInput}
                placeholder="Y"
                value={gtYInput}
                onChangeText={setGtYInput}
                keyboardType="numeric"
                returnKeyType="done"
                onSubmitEditing={applyGroundTruth}
              />
              <Pressable style={styles.gtBtn} onPress={applyGroundTruth}>
                <Text style={styles.gtBtnText}>Set</Text>
              </Pressable>
            </View>
          </View>

          {errorFt !== null && (
            <View style={{ marginTop: 6, marginBottom: 2 }}>
              <Text style={styles.errorText}>
                📏 Position Error: <Text style={{ color: "#cf222e", fontWeight: "800" }}>{formatCoord(parseFloat(errorFt))}</Text>
              </Text>
              <Text style={{ fontSize: 10, color: "#57606a", marginTop: 1 }}>
                Conversions: {unit !== "ft" ? `${parseFloat(errorFt).toFixed(2)}ft ` : ""}{unit !== "m" ? `• ${(parseFloat(errorFt) * 0.3048).toFixed(2)}m ` : ""}{unit !== "in" ? `• ${(parseFloat(errorFt) * 12).toFixed(1)}in` : ""}
              </Text>
            </View>
          )}

          {/* Debug overlays toggle */}
          <View style={styles.toggleRow}>
            <Text style={styles.toggleLabel}>Show Raw BLE & PDR on map</Text>
            <Switch
              value={showOverlays}
              onValueChange={onToggleOverlays}
              trackColor={{ false: "#d0d7de", true: "#54aeff" }}
              thumbColor="#fff"
            />
          </View>
        </>
      )}
    </View>
  );
}

function BeaconRow({ label, available, rawRssi, filteredRssi, distanceFt, weight, color, unit = "ft" }) {
  const dot = available ? "#1a7f37" : "#cf222e";

  let distLabel = "—";
  if (distanceFt !== null && distanceFt !== undefined) {
    if (unit === "m") distLabel = `${(distanceFt * 0.3048).toFixed(2)}m`;
    else if (unit === "in") distLabel = `${(distanceFt * 12).toFixed(1)}in`;
    else distLabel = `${distanceFt.toFixed(1)}ft`;
  }

  return (
    <View style={styles.beaconRow}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 }}>
        <View style={[styles.dot, { backgroundColor: dot }]} />
        <Text style={[styles.beaconLabel, { color }]}>{label}</Text>
        {!available && <Text style={styles.noSignal}>No Signal</Text>}
      </View>
      <View style={styles.beaconCells}>
        <MiniCell label="Raw RSSI"   value={rawRssi      != null ? `${rawRssi} dBm`      : "—"} />
        <MiniCell label="Filtered"   value={filteredRssi != null ? `${filteredRssi} dBm` : "—"} />
        <MiniCell label={`Dist (${unit})`} value={distLabel} />
        <MiniCell label="Weight"     value={weight       != null ? weight.toFixed(2)      : "—"} />
      </View>
      {distanceFt !== null && distanceFt !== undefined && (
        <View style={{ flexDirection: "row", justifyContent: "flex-end", marginTop: 4, gap: 6 }}>
          <Text style={{ fontSize: 9, color: "#57606a" }}>
            {unit !== "ft" ? `${distanceFt.toFixed(1)}ft  ` : ""}
            {unit !== "m" ? `• ${(distanceFt * 0.3048).toFixed(2)}m  ` : ""}
            {unit !== "in" ? `• ${(distanceFt * 12).toFixed(1)}in` : ""}
          </Text>
        </View>
      )}
    </View>
  );
}



function MiniCell({ label, value }) {
  return (
    <View style={styles.miniCell}>
      <Text style={styles.miniLabel}>{label}</Text>
      <Text style={styles.miniValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#fff",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#d0d7de",
    padding: 12,
    marginBottom: 12,
  },
  headerRow:    { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  title:        { fontWeight: "800", fontSize: 13, color: "#24292f" },
  chevron:      { color: "#8c959f", fontSize: 13 },

  beaconRow:    { backgroundColor: "#f6f8fa", borderRadius: 8, padding: 10, marginBottom: 8 },
  beaconLabel:  { fontWeight: "700", fontSize: 12 },
  dot:          { width: 8, height: 8, borderRadius: 4 },
  noSignal:     { fontSize: 10, color: "#cf222e", fontWeight: "600",
                  backgroundColor: "#ffebe9", paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4 },
  beaconCells:  { flexDirection: "row", gap: 6 },
  miniCell:     { flex: 1, alignItems: "center" },
  miniLabel:    { fontSize: 9,  color: "#8c959f", fontWeight: "600" },
  miniValue:    { fontSize: 11, color: "#24292f", fontWeight: "700", marginTop: 2 },

  posTable:     { borderWidth: 1, borderColor: "#e1e4e8", borderRadius: 8, overflow: "hidden", marginBottom: 10 },
  posRow:       { flexDirection: "row", justifyContent: "space-between", alignItems: "center",
                  paddingHorizontal: 10, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: "#e1e4e8" },
  posLabel:     { fontSize: 11, color: "#57606a", fontWeight: "600" },
  posValue:     { fontSize: 11, color: "#24292f", fontWeight: "700", fontFamily: "monospace" },

  confRow:      { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10 },
  confLabel:    { fontSize: 11, color: "#57606a", fontWeight: "600", width: 80 },
  confTrack:    { flex: 1, height: 8, backgroundColor: "#e1e4e8", borderRadius: 4, overflow: "hidden" },
  confFill:     { height: "100%", borderRadius: 4 },
  confPct:      { fontSize: 11, fontWeight: "800", width: 36, textAlign: "right" },

  gtRow:        { marginBottom: 8 },
  gtLabel:      { fontSize: 11, color: "#57606a", fontWeight: "600", marginBottom: 5 },
  gtInputs:     { flexDirection: "row", gap: 6, alignItems: "center" },
  gtInput:      { borderWidth: 1, borderColor: "#d0d7de", borderRadius: 8,
                  paddingHorizontal: 10, paddingVertical: 6, fontSize: 13, fontWeight: "700",
                  backgroundColor: "#f6f8fa", flex: 1, color: "#24292f" },
  gtBtn:        { backgroundColor: "#1f6feb", borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  gtBtnText:    { color: "#fff", fontWeight: "700", fontSize: 12 },

  errorText:    { fontSize: 12, fontWeight: "700", color: "#24292f", marginBottom: 8 },

  toggleRow:    { flexDirection: "row", alignItems: "center", justifyContent: "space-between",
                  marginTop: 4, paddingTop: 8, borderTopWidth: 1, borderTopColor: "#e1e4e8" },
  toggleLabel:  { fontSize: 12, color: "#57606a", fontWeight: "600" },

  unitSelector: {
    flexDirection: "row",
    gap: 3,
    backgroundColor: "#f6f8fa",
    padding: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#d0d7de",
  },
  unitBtn: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 4,
  },
  unitBtnActive: {
    backgroundColor: "#1f6feb",
  },
  unitBtnText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#57606a",
  },
  unitBtnTextActive: {
    color: "#ffffff",
  },
});
