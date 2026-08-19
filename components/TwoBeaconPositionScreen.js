// ============================================================================
// TwoBeaconPositionScreen — Main 2-Beacon Indoor Positioning Module
//
// This screen is completely isolated from existing PDR and BLE scanner tabs.
// It orchestrates 4 stages: Select → Place → Calibrate → Position Test
// ============================================================================

import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  TextInput,
  Alert,
  Switch,
  ActivityIndicator,
} from "react-native";

import { useTwoBeaconPositioning } from "../hooks/useTwoBeaconPositioning.js";
import {
  loadBeaconConfig,
  saveBeaconConfig,
  resetBeaconConfig,
  DEFAULT_CONFIG,
} from "../services/beaconConfigStorage.js";
import TestAreaMap      from "./TestAreaMap.js";
import CalibrationPanel from "./CalibrationPanel.js";
import BeaconDebugPanel from "./BeaconDebugPanel.js";

// Stages shown as step indicators
const STAGES = [
  { id: "select",    label: "1. Select\nBeacons" },
  { id: "place",     label: "2. Place\nBeacons"  },
  { id: "calibrate", label: "3. Calibrate"        },
  { id: "position",  label: "4. Position\nTest"   },
];

export default function TwoBeaconPositionScreen({ pdrStepCallbackRef }) {
  // ─── Config state (persisted) ─────────────────────────────────────────────
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [configLoaded, setConfigLoaded] = useState(false);

  // ─── Current UI stage ─────────────────────────────────────────────────────
  const [activeStage, setActiveStage] = useState("select");

  // ─── Debug overlays ───────────────────────────────────────────────────────
  const [showOverlays, setShowOverlays] = useState(false);

  // ─── Hook ─────────────────────────────────────────────────────────────────
  const {
    isScanning,
    isExpoGoMode,
    bluetoothStatus,
    devices,
    moduleState,
    positionState,
    trail,
    debugInfo,
    actions,
  } = useTwoBeaconPositioning({ config, pdrStepCallbackRef });

  // ─── Load config on mount ─────────────────────────────────────────────────
  useEffect(() => {
    loadBeaconConfig().then(cfg => {
      setConfig(cfg);
      setConfigLoaded(true);
      // If beacons were already selected, jump to place stage
      if (cfg.beacon1Id && cfg.beacon2Id) setActiveStage("place");
    });
  }, []);

  // ─── Config update helper ─────────────────────────────────────────────────
  const updateConfig = useCallback(async (updates) => {
    setConfig(prev => {
      const next = { ...prev, ...updates };
      saveBeaconConfig(updates); // fire-and-forget
      return next;
    });
  }, []);

  // ─── Device list helpers ──────────────────────────────────────────────────
  const sortedDevices = Object.values(devices).sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));

  function assignBeacon(beaconNum, device) {
    if (beaconNum === 1) {
      if (config.beacon2Id === device.id) {
        Alert.alert("Already Selected", "This device is already assigned as Beacon 2.");
        return;
      }
      updateConfig({ beacon1Id: device.id, beacon1Name: device.name });
    } else {
      if (config.beacon1Id === device.id) {
        Alert.alert("Already Selected", "This device is already assigned as Beacon 1.");
        return;
      }
      updateConfig({ beacon2Id: device.id, beacon2Name: device.name });
    }
  }

  const canAdvanceToPlace     = !!(config.beacon1Id && config.beacon2Id);
  const canAdvanceToCalibrate = canAdvanceToPlace;
  const canStartTest          = canAdvanceToCalibrate;

  // ─── Reset handler ────────────────────────────────────────────────────────
  async function handleReset() {
    Alert.alert("Reset Configuration", "Clear all beacon settings and start over?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Reset",
        style: "destructive",
        onPress: async () => {
          actions.stopPositioning?.();
          const fresh = await resetBeaconConfig();
          setConfig(fresh);
          setActiveStage("select");
          actions.resetPipelines?.();
          actions.resetPosition?.();
        },
      },
    ]);
  }

  if (!configLoaded) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#1f6feb" />
        <Text style={styles.loadingText}>Loading configuration…</Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {/* ── Header ── */}
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>2-Beacon Position Test</Text>
          <Text style={styles.sub}>BLE ranging + PDR + Adaptive Kalman • 18 × 15 ft room</Text>
        </View>
        <Pressable style={styles.resetBtn} onPress={handleReset}>
          <Text style={styles.resetBtnText}>Reset</Text>
        </Pressable>
      </View>

      {/* ── Expo Go notice ── */}
      {isExpoGoMode && (
        <View style={styles.noticeBanner}>
          <Text style={styles.noticeText}>
            ⚠️ Expo Go detected — running with simulated BLE devices. Build with EAS for real BLE.
          </Text>
        </View>
      )}

      {/* ── Stage Indicator ── */}
      <StageIndicator stages={STAGES} active={activeStage} onPress={setActiveStage} />

      {/* ══════════════════════════════════════════════════
          STAGE 1 — SELECT BEACONS
      ══════════════════════════════════════════════════ */}
      {activeStage === "select" && (
        <SelectBeaconsStage
          config={config}
          isScanning={isScanning}
          bluetoothStatus={bluetoothStatus}
          sortedDevices={sortedDevices}
          onStartScan={actions.startScan}
          onStopScan={actions.stopScan}
          onAssignBeacon={assignBeacon}
          onClearBeacon={(n) => updateConfig(n === 1
            ? { beacon1Id: null, beacon1Name: "" }
            : { beacon2Id: null, beacon2Name: "" })}
          onClearAll={() => updateConfig({ beacon1Id: null, beacon1Name: "", beacon2Id: null, beacon2Name: "" })}
          canAdvance={canAdvanceToPlace}
          onAdvance={() => setActiveStage("place")}
        />
      )}

      {/* ══════════════════════════════════════════════════
          STAGE 2 — PLACE BEACONS
      ══════════════════════════════════════════════════ */}
      {activeStage === "place" && (
        <PlaceBeaconsStage
          config={config}
          onBeacon1Move={(x, y) => updateConfig({ beacon1X: x, beacon1Y: y })}
          onBeacon2Move={(x, y) => updateConfig({ beacon2X: x, beacon2Y: y })}
          onResetLayout={() => updateConfig({ beacon1X: 0, beacon1Y: 15, beacon2X: 18, beacon2Y: 15 })}
          heightCorrectionOn={config.heightCorrectionOn}
          onToggleHeight={(v) => updateConfig({ heightCorrectionOn: v })}
          onUpdateHeight={(key, v) => updateConfig({ [key]: parseFloat(v) || 0 })}
          onAdvance={() => setActiveStage("calibrate")}
        />
      )}

      {/* ══════════════════════════════════════════════════
          STAGE 3 — CALIBRATE
      ══════════════════════════════════════════════════ */}
      {activeStage === "calibrate" && (
        <CalibrateStage
          config={config}
          actions={actions}
          isScanning={isScanning}
          onStartScan={actions.startScan}
          onSaveB1TxPower={(v) => updateConfig({ beacon1TxPower: v })}
          onSaveB2TxPower={(v) => updateConfig({ beacon2TxPower: v })}
          onSavePathLossN={(v) => updateConfig({ pathLossN: v })}
          onAdvance={() => setActiveStage("position")}
        />
      )}

      {/* ══════════════════════════════════════════════════
          STAGE 4 — POSITION TEST
      ══════════════════════════════════════════════════ */}
      {activeStage === "position" && (
        <PositionTestStage
          config={config}
          moduleState={moduleState}
          positionState={positionState}
          trail={trail}
          debugInfo={debugInfo}
          showOverlays={showOverlays}
          onToggleOverlays={() => setShowOverlays(v => !v)}
          actions={actions}
          onGoToPlace={() => setActiveStage("place")}
        />
      )}
    </ScrollView>
  );
}

// ============================================================================
// Stage Indicator
// ============================================================================
function StageIndicator({ stages, active, onPress }) {
  const activeIdx = stages.findIndex(s => s.id === active);
  return (
    <View style={styles.stageRow}>
      {stages.map((stage, idx) => {
        const isActive  = stage.id === active;
        const isDone    = idx < activeIdx;
        return (
          <Pressable key={stage.id} style={styles.stageItem} onPress={() => onPress(stage.id)}>
            <View style={[
              styles.stageCircle,
              isActive && styles.stageCircleActive,
              isDone   && styles.stageCircleDone,
            ]}>
              <Text style={[styles.stageNum, (isActive || isDone) && { color: "#fff" }]}>
                {isDone ? "✓" : String(idx + 1)}
              </Text>
            </View>
            <Text style={[
              styles.stageLabel,
              isActive && { color: "#1f6feb", fontWeight: "700" },
              isDone   && { color: "#1a7f37" },
            ]}>{stage.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ============================================================================
// Stage 1 — Select Beacons
// ============================================================================
function SelectBeaconsStage({
  config, isScanning, bluetoothStatus, sortedDevices,
  onStartScan, onStopScan, onAssignBeacon, onClearBeacon, onClearAll,
  canAdvance, onAdvance,
}) {
  return (
    <>
      {/* Selected beacons summary */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Selected Beacons</Text>
        <SelectedBeaconRow
          num={1}
          id={config.beacon1Id}
          name={config.beacon1Name}
          onClear={() => onClearBeacon(1)}
          color="#0369a1"
        />
        <SelectedBeaconRow
          num={2}
          id={config.beacon2Id}
          name={config.beacon2Name}
          onClear={() => onClearBeacon(2)}
          color="#6d28d9"
        />
        {(config.beacon1Id || config.beacon2Id) && (
          <Pressable style={styles.clearAllBtn} onPress={onClearAll}>
            <Text style={styles.clearAllText}>Clear All Selections</Text>
          </Pressable>
        )}
      </View>

      {/* Scan controls */}
      <View style={styles.card}>
        <View style={styles.scanHeader}>
          <View>
            <Text style={styles.cardTitle}>BLE Scanner</Text>
            <Text style={styles.btStatus}>BT: {bluetoothStatus} • {sortedDevices.length} devices</Text>
          </View>
          <Pressable
            style={[styles.scanBtn, isScanning && styles.scanBtnStop]}
            onPress={isScanning ? onStopScan : onStartScan}
          >
            {isScanning
              ? <ActivityIndicator size="small" color="#fff" />
              : <Text style={styles.scanBtnText}>Scan</Text>}
            <Text style={[styles.scanBtnText, { marginLeft: 4 }]}>
              {isScanning ? " Scanning…" : " Devices"}
            </Text>
          </Pressable>
        </View>

        {sortedDevices.length === 0 ? (
          <Text style={styles.emptyText}>No devices found. Tap Scan to start.</Text>
        ) : (
          sortedDevices.map(device => (
            <DeviceCard
              key={device.id}
              device={device}
              isBeacon1={config.beacon1Id === device.id}
              isBeacon2={config.beacon2Id === device.id}
              onSetBeacon1={() => onAssignBeacon(1, device)}
              onSetBeacon2={() => onAssignBeacon(2, device)}
            />
          ))
        )}
      </View>

      {canAdvance && (
        <Pressable style={styles.advanceBtn} onPress={onAdvance}>
          <Text style={styles.advanceBtnText}>Next: Place Beacons →</Text>
        </Pressable>
      )}
    </>
  );
}

function SelectedBeaconRow({ num, id, name, onClear, color }) {
  return (
    <View style={[styles.selRow, { borderColor: color + "44" }]}>
      <View style={[styles.selBadge, { backgroundColor: color + "18" }]}>
        <Text style={[styles.selBadgeText, { color }]}>B{num}</Text>
      </View>
      <View style={{ flex: 1 }}>
        {id ? (
          <>
            <Text style={styles.selName}>{name || "Unknown"}</Text>
            <Text style={styles.selId} numberOfLines={1}>{id}</Text>
          </>
        ) : (
          <Text style={styles.selEmpty}>Not selected</Text>
        )}
      </View>
      {id && (
        <Pressable onPress={onClear} style={styles.selClearBtn}>
          <Text style={styles.selClearText}>Change</Text>
        </Pressable>
      )}
    </View>
  );
}

function DeviceCard({ device, isBeacon1, isBeacon2, onSetBeacon1, onSetBeacon2 }) {
  const rssi     = device.rssi ?? 0;
  const ageSec   = device.ageMsAgo ? (device.ageMsAgo / 1000).toFixed(1) : "?";
  const qual     = rssi > -60 ? "#1a7f37" : rssi > -75 ? "#0969da" : rssi > -85 ? "#d29922" : "#cf222e";
  const selected = isBeacon1 || isBeacon2;

  return (
    <View style={[styles.deviceCard, selected && styles.deviceCardSelected]}>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={styles.deviceName}>{device.name}</Text>
          {isBeacon1 && <Tag label="B1" color="#0369a1" />}
          {isBeacon2 && <Tag label="B2" color="#6d28d9" />}
        </View>
        <Text style={styles.deviceId} numberOfLines={1}>{device.id}</Text>
        <View style={{ flexDirection: "row", gap: 10 }}>
          <Text style={[styles.deviceRssi, { color: qual }]}>{rssi} dBm</Text>
          <Text style={styles.deviceAge}>{ageSec}s ago</Text>
        </View>
      </View>
      {!isBeacon1 && (
        <Pressable style={[styles.assignBtn, { borderColor: "#0369a1" }]} onPress={onSetBeacon1}>
          <Text style={[styles.assignBtnText, { color: "#0369a1" }]}>Set B1</Text>
        </Pressable>
      )}
      {!isBeacon2 && (
        <Pressable style={[styles.assignBtn, { borderColor: "#6d28d9" }]} onPress={onSetBeacon2}>
          <Text style={[styles.assignBtnText, { color: "#6d28d9" }]}>Set B2</Text>
        </Pressable>
      )}
    </View>
  );
}

function Tag({ label, color }) {
  return (
    <View style={[styles.tag, { backgroundColor: color + "18", borderColor: color + "66" }]}>
      <Text style={[styles.tagText, { color }]}>{label}</Text>
    </View>
  );
}

// ============================================================================
// Stage 2 — Place Beacons
// ============================================================================
function PlaceBeaconsStage({
  config, onBeacon1Move, onBeacon2Move, onResetLayout,
  heightCorrectionOn, onToggleHeight, onUpdateHeight, onAdvance,
}) {
  return (
    <>
      <View style={styles.card}>
        <View style={styles.cardTitleRow}>
          <Text style={styles.cardTitle}>Beacon Placement</Text>
          <Pressable style={styles.resetLayoutBtn} onPress={onResetLayout}>
            <Text style={styles.resetLayoutText}>Reset Layout</Text>
          </Pressable>
        </View>
        <Text style={styles.cardSub}>Drag B1 and B2 to their physical locations in the room.</Text>
      </View>

      <TestAreaMap
        beacon1={{ x: config.beacon1X, y: config.beacon1Y }}
        beacon2={{ x: config.beacon2X, y: config.beacon2Y }}
        userPosition={{ fusedX: 9, fusedY: 7.5 }}
        isSetupMode={true}
        showDebugOverlays={false}
        onBeacon1Move={onBeacon1Move}
        onBeacon2Move={onBeacon2Move}
      />

      {/* Coordinate display */}
      <View style={styles.coordCard}>
        <CoordRow label="Beacon 1" x={config.beacon1X} y={config.beacon1Y} color="#0369a1" />
        <CoordRow label="Beacon 2" x={config.beacon2X} y={config.beacon2Y} color="#6d28d9" />
      </View>

      {/* Height correction */}
      <View style={styles.card}>
        <View style={styles.cardTitleRow}>
          <Text style={styles.cardTitle}>Height Correction</Text>
          <Switch
            value={heightCorrectionOn}
            onValueChange={onToggleHeight}
            trackColor={{ false: "#d0d7de", true: "#54aeff" }}
            thumbColor="#fff"
          />
        </View>
        {heightCorrectionOn && (
          <>
            <Text style={styles.cardSub}>For ceiling-mounted beacons.</Text>
            <HeightInput label="Beacon 1 Height (ft)" value={config.beacon1HeightFt}
              onChange={v => onUpdateHeight("beacon1HeightFt", v)} />
            <HeightInput label="Beacon 2 Height (ft)" value={config.beacon2HeightFt}
              onChange={v => onUpdateHeight("beacon2HeightFt", v)} />
            <HeightInput label="Phone Height (ft)"   value={config.phoneHeightFt}
              onChange={v => onUpdateHeight("phoneHeightFt", v)} />
          </>
        )}
      </View>

      <Pressable style={styles.advanceBtn} onPress={onAdvance}>
        <Text style={styles.advanceBtnText}>Next: Calibrate →</Text>
      </Pressable>
    </>
  );
}

function CoordRow({ label, x, y, color }) {
  return (
    <View style={styles.coordRow}>
      <Text style={[styles.coordLabel, { color }]}>{label}</Text>
      <Text style={styles.coordValue}>X: {x.toFixed(2)} ft  •  Y: {y.toFixed(2)} ft</Text>
    </View>
  );
}

function HeightInput({ label, value, onChange }) {
  const [text, setText] = useState(String(value));
  return (
    <View style={styles.heightRow}>
      <Text style={styles.heightLabel}>{label}</Text>
      <TextInput
        style={styles.heightInput}
        value={text}
        onChangeText={setText}
        keyboardType="numeric"
        returnKeyType="done"
        onBlur={() => onChange(text)}
        onSubmitEditing={() => onChange(text)}
      />
    </View>
  );
}

// ============================================================================
// Stage 3 — Calibrate
// ============================================================================
function CalibrateStage({
  config, actions, isScanning, onStartScan,
  onSaveB1TxPower, onSaveB2TxPower, onSavePathLossN, onAdvance,
}) {
  useEffect(() => {
    if (!isScanning) onStartScan();
  }, []);

  const pipeline1 = actions.getCalibrationPipeline?.(1);
  const pipeline2 = actions.getCalibrationPipeline?.(2);

  return (
    <>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>RSSI Calibration</Text>
        <Text style={styles.cardSub}>
          Stand ~1 ft (30 cm) from each beacon and collect samples.
          This sets the TX Power reference for distance estimation.
        </Text>
        {!isScanning && (
          <Pressable style={styles.scanBtn} onPress={onStartScan}>
            <Text style={styles.scanBtnText}>📶 Start Scan</Text>
          </Pressable>
        )}
      </View>

      <CalibrationPanel
        beaconNum={1}
        beaconName={config.beacon1Name}
        pipeline={pipeline1}
        txPower={config.beacon1TxPower}
        pathLossN={config.pathLossN}
        onSaveTxPower={onSaveB1TxPower}
        onSavePathLossN={onSavePathLossN}
      />

      <CalibrationPanel
        beaconNum={2}
        beaconName={config.beacon2Name}
        pipeline={pipeline2}
        txPower={config.beacon2TxPower}
        pathLossN={config.pathLossN}
        onSaveTxPower={onSaveB2TxPower}
      />

      <Pressable style={styles.advanceBtn} onPress={onAdvance}>
        <Text style={styles.advanceBtnText}>Next: Start Position Test →</Text>
      </Pressable>
    </>
  );
}

// ============================================================================
// Stage 4 — Position Test
// ============================================================================
function PositionTestStage({
  config, moduleState, positionState, trail, debugInfo,
  showOverlays, onToggleOverlays, actions, onGoToPlace,
}) {
  const isPositioning = moduleState === "POSITIONING";
  const isPaused      = moduleState === "PAUSED";
  const isStopped     = ["STOPPED", "CALIBRATED", "PLACEMENT_CONFIGURED", "BEACONS_SELECTED"].includes(moduleState);

  const { bleX = 9, bleY = 7.5, pdrX = 9, pdrY = 7.5,
          fusedX = 9, fusedY = 7.5, confidence = 0 } = positionState || {};

  const b1Available = debugInfo?.b1Available;
  const b2Available = debugInfo?.b2Available;

  return (
    <>
      {/* Status banner */}
      <View style={[styles.statusBanner, {
        backgroundColor:
          isPositioning ? "#dafbe1" :
          isPaused      ? "#fff8c5" : "#f6f8fa",
        borderColor:
          isPositioning ? "#2da44e" :
          isPaused      ? "#d29922" : "#d0d7de",
      }]}>
        <View style={[styles.statusDot, {
          backgroundColor:
            isPositioning ? "#1a7f37" :
            isPaused      ? "#d29922" : "#8c959f",
        }]} />
        <Text style={styles.statusText}>
          {isPositioning ? "● POSITIONING ACTIVE"  :
           isPaused      ? "⏸ PAUSED"              :
                           "⏹ STOPPED"}
        </Text>
        <View style={{ flexDirection: "row", gap: 8, marginLeft: "auto" }}>
          <BeaconSignalBadge label="B1" available={b1Available} />
          <BeaconSignalBadge label="B2" available={b2Available} />
        </View>
      </View>

      {/* Live position metrics */}
      <View style={styles.metricsRow}>
        <MetricTile label="X Position" value={`${fusedX.toFixed(2)} ft`} highlight />
        <MetricTile label="Y Position" value={`${fusedY.toFixed(2)} ft`} highlight />
        <MetricTile label="Confidence" value={`${(confidence * 100).toFixed(0)}%`}
          color={confidence > 0.6 ? "#1a7f37" : confidence > 0.3 ? "#d29922" : "#cf222e"} />
      </View>

      {/* Map */}
      <TestAreaMap
        beacon1={{ x: config.beacon1X, y: config.beacon1Y }}
        beacon2={{ x: config.beacon2X, y: config.beacon2Y }}
        userPosition={{ fusedX, fusedY }}
        blePosition={showOverlays ? { bleX, bleY } : null}
        pdrPosition={showOverlays ? { pdrX, pdrY } : null}
        trail={trail}
        isSetupMode={false}
        showDebugOverlays={showOverlays}
        onBeacon1Move={() => {}}
        onBeacon2Move={() => {}}
      />

      {/* Control buttons */}
      <View style={styles.controlRow}>
        {isStopped && (
          <ActionBtn
            label="▶ Start Test"
            onPress={actions.startPositioning}
            style={styles.btnGreen}
          />
        )}
        {isPositioning && (
          <ActionBtn label="⏸ Pause" onPress={actions.pausePositioning} style={styles.btnYellow} />
        )}
        {isPaused && (
          <ActionBtn label="▶ Resume" onPress={actions.resumePositioning} style={styles.btnGreen} />
        )}
        {(isPositioning || isPaused) && (
          <ActionBtn label="⏹ Stop" onPress={actions.stopPositioning} style={styles.btnRed} />
        )}
      </View>
      <View style={styles.controlRow}>
        <ActionBtn label="↺ Reset Position" onPress={() => { actions.resetPosition?.(); actions.resetPipelines?.(); }} style={styles.btnOutline} />
        <ActionBtn label="✕ Clear Trail"    onPress={actions.clearTrail}                                                   style={styles.btnOutline} />
        <ActionBtn label="✎ Edit Placement" onPress={onGoToPlace}                                                          style={styles.btnOutline} />
      </View>

      {/* Debug panel */}
      <BeaconDebugPanel
        debugInfo={debugInfo}
        beacon1Name={config.beacon1Name}
        beacon2Name={config.beacon2Name}
        showOverlays={showOverlays}
        onToggleOverlays={onToggleOverlays}
      />
    </>
  );
}

function BeaconSignalBadge({ label, available }) {
  return (
    <View style={[styles.sigBadge, { backgroundColor: available ? "#dafbe1" : "#ffebe9" }]}>
      <Text style={[styles.sigBadgeText, { color: available ? "#1a7f37" : "#cf222e" }]}>
        {label}: {available ? "✓" : "✗"}
      </Text>
    </View>
  );
}

function MetricTile({ label, value, highlight, color }) {
  return (
    <View style={[styles.metricTile, highlight && styles.metricTileHighlight]}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricValue, color ? { color } : highlight ? { color: "#1d4ed8" } : {}]}>{value}</Text>
    </View>
  );
}

function ActionBtn({ label, onPress, style }) {
  const isOutline = style === undefined || style?.backgroundColor === "#fff";
  return (
    <Pressable style={[styles.actionBtnBase, style]} onPress={onPress}>
      <Text style={[styles.actionBtnText, style?.backgroundColor === "#fff" && { color: "#24292f" }]}>
        {label}
      </Text>
    </Pressable>
  );
}

// ============================================================================
// Styles
// ============================================================================
const styles = StyleSheet.create({
  container: { padding: 16, paddingBottom: 40 },
  loadingContainer: { flex: 1, justifyContent: "center", alignItems: "center", padding: 40 },
  loadingText: { marginTop: 12, color: "#57606a", fontSize: 14 },

  // Header
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 },
  title:  { fontSize: 22, fontWeight: "800", color: "#24292f" },
  sub:    { fontSize: 11, color: "#57606a", marginTop: 2 },
  resetBtn:     { borderWidth: 1, borderColor: "#ffc9c9", backgroundColor: "#fff0f0",
                  paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, marginTop: 2 },
  resetBtnText: { fontSize: 12, fontWeight: "700", color: "#cf222e" },

  // Notice
  noticeBanner: { backgroundColor: "#fff8c5", borderRadius: 8, padding: 10,
                  borderWidth: 1, borderColor: "#d4a72c", marginBottom: 10 },
  noticeText: { fontSize: 11, color: "#7d4e17", fontWeight: "600" },

  // Stage indicator
  stageRow:    { flexDirection: "row", justifyContent: "space-between",
                 backgroundColor: "#f6f8fa", borderRadius: 12, padding: 10, marginBottom: 14 },
  stageItem:   { flex: 1, alignItems: "center", gap: 4 },
  stageCircle: { width: 28, height: 28, borderRadius: 14,
                 backgroundColor: "#e1e4e8", justifyContent: "center", alignItems: "center" },
  stageCircleActive: { backgroundColor: "#1f6feb" },
  stageCircleDone:   { backgroundColor: "#1a7f37" },
  stageNum:  { fontSize: 12, fontWeight: "800", color: "#57606a" },
  stageLabel:{ fontSize: 10, color: "#8c959f", textAlign: "center", fontWeight: "600" },

  // Cards
  card: { backgroundColor: "#fff", borderRadius: 12, padding: 14,
          borderWidth: 1, borderColor: "#d0d7de", marginBottom: 10 },
  cardTitle:    { fontWeight: "700", fontSize: 13, color: "#24292f", marginBottom: 4 },
  cardTitleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
  cardSub:      { fontSize: 11, color: "#57606a", lineHeight: 16, marginBottom: 8 },

  // Selected beacons
  selRow:     { flexDirection: "row", alignItems: "center", gap: 8,
                borderWidth: 1, borderRadius: 8, padding: 8, marginBottom: 6 },
  selBadge:   { width: 30, height: 30, borderRadius: 6, justifyContent: "center", alignItems: "center" },
  selBadgeText:{ fontWeight: "800", fontSize: 13 },
  selName:    { fontWeight: "700", fontSize: 12, color: "#24292f" },
  selId:      { fontSize: 10, color: "#8c959f", fontFamily: "monospace" },
  selEmpty:   { fontSize: 12, color: "#8c959f", fontStyle: "italic" },
  selClearBtn:  { paddingHorizontal: 8, paddingVertical: 4,
                  borderRadius: 6, borderWidth: 1, borderColor: "#d0d7de" },
  selClearText: { fontSize: 11, fontWeight: "700", color: "#57606a" },
  clearAllBtn:  { alignSelf: "center", marginTop: 4, paddingHorizontal: 10, paddingVertical: 4,
                  borderRadius: 6, borderWidth: 1, borderColor: "#ffc9c9" },
  clearAllText: { fontSize: 11, fontWeight: "700", color: "#cf222e" },

  // Scanner
  scanHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 },
  btStatus:   { fontSize: 11, color: "#8c959f", marginTop: 2 },
  scanBtn:    { flexDirection: "row", alignItems: "center", backgroundColor: "#1f6feb",
                paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 },
  scanBtnStop:{ backgroundColor: "#cf222e" },
  scanBtnText:{ color: "#fff", fontWeight: "700", fontSize: 12 },
  emptyText:  { fontSize: 12, color: "#8c959f", fontStyle: "italic", textAlign: "center", paddingVertical: 16 },

  // Device card
  deviceCard:      { flexDirection: "row", alignItems: "center", gap: 8,
                     padding: 10, borderRadius: 8, borderWidth: 1,
                     borderColor: "#e1e4e8", marginBottom: 6, backgroundColor: "#fafbfc" },
  deviceCardSelected:{ borderColor: "#54aeff", backgroundColor: "#eef5ff" },
  deviceName:  { fontWeight: "700", fontSize: 12, color: "#24292f" },
  deviceId:    { fontSize: 10, color: "#8c959f", fontFamily: "monospace", marginTop: 1 },
  deviceRssi:  { fontSize: 11, fontWeight: "700" },
  deviceAge:   { fontSize: 10, color: "#8c959f" },
  assignBtn:   { paddingHorizontal: 8, paddingVertical: 5, borderRadius: 6,
                 borderWidth: 1, backgroundColor: "#fff" },
  assignBtnText:{ fontSize: 11, fontWeight: "700" },
  tag:         { paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4, borderWidth: 1 },
  tagText:     { fontSize: 9, fontWeight: "800" },

  // Advance button
  advanceBtn:     { backgroundColor: "#1f6feb", borderRadius: 10,
                    paddingVertical: 14, alignItems: "center", marginBottom: 12 },
  advanceBtnText: { color: "#fff", fontWeight: "800", fontSize: 15 },

  // Place stage
  resetLayoutBtn:  { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6,
                     borderWidth: 1, borderColor: "#d0d7de" },
  resetLayoutText: { fontSize: 11, fontWeight: "700", color: "#57606a" },
  coordCard:  { backgroundColor: "#fff", borderRadius: 10, padding: 12,
                borderWidth: 1, borderColor: "#d0d7de", marginBottom: 10 },
  coordRow:   { flexDirection: "row", justifyContent: "space-between",
                alignItems: "center", paddingVertical: 5 },
  coordLabel: { fontWeight: "700", fontSize: 12 },
  coordValue: { fontSize: 12, color: "#24292f", fontFamily: "monospace" },
  heightRow:  { flexDirection: "row", justifyContent: "space-between",
                alignItems: "center", marginTop: 8 },
  heightLabel:{ fontSize: 12, color: "#57606a", fontWeight: "600" },
  heightInput:{ borderWidth: 1, borderColor: "#d0d7de", borderRadius: 8,
                paddingHorizontal: 10, paddingVertical: 6, fontSize: 13, fontWeight: "700",
                backgroundColor: "#f6f8fa", width: 80, textAlign: "right", color: "#24292f" },

  // Position test stage
  statusBanner: { flexDirection: "row", alignItems: "center", gap: 8,
                  borderRadius: 10, padding: 10, borderWidth: 1, marginBottom: 10 },
  statusDot:    { width: 10, height: 10, borderRadius: 5 },
  statusText:   { fontSize: 12, fontWeight: "700", color: "#24292f" },
  sigBadge:     { paddingHorizontal: 7, paddingVertical: 3, borderRadius: 5 },
  sigBadgeText: { fontSize: 10, fontWeight: "700" },

  metricsRow: { flexDirection: "row", gap: 8, marginBottom: 10 },
  metricTile: { flex: 1, backgroundColor: "#fff", borderRadius: 10,
                padding: 10, borderWidth: 1, borderColor: "#d0d7de", alignItems: "center" },
  metricTileHighlight: { borderColor: "#54aeff", backgroundColor: "#f0f8ff" },
  metricLabel: { fontSize: 10, color: "#57606a", fontWeight: "600" },
  metricValue: { fontSize: 16, fontWeight: "800", color: "#24292f", marginTop: 2 },

  controlRow:    { flexDirection: "row", gap: 8, marginBottom: 8 },
  actionBtnBase: { flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: "center",
                   justifyContent: "center" },
  actionBtnText: { fontWeight: "700", fontSize: 12, color: "#fff" },
  btnGreen:   { backgroundColor: "#1a7f37" },
  btnYellow:  { backgroundColor: "#d29922" },
  btnRed:     { backgroundColor: "#cf222e" },
  btnOutline: { backgroundColor: "#fff", borderWidth: 1, borderColor: "#d0d7de" },
});
