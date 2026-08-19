// ============================================================================
// useTwoBeaconPositioning — Central Hook
// Manages BLE scanning, RSSI pipeline, position calculation loop, and
// PDR step integration. Completely isolated from existing app state.
// ============================================================================

import { useRef, useState, useEffect, useCallback } from "react";
import {
  getBleManager,
  requestBluetoothPermissions,
  ensureBluetoothEnabled,
} from "../services/BleScannerService.js";
import {
  RssiFilterPipeline,
  rssiToDistance,
  applyHeightCorrection,
  computeWeight,
  solveTwoBeaconPosition,
  AdaptiveKalman2D,
  isSaneMovement,
  clampToRoom,
  ROOM_WIDTH_FT,
  ROOM_HEIGHT_FT,
} from "../services/twoBeaconServices.js";

// Calculation loop interval (ms → ~10 Hz)
const CALC_INTERVAL_MS = 100;
// UI render loop interval (ms → 20 FPS)
const UI_INTERVAL_MS   = 50;
// Max trail points on map
const MAX_TRAIL_POINTS = 60;

export function useTwoBeaconPositioning({
  config,              // beaconConfig from storage
  pdrStepCallbackRef,  // parent fills this ref; hook attaches to it
}) {
  // ─── Scan state ────────────────────────────────────────────────────────────
  const [isScanning,       setIsScanning]       = useState(false);
  const [devices,          setDevices]          = useState({});     // id → device meta
  const [bluetoothStatus,  setBluetoothStatus]  = useState("Unknown");
  const [isExpoGoMode,     setIsExpoGoMode]     = useState(false);

  // ─── Module state machine ──────────────────────────────────────────────────
  // IDLE | SCANNING | BEACONS_SELECTED | PLACEMENT_CONFIGURED |
  // CALIBRATED | POSITIONING | PAUSED | STOPPED
  const [moduleState, setModuleState] = useState("IDLE");

  // ─── Position output (for UI renders) ─────────────────────────────────────
  const [positionState, setPositionState] = useState({
    bleX: 9, bleY: 7.5,
    pdrX: 9, pdrY: 7.5,
    fusedX: 9, fusedY: 7.5,
    confidence: 0,
    timestamp: Date.now(),
  });
  const [trail,      setTrail]      = useState([]);
  const [debugInfo,  setDebugInfo]  = useState({});

  // ─── Internal refs (fast, no re-render) ───────────────────────────────────
  const isScanningRef    = useRef(false);
  const modulStateRef    = useRef("IDLE");
  const managerRef       = useRef(null);
  const scanSubRef       = useRef(null);
  const calcIntervalRef  = useRef(null);
  const uiIntervalRef    = useRef(null);
  const simIntervalRef   = useRef(null);

  // Per-beacon RSSI pipelines
  const pipeline1Ref = useRef(new RssiFilterPipeline());
  const pipeline2Ref = useRef(new RssiFilterPipeline());

  // Kalman filter
  const kalmanRef = useRef(new AdaptiveKalman2D());

  // PDR state ref (updated from parent callback)
  const pdrPosRef = useRef({ x: 9, y: 7.5 });

  // Position history for motion consistency
  const prevFusedRef  = useRef({ x: 9, y: 7.5 });
  const prevBle1Ref   = useRef(null);
  const prevDist1Ref  = useRef(null);
  const prevDist2Ref  = useRef(null);
  const lastCalcTime  = useRef(Date.now());

  // Device meta ref (for raw device display)
  const deviceMetaRef = useRef({});

  // Latest position ref (used by UI loop to avoid stale state)
  const positionRef   = useRef({ bleX: 9, bleY: 7.5, pdrX: 9, pdrY: 7.5, fusedX: 9, fusedY: 7.5, confidence: 0 });
  const trailRef      = useRef([]);
  const debugRef      = useRef({});

  // ─── Config refs (always up-to-date without recreating effects) ───────────
  const configRef = useRef(config);
  useEffect(() => { configRef.current = config; }, [config]);

  // ─── BLE Manager init ──────────────────────────────────────────────────────
  useEffect(() => {
    const mgr = getBleManager();
    managerRef.current = mgr;

    if (!mgr) {
      setIsExpoGoMode(true);
      setBluetoothStatus("Expo Go / Simulated");
      return;
    }

    let sub;
    try {
      sub = mgr.onStateChange(state => {
        setBluetoothStatus(state);
        if (state === "PoweredOff" && isScanningRef.current) stopScan();
      }, true);
    } catch (e) { /* ignore */ }

    return () => { sub?.remove?.(); };
  }, []);

  // ─── Register PDR step callback ───────────────────────────────────────────
  useEffect(() => {
    if (!pdrStepCallbackRef) return;
    // Parent calls pdrStepCallbackRef.current({ stepLengthMeters, heading })
    pdrStepCallbackRef.current = ({ stepLengthMeters, heading }) => {
      if (modulStateRef.current !== "POSITIONING") return;
      const stepFt = stepLengthMeters * 3.28084;
      const rad    = (heading * Math.PI) / 180;
      const dx     = stepFt * Math.sin(rad);
      const dy     = stepFt * Math.cos(rad);

      // Update PDR position
      const old = pdrPosRef.current;
      pdrPosRef.current = clampToRoom(old.x + dx, old.y + dy);

      // Kalman prediction
      kalmanRef.current.predict(dx, dy);
    };

    return () => { if (pdrStepCallbackRef) pdrStepCallbackRef.current = null; };
  }, []);

  // ─── SCAN FUNCTIONS ────────────────────────────────────────────────────────
  const startScan = useCallback(async () => {
    if (isScanningRef.current) return;

    // Permissions
    const granted = await requestBluetoothPermissions();
    if (!granted) return;

    const mgr = managerRef.current;

    if (!mgr) {
      // Expo Go simulation — start silently, don't override module state
      setIsExpoGoMode(true);
      _startSimulatedScan();
      isScanningRef.current = true;
      setIsScanning(true);
      return;
    }

    await ensureBluetoothEnabled();

    isScanningRef.current = true;
    setIsScanning(true);
    // Note: do NOT call _setModuleState here — state is controlled by stage flow

    try {
      mgr.startDeviceScan(null, { allowDuplicates: true }, (error, device) => {
        if (error || !device) return;
        const now   = Date.now();
        const rssi  = device.rssi ?? null;
        const id    = device.id;
        const name  = device.name || device.localName || "";

        // Store device meta
        deviceMetaRef.current[id] = {
          id,
          name: name || `Unknown (${id.slice(-5)})`,
          rssi,
          lastSeen: now,
        };

        // Route to selected beacon pipelines
        const cfg = configRef.current;
        if (cfg.beacon1Id && id === cfg.beacon1Id && rssi !== null) {
          pipeline1Ref.current.addPacket(rssi, now);
        }
        if (cfg.beacon2Id && id === cfg.beacon2Id && rssi !== null) {
          pipeline2Ref.current.addPacket(rssi, now);
        }
      });
    } catch (e) {
      console.warn("[useTwoBeaconPositioning] scan error:", e);
    }
  }, []);

  const stopScan = useCallback(() => {
    if (!isScanningRef.current) return;
    isScanningRef.current = false;
    setIsScanning(false);

    const mgr = managerRef.current;
    try { mgr?.stopDeviceScan?.(); } catch (e) { /* ignore */ }

    if (simIntervalRef.current) {
      clearInterval(simIntervalRef.current);
      simIntervalRef.current = null;
    }
  }, []);

  // ─── SIMULATED SCAN (Expo Go) ─────────────────────────────────────────────
  function _startSimulatedScan() {
    if (simIntervalRef.current) return;
    const simDevices = [
      { id: "SIM:AA:BB:CC:DD:01", name: "Galaxy Buds (Sim B1)" },
      { id: "SIM:AA:BB:CC:DD:02", name: "Earbud Right (Sim B2)" },
      { id: "SIM:AA:BB:CC:DD:03", name: "Unknown BLE Device" },
    ];

    simIntervalRef.current = setInterval(() => {
      const now = Date.now();
      simDevices.forEach(d => {
        const rssi = -60 + Math.floor(Math.random() * 20) - 10;
        deviceMetaRef.current[d.id] = { id: d.id, name: d.name, rssi, lastSeen: now };
        const cfg = configRef.current;
        if (cfg.beacon1Id === d.id) pipeline1Ref.current.addPacket(rssi, now);
        if (cfg.beacon2Id === d.id) pipeline2Ref.current.addPacket(rssi, now);
      });
    }, 500);
  }

  // ─── UI UPDATE LOOP ────────────────────────────────────────────────────────
  useEffect(() => {
    const uiInterval = setInterval(() => {
      // Always update device list (for stage 1 scanner)
      const meta = deviceMetaRef.current;
      if (Object.keys(meta).length > 0) {
        const now = Date.now();
        const updated = {};
        Object.values(meta).forEach(d => {
          updated[d.id] = { ...d, ageMsAgo: now - (d.lastSeen || now) };
        });
        setDevices(updated);
      }

      // Position state (when active or paused)
      const ms = modulStateRef.current;
      if (ms === "POSITIONING" || ms === "PAUSED") {
        setPositionState({ ...positionRef.current, timestamp: Date.now() });
        setTrail([...trailRef.current]);
        setDebugInfo({ ...debugRef.current });
      }
    }, UI_INTERVAL_MS);

    return () => clearInterval(uiInterval);
  }, []);

  // ─── CALCULATION LOOP ──────────────────────────────────────────────────────
  function _startCalcLoop() {
    if (calcIntervalRef.current) return;
    calcIntervalRef.current = setInterval(() => {
      _runPositionCalculation();
    }, CALC_INTERVAL_MS);
  }

  function _stopCalcLoop() {
    if (calcIntervalRef.current) {
      clearInterval(calcIntervalRef.current);
      calcIntervalRef.current = null;
    }
  }

  function _runPositionCalculation() {
    const cfg = configRef.current;
    const now = Date.now();

    // Get pipeline states
    const s1 = pipeline1Ref.current.getState();
    const s2 = pipeline2Ref.current.getState();

    // Distances (feet)
    let d1 = rssiToDistance(s1.filteredRssi, cfg.beacon1TxPower, cfg.pathLossN);
    let d2 = rssiToDistance(s2.filteredRssi, cfg.beacon2TxPower, cfg.pathLossN);

    // Height correction
    let hv1 = 1, hv2 = 1;
    if (cfg.heightCorrectionOn) {
      const hc1 = applyHeightCorrection(d1, cfg.beacon1HeightFt, cfg.phoneHeightFt);
      const hc2 = applyHeightCorrection(d2, cfg.beacon2HeightFt, cfg.phoneHeightFt);
      d1 = hc1.correctedDist; hv1 = hc1.heightValidity;
      d2 = hc2.correctedDist; hv2 = hc2.heightValidity;
    }

    const prevFused = prevFusedRef.current;

    // Raw BLE estimate (for motion consistency scoring)
    const rawBle = solveTwoBeaconPosition(
      { x: cfg.beacon1X, y: cfg.beacon1Y },
      { x: cfg.beacon2X, y: cfg.beacon2Y },
      d1, d2, 0.5, 0.5,
      prevFused.x, prevFused.y,
    );

    // Compute weights
    const age1 = s1.lastSeen ? now - s1.lastSeen : 9999;
    const age2 = s2.lastSeen ? now - s2.lastSeen : 9999;

    const w1 = computeWeight({
      rssiBuffer:         pipeline1Ref.current.buffer,
      filteredRssi:       s1.filteredRssi,
      lastSeenMs:         age1,
      distanceFt:         d1,
      prevDistanceFt:     prevDist1Ref.current,
      prevPosition:       prevFused,
      blePosition:        rawBle,
      heightValidity:     hv1,
      heightCorrectionOn: cfg.heightCorrectionOn,
    });

    const w2 = computeWeight({
      rssiBuffer:         pipeline2Ref.current.buffer,
      filteredRssi:       s2.filteredRssi,
      lastSeenMs:         age2,
      distanceFt:         d2,
      prevDistanceFt:     prevDist2Ref.current,
      prevPosition:       prevFused,
      blePosition:        rawBle,
      heightValidity:     hv2,
      heightCorrectionOn: cfg.heightCorrectionOn,
    });

    // Solve final BLE position with proper weights
    const bleSol = solveTwoBeaconPosition(
      { x: cfg.beacon1X, y: cfg.beacon1Y },
      { x: cfg.beacon2X, y: cfg.beacon2Y },
      d1, d2, w1, w2,
      prevFused.x, prevFused.y,
    );

    // Sanity check — reject teleport
    const dtMs = now - lastCalcTime.current;
    const sane = isSaneMovement(prevFused.x, prevFused.y, bleSol.x, bleSol.y, dtMs);
    lastCalcTime.current = now;

    let effectiveConf = bleSol.confidence;
    if (!sane) effectiveConf *= 0.1;

    // Kalman update with BLE
    kalmanRef.current.update(bleSol.x, bleSol.y, effectiveConf);

    const fused = kalmanRef.current.getPosition();
    const pdr   = pdrPosRef.current;

    // Trail update
    const trail = trailRef.current;
    trail.push({ x: fused.x, y: fused.y });
    if (trail.length > MAX_TRAIL_POINTS) trail.shift();

    // Store refs
    prevFusedRef.current = fused;
    prevBle1Ref.current  = { x: bleSol.x, y: bleSol.y };
    prevDist1Ref.current = d1;
    prevDist2Ref.current = d2;

    // Update position ref (UI loop reads this)
    positionRef.current = {
      bleX:       bleSol.x,
      bleY:       bleSol.y,
      pdrX:       pdr.x,
      pdrY:       pdr.y,
      fusedX:     fused.x,
      fusedY:     fused.y,
      confidence: effectiveConf,
    };

    // Debug ref
    debugRef.current = {
      b1: { rawRssi: s1.rawRssi, filteredRssi: s1.filteredRssi, distanceFt: d1, weight: w1 },
      b2: { rawRssi: s2.rawRssi, filteredRssi: s2.filteredRssi, distanceFt: d2, weight: w2 },
      bleX: bleSol.x, bleY: bleSol.y,
      pdrX: pdr.x,    pdrY: pdr.y,
      fusedX: fused.x, fusedY: fused.y,
      confidence: effectiveConf,
      b1Available: s1.filteredRssi !== null && age1 < 2000,
      b2Available: s2.filteredRssi !== null && age2 < 2000,
    };
  }

  // ─── STATE MACHINE HELPER ──────────────────────────────────────────────────
  function _setModuleState(newState) {
    modulStateRef.current = newState;
    setModuleState(newState);
  }

  // ─── ACTIONS ───────────────────────────────────────────────────────────────
  const actions = {
    startScan,
    stopScan,

    startPositioning: () => {
      if (modulStateRef.current === "POSITIONING") return;
      // Initialise Kalman between the two beacons
      const cx = (configRef.current.beacon1X + configRef.current.beacon2X) / 2;
      const cy = (configRef.current.beacon1Y + configRef.current.beacon2Y) / 2;
      kalmanRef.current.reset(cx, cy);
      pdrPosRef.current    = { x: cx, y: cy };
      prevFusedRef.current = { x: cx, y: cy };
      trailRef.current     = [{ x: cx, y: cy }];
      lastCalcTime.current = Date.now();

      // Push initial position immediately so the map dot appears right away
      positionRef.current = { bleX: cx, bleY: cy, pdrX: cx, pdrY: cy, fusedX: cx, fusedY: cy, confidence: 0 };
      setPositionState({ ...positionRef.current, timestamp: Date.now() });
      setTrail([{ x: cx, y: cy }]);

      if (!isScanningRef.current) startScan();
      _startCalcLoop();
      _setModuleState("POSITIONING");
    },

    pausePositioning: () => {
      _stopCalcLoop();
      _setModuleState("PAUSED");
    },

    resumePositioning: () => {
      _startCalcLoop();
      _setModuleState("POSITIONING");
    },

    stopPositioning: () => {
      _stopCalcLoop();
      stopScan();
      _setModuleState("STOPPED");
    },

    resetPosition: () => {
      kalmanRef.current.reset(9, 7.5);
      pdrPosRef.current    = { x: 9, y: 7.5 };
      prevFusedRef.current = { x: 9, y: 7.5 };
      trailRef.current     = [];
      positionRef.current  = { bleX: 9, bleY: 7.5, pdrX: 9, pdrY: 7.5, fusedX: 9, fusedY: 7.5, confidence: 0 };
    },

    clearTrail: () => { trailRef.current = []; setTrail([]); },

    resetPipelines: () => {
      pipeline1Ref.current.reset();
      pipeline2Ref.current.reset();
    },

    getCalibrationPipeline: (beaconNum) => {
      return beaconNum === 1 ? pipeline1Ref.current : pipeline2Ref.current;
    },

    advanceToBeaconsSelected: () => _setModuleState("BEACONS_SELECTED"),
    advanceToPlacement:       () => _setModuleState("PLACEMENT_CONFIGURED"),
    advanceToCalibrated:      () => _setModuleState("CALIBRATED"),
  };

  // ─── Cleanup on unmount ───────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      stopScan();
      _stopCalcLoop();
      if (uiIntervalRef.current) clearInterval(uiIntervalRef.current);
    };
  }, []);

  return {
    // State
    isScanning,
    isExpoGoMode,
    bluetoothStatus,
    devices,          // all scanned devices for display
    moduleState,
    positionState,
    trail,
    debugInfo,
    // Actions
    actions,
  };
}
