import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  SafeAreaView,
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  Alert,
  Dimensions,
  PermissionsAndroid,
  Platform
} from "react-native";
import Svg, { Polyline, Circle, Line, Polygon, Text as SvgText, Rect } from "react-native-svg";
import { Pedometer, DeviceMotion, Accelerometer, Magnetometer } from "expo-sensors";
import { getSavedPaths, savePath, deleteSavedPath, clearAllSavedPaths } from "./PathStorage.js";
import BleScannerSection from "./components/BleScannerSection.js";
import OtaUpdateCard from "./components/OtaUpdateCard.js";

// Helper angle utilities
const norm = d => {
  if (typeof d !== "number" || isNaN(d)) return 0;
  let x = d % 360;
  if (x < 0) x += 360;
  return x;
};

const radToDeg = r => (r * 180) / Math.PI;

// Sensitivity presets for peak-valley step detection (in g)
const SENSITIVITY_PRESETS = {
  high: { peak: 0.09, valley: -0.05, minDelay: 260, label: "High" },
  medium: { peak: 0.13, valley: -0.07, minDelay: 290, label: "Medium (Default)" },
  low: { peak: 0.18, valley: -0.10, minDelay: 330, label: "Low" }
};

const WEINBERG_K = 0.74; // Calibrated for acceleration in g units
const LPF_HEADING = 0.22; // Low-pass filter for heading smoothing

export default function AppAndroid() {
  const [running, setRunning] = useState(false);
  const [available, setAvailable] = useState("checking...");
  const [steps, setSteps] = useState(0);
  const [currentStepLength, setCurrentStepLength] = useState(0.70);
  const [heading, setHeading] = useState(0);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [path, setPath] = useState([{ x: 0, y: 0 }]);
  const [status, setStatus] = useState("Ready (Android)");
  const [stepSensitivity, setStepSensitivity] = useState("medium");
  const [autoStepLenEnabled, setAutoStepLenEnabled] = useState(true);
  const [fixedStepLength, setFixedStepLength] = useState(0.70);
  const [liveDynAccel, setLiveDynAccel] = useState(0);

  const [magneticField, setMagneticField] = useState({ x: 0, y: 0, z: 0, total: 0 });

  // Saved Paths state
  const [savedPaths, setSavedPaths] = useState([]);
  const [selectedPreviousPath, setSelectedPreviousPath] = useState(null);

  // Mode switch: 'pdr' | 'ble'
  const [activeTab, setActiveTab] = useState("pdr");

  // High frequency mutable state kept in refs
  const runningRef = useRef(false);
  const rawHeadingRef = useRef(0);
  const headingZeroRef = useRef(null);
  const smoothedHeadingRef = useRef(0); // in degrees [-180, 180]
  const positionRef = useRef({ x: 0, y: 0 });
  const stepLengthRef = useRef(0.70);
  const stepCountRef = useRef(0);
  const pathRef = useRef([{ x: 0, y: 0 }]);
  const hasDeviceMotionRotationRef = useRef(false);

  // Accelerometer FSM Peak-Valley Step Detector Refs
  const gravityRef = useRef(1.0);
  const filteredDynAccelRef = useRef(0);
  const stepStateRef = useRef("IDLE"); // 'IDLE' | 'PEAK_DETECTED' | 'VALLEY_DETECTED'
  const lastStepTimeRef = useRef(0);
  const stepPeakMaxRef = useRef(0);
  const stepValleyMinRef = useRef(0);
  const sensitivityRef = useRef(SENSITIVITY_PRESETS.medium);

  const magFieldRef = useRef({ x: 0, y: 0, z: 0, total: 0 });

  // Load saved paths on mount
  useEffect(() => {
    loadSavedPathsHistory();
  }, []);

  const loadSavedPathsHistory = async () => {
    const list = await getSavedPaths();
    setSavedPaths(list);
  };

  // Sync sensitivity ref when state changes
  useEffect(() => {
    sensitivityRef.current = SENSITIVITY_PRESETS[stepSensitivity] || SENSITIVITY_PRESETS.medium;
  }, [stepSensitivity]);

  // Heading calculation helper that works for both DeviceMotion and Magnetometer
  const updateHeadingFromRaw = useCallback((rawDeg) => {
    if (typeof rawDeg !== "number" || isNaN(rawDeg)) return;
    rawHeadingRef.current = rawDeg;

    if (headingZeroRef.current === null) return;

    // Delta relative to zero calibration
    const deltaRaw = norm(headingZeroRef.current - rawDeg);
    const targetHeading = deltaRaw > 180 ? deltaRaw - 360 : deltaRaw;
    if (isNaN(targetHeading)) return;

    let current = smoothedHeadingRef.current;
    if (!isFinite(current)) current = 0;

    let diff = targetHeading - current;
    while (diff > 180) diff -= 360;
    while (diff < -180) diff += 360;

    let updated = current + LPF_HEADING * diff;
    if (updated > 180) updated -= 360;
    if (updated < -180) updated += 360;

    smoothedHeadingRef.current = Number(updated.toFixed(2));
  }, []);

  // --------------------------------------------------------------------------
  // Core Step Registration Function (Bulletproof against NaN)
  // --------------------------------------------------------------------------
  const recordStep = useCallback((dynamicLen = null) => {
    let len = fixedStepLength;
    if (autoStepLenEnabled && typeof dynamicLen === "number" && isFinite(dynamicLen) && dynamicLen >= 0.45 && dynamicLen <= 1.15) {
      len = dynamicLen;
    }
    if (!isFinite(len) || len <= 0) len = 0.70;

    stepLengthRef.current = len;

    let thetaDeg = smoothedHeadingRef.current;
    if (!isFinite(thetaDeg)) thetaDeg = 0;

    const thetaRad = (thetaDeg * Math.PI) / 180;
    const old = positionRef.current || { x: 0, y: 0 };
    const oldX = isFinite(old.x) ? old.x : 0;
    const oldY = isFinite(old.y) ? old.y : 0;

    // Standard Cartesian navigation frame:
    // Heading 0 deg = +Y (Forward/North)
    // Heading +90 deg = +X (Right/East)
    // Heading -90 deg = -X (Left/West)
    // Heading 180 deg = -Y (Backward/South)
    const nextX = Number((oldX + len * Math.sin(thetaRad)).toFixed(3));
    const nextY = Number((oldY + len * Math.cos(thetaRad)).toFixed(3));

    const next = {
      x: isFinite(nextX) ? nextX : oldX,
      y: isFinite(nextY) ? nextY : oldY
    };

    positionRef.current = next;
    stepCountRef.current = (stepCountRef.current || 0) + 1;
    const count = stepCountRef.current;

    const updatedPath = [...pathRef.current, next];
    pathRef.current = updatedPath;

    setPosition(next);
    setSteps(count);
    setCurrentStepLength(len);
    setPath(updatedPath);

    console.log(`[Android PDR Step #${count}] SL=${len.toFixed(2)}m | Heading=${thetaDeg.toFixed(1)}° | Pos=(${next.x}, ${next.y}) | PathPts=${updatedPath.length}`);
  }, [autoStepLenEnabled, fixedStepLength]);

  // Weinberg step length estimator based on vertical acceleration bounce
  const computeWeinbergLength = useCallback((maxA, minA) => {
    if (!isFinite(maxA) || !isFinite(minA)) return 0.70;
    const bounceDiff = Math.max(0.12, maxA - minA);
    const estimated = WEINBERG_K * Math.pow(bounceDiff, 0.25);
    if (!isFinite(estimated)) return 0.70;
    return Number(Math.min(1.10, Math.max(0.48, estimated)).toFixed(2));
  }, []);

  // --------------------------------------------------------------------------
  // Throttled UI State Sync Loop (100ms) - Keeps React rendering smooth at 10Hz
  // --------------------------------------------------------------------------
  useEffect(() => {
    const uiSyncTimer = setInterval(() => {
      const curHeading = isFinite(smoothedHeadingRef.current) ? smoothedHeadingRef.current : 0;
      setHeading(curHeading);
      setMagneticField(magFieldRef.current);
      setLiveDynAccel(Number((filteredDynAccelRef.current || 0).toFixed(3)));
    }, 100);
    return () => clearInterval(uiSyncTimer);
  }, []);

  // --------------------------------------------------------------------------
  // Hardware Sensor Subscriptions
  // --------------------------------------------------------------------------
  useEffect(() => {
    let motionSub, pedSub, accelSub, magSub;
    let isMounted = true;

    (async () => {
      try {
        // Request Android Activity Recognition runtime permission
        if (Platform.OS === "android" && Platform.Version >= 29) {
          try {
            await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACTIVITY_RECOGNITION);
          } catch (pe) {
            console.warn("Activity recognition permission error:", pe);
          }
        }

        const [pAvail, mAvail, magAvail] = await Promise.all([
          Pedometer.isAvailableAsync().catch(() => false),
          DeviceMotion.isAvailableAsync().catch(() => false),
          Magnetometer.isAvailableAsync().catch(() => false)
        ]);

        if (!isMounted) return;

        setAvailable(`Motion: ${mAvail ? "✓" : "✗"} | Mag: ${magAvail ? "✓" : "✗"} | Pedometer: ${pAvail ? "✓" : "✗"}`);

        if (mAvail) await DeviceMotion.requestPermissionsAsync().catch(() => {});
        if (magAvail) await Magnetometer.requestPermissionsAsync().catch(() => {});
        if (pAvail) await Pedometer.requestPermissionsAsync().catch(() => {});

        // 1. Magnetometer Listener (40ms = 25Hz)
        Magnetometer.setUpdateInterval(40);
        magSub = Magnetometer.addListener(data => {
          if (!data) return;
          const { x, y, z } = data;
          if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") return;

          const totalField = Math.sqrt(x * x + y * y + z * z);
          magFieldRef.current = {
            x: Number(x.toFixed(1)),
            y: Number(y.toFixed(1)),
            z: Number(z.toFixed(1)),
            total: Number((isFinite(totalField) ? totalField : 0).toFixed(1))
          };

          // Compute 2D Compass Azimuth
          let compassDeg = Math.atan2(-x, y) * (180 / Math.PI);
          if (isNaN(compassDeg)) compassDeg = 0;
          compassDeg = norm(compassDeg);

          // If DeviceMotion rotation is not available or not active, use Magnetometer
          if (!hasDeviceMotionRotationRef.current) {
            updateHeadingFromRaw(compassDeg);
          }
        });

        // 2. DeviceMotion / Orientation Listener (40ms = 25Hz)
        DeviceMotion.setUpdateInterval(40);
        motionSub = DeviceMotion.addListener(data => {
          if (!data) return;

          if (data.rotation && typeof data.rotation.alpha === "number" && isFinite(data.rotation.alpha)) {
            hasDeviceMotionRotationRef.current = true;
            const alpha = data.rotation.alpha;
            let rawDeg = Math.abs(alpha) <= Math.PI * 2.2 ? radToDeg(alpha) : alpha;
            if (isNaN(rawDeg)) return;
            rawDeg = norm(rawDeg);
            updateHeadingFromRaw(rawDeg);
          }
        });

        // 3. Real-Time High-Precision Accelerometer Peak-Valley Step Detector (20ms = 50Hz)
        Accelerometer.setUpdateInterval(20);
        accelSub = Accelerometer.addListener(data => {
          if (!data) return;
          const { x, y, z } = data;
          if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") return;

          const rawMag = Math.sqrt(x * x + y * y + z * z); // in g
          if (!isFinite(rawMag)) return;

          // Update dynamic gravity baseline (low-pass filter)
          gravityRef.current = 0.95 * gravityRef.current + 0.05 * rawMag;
          const dynAccel = rawMag - gravityRef.current;

          // Filter dynamic acceleration to eliminate high-frequency jitter
          filteredDynAccelRef.current += 0.35 * (dynAccel - filteredDynAccelRef.current);
          const filtered = filteredDynAccelRef.current;

          if (!runningRef.current) return;

          const now = Date.now();
          const cfg = sensitivityRef.current;

          // Finite State Machine for Step Detection
          if (stepStateRef.current === "IDLE") {
            if (filtered > cfg.peak && (now - lastStepTimeRef.current) > cfg.minDelay) {
              stepStateRef.current = "PEAK_DETECTED";
              stepPeakMaxRef.current = rawMag;
              stepValleyMinRef.current = rawMag;
            }
          } else if (stepStateRef.current === "PEAK_DETECTED") {
            if (rawMag > stepPeakMaxRef.current) {
              stepPeakMaxRef.current = rawMag;
            }
            if (filtered < cfg.valley) {
              stepStateRef.current = "VALLEY_DETECTED";
              stepValleyMinRef.current = rawMag;
            }
          } else if (stepStateRef.current === "VALLEY_DETECTED") {
            if (rawMag < stepValleyMinRef.current) {
              stepValleyMinRef.current = rawMag;
            }
            if (filtered > -0.02) {
              const dt = now - lastStepTimeRef.current;
              if (dt >= cfg.minDelay && dt <= 1400) {
                lastStepTimeRef.current = now;
                const autoLen = computeWeinbergLength(stepPeakMaxRef.current, stepValleyMinRef.current);
                recordStep(autoLen);
              }
              stepStateRef.current = "IDLE";
            }
          }
        });

      } catch (e) {
        if (isMounted) {
          setStatus("Android Sensor error: " + (e?.message || String(e)));
        }
      }
    })();

    return () => {
      isMounted = false;
      motionSub?.remove?.();
      pedSub?.remove?.();
      accelSub?.remove?.();
      magSub?.remove?.();
    };
  }, [recordStep, computeWeinbergLength, updateHeadingFromRaw]);

  // --------------------------------------------------------------------------
  // User Actions & Controls
  // --------------------------------------------------------------------------
  const setZero = () => {
    const raw = isFinite(rawHeadingRef.current) ? rawHeadingRef.current : 0;
    headingZeroRef.current = raw;
    smoothedHeadingRef.current = 0;
    setHeading(0);
    setStatus("Heading zero calibrated (Forward = 0°)");
  };

  const start = () => {
    if (headingZeroRef.current === null) {
      const raw = isFinite(rawHeadingRef.current) ? rawHeadingRef.current : 0;
      headingZeroRef.current = raw;
      smoothedHeadingRef.current = 0;
      setHeading(0);
    }
    runningRef.current = true;
    setRunning(true);
    setStatus("Recording Android PDR path...");
  };

  const stop = () => {
    runningRef.current = false;
    setRunning(false);
    setStatus("Tracking paused");
  };

  const reset = () => {
    runningRef.current = false;
    setRunning(false);
    stepCountRef.current = 0;
    setSteps(0);
    positionRef.current = { x: 0, y: 0 };
    pathRef.current = [{ x: 0, y: 0 }];
    setPosition({ x: 0, y: 0 });
    setPath([{ x: 0, y: 0 }]);
    stepStateRef.current = "IDLE";
    setStatus("Reset to origin (0,0)");
  };

  const closeLoop = () => {
    const curPath = pathRef.current;
    if (!curPath || curPath.length <= 2) {
      Alert.alert("Loop Closure Error", "Walk a closed loop path before applying loop closure.");
      return;
    }
    const lastPt = curPath[curPath.length - 1];
    const totalSteps = curPath.length - 1;
    const dx = lastPt.x / totalSteps;
    const dy = lastPt.y / totalSteps;

    const correctedPath = curPath.map((pt, i) => ({
      x: Number((pt.x - dx * i).toFixed(3)),
      y: Number((pt.y - dy * i).toFixed(3))
    }));

    const finalPos = correctedPath[correctedPath.length - 1];
    positionRef.current = finalPos;
    pathRef.current = correctedPath;
    setPosition(finalPos);
    setPath(correctedPath);
    setStatus("Loop Closure Applied! Drift eliminated.");
    Alert.alert("Android Loop Closure", `Corrected drift of X: ${lastPt.x.toFixed(2)}m, Y: ${lastPt.y.toFixed(2)}m back to origin.`);
  };

  const handleSavePath = async () => {
    if (path.length <= 1 && steps === 0) {
      Alert.alert("Cannot Save Path", "Walk a path first before saving.");
      return;
    }
    const totalDist = steps * currentStepLength;
    try {
      const updated = await savePath({
        steps,
        distance: totalDist,
        points: path
      });
      setSavedPaths(updated);
      setStatus(`Path saved! (${steps} steps, ${totalDist.toFixed(2)}m)`);
      Alert.alert("Path Saved", `Successfully saved route with ${steps} steps and ${path.length} waypoints.`);
    } catch (e) {
      Alert.alert("Save Error", "Failed to save path to storage.");
    }
  };

  const handleTogglePreviousPath = (item) => {
    if (selectedPreviousPath?.id === item.id) {
      setSelectedPreviousPath(null);
      setStatus("Removed previous path overlay");
    } else {
      setSelectedPreviousPath(item);
      setStatus(`Overlaying saved path: "${item.name}"`);
    }
  };

  const handleDeletePath = async (id) => {
    Alert.alert("Delete Saved Path", "Are you sure you want to delete this saved path?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          const updated = await deleteSavedPath(id);
          setSavedPaths(updated);
          if (selectedPreviousPath?.id === id) setSelectedPreviousPath(null);
          setStatus("Saved path deleted.");
        }
      }
    ]);
  };

  const handleClearAllPaths = async () => {
    Alert.alert("Clear All Saved Paths", "Are you sure you want to delete all saved path history?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Clear All",
        style: "destructive",
        onPress: async () => {
          const updated = await clearAllSavedPaths();
          setSavedPaths(updated);
          setSelectedPreviousPath(null);
          setStatus("All saved paths cleared.");
        }
      }
    ]);
  };

  const dist = steps * currentStepLength;

  return (
    <SafeAreaView style={s.safe}>
      <ScrollView contentContainerStyle={s.container}>
        <Text style={s.title}>Indoor PDR Navigation</Text>
        <Text style={s.sub}>Real-Time FSM Peak-Valley Detector • Smooth Dead Reckoning</Text>

        {/* Section Switcher Tabs */}
        <View style={s.tabContainer}>
          <Pressable
            onPress={() => setActiveTab("pdr")}
            style={[s.tabBtn, activeTab === "pdr" && s.tabBtnActive]}
          >
            <Text style={[s.tabBtnText, activeTab === "pdr" && s.tabBtnTextActive]}>
              🚶 PDR Step Tracking
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setActiveTab("ble")}
            style={[s.tabBtn, activeTab === "ble" && s.tabBtnActive]}
          >
            <Text style={[s.tabBtnText, activeTab === "ble" && s.tabBtnTextActive]}>
              📶 BLE Beacon Scanner
            </Text>
          </Pressable>
        </View>

        {activeTab === "ble" ? (
          <BleScannerSection />
        ) : (
          <>
            <View style={s.card}>
              <Text style={s.label}>Hardware Sensors Status</Text>
              <Text style={s.sensorAvailText}>{available}</Text>
              <Text style={s.status}>{status}</Text>
            </View>

            <View style={s.row}>
              <Metric label="Steps" value={String(steps)} highlight />
              <Metric label="Heading" value={`${heading >= 0 ? "+" : ""}${heading.toFixed(1)}°`} highlight />
            </View>

            <View style={s.row}>
              <Metric label="X Position" value={`${position.x.toFixed(2)} m`} />
              <Metric label="Y Position" value={`${position.y.toFixed(2)} m`} />
            </View>

            <View style={s.row}>
              <Metric label="Total Distance" value={`${dist.toFixed(2)} m`} />
              <Metric label="Step Length" value={`${currentStepLength.toFixed(2)} m`} />
            </View>

            {/* Sensitivity & Step Length Settings */}
            <View style={s.card}>
              <Text style={s.label}>Step Detection Sensitivity</Text>
              <View style={s.sensitivityRow}>
                {["high", "medium", "low"].map((mode) => (
                  <Pressable
                    key={mode}
                    onPress={() => setStepSensitivity(mode)}
                    style={[s.sensBtn, stepSensitivity === mode && s.sensBtnActive]}
                  >
                    <Text style={[s.sensBtnText, stepSensitivity === mode && s.sensBtnTextActive]}>
                      {SENSITIVITY_PRESETS[mode].label}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
                <Text style={{ fontSize: 12, color: "#57606a" }}>
                  Live Accel Dyn: <Text style={{ fontFamily: "monospace", fontWeight: "700", color: "#1f6feb" }}>{liveDynAccel > 0 ? `+${liveDynAccel}` : liveDynAccel}g</Text>
                </Text>
                <Pressable
                  onPress={() => setAutoStepLenEnabled(!autoStepLenEnabled)}
                  style={[s.toggleBtn, autoStepLenEnabled ? s.toggleBtnOn : s.toggleBtnOff]}
                >
                  <Text style={[s.toggleBtnText, autoStepLenEnabled && { color: "white" }]}>
                    {autoStepLenEnabled ? "Auto Weinberg SL: ON" : "Fixed SL: 0.70m"}
                  </Text>
                </Pressable>
              </View>
            </View>

            {/* 2D Path Map with Live Orientation Arrow */}
            <PathPlot points={path} heading={heading} previousPath={selectedPreviousPath} />

            {/* Main Action Buttons */}
            <View style={s.row}>
              <Btn text="Set Heading Zero" onPress={setZero} />
              <Btn text={running ? "Stop" : "Start Tracking"} onPress={running ? stop : start} strong />
            </View>

            <View style={s.row}>
              <Btn text="Save Path" onPress={handleSavePath} bg="#1a7f37" color="white" />
              <Btn text="Close Loop" onPress={closeLoop} />
              <Btn text="Reset Path" onPress={reset} />
            </View>

            {/* Magnetic Field Diagnostics */}
            <View style={s.card}>
              <Text style={s.label}>Magnetometer Flux (μT)</Text>
              <View style={s.row}>
                <Metric label="Total B-Field" value={`${magneticField.total} μT`} />
              </View>
              <View style={{ marginTop: 6 }}>
                <Metric label="Vector (X, Y, Z)" value={`X: ${magneticField.x} | Y: ${magneticField.y} | Z: ${magneticField.z}`} fullWidth />
              </View>
            </View>

            {/* Live Waypoints List */}
            <View style={s.card}>
              <Text style={s.label}>Live Waypoints History ({path.length} pts)</Text>
              <ScrollView style={{ maxHeight: 120 }}>
                {path.map((pt, idx) => (
                  <Text key={idx} style={{ fontFamily: "monospace", fontSize: 12, color: idx === path.length - 1 ? "#1f6feb" : "#57606a", paddingVertical: 1 }}>
                    #{idx}: X={pt.x.toFixed(2)}m, Y={pt.y.toFixed(2)}m {idx === 0 ? "(START)" : idx === path.length - 1 ? "(NOW)" : ""}
                  </Text>
                ))}
              </ScrollView>
            </View>

            {/* Saved Paths History Card */}
            <View style={s.card}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <Text style={s.label}>Saved Paths History ({savedPaths.length})</Text>
                {savedPaths.length > 0 && (
                  <Pressable onPress={handleClearAllPaths} style={s.clearBtn}>
                    <Text style={s.clearBtnText}>Clear All</Text>
                  </Pressable>
                )}
              </View>
              {savedPaths.length === 0 ? (
                <Text style={{ color: "#57606a", fontSize: 13, fontStyle: "italic" }}>
                  No saved paths yet. Walk a route and tap "Save Path" to store it here.
                </Text>
              ) : (
                <ScrollView style={{ maxHeight: 200 }}>
                  {savedPaths.map((item) => {
                    const isSelected = selectedPreviousPath?.id === item.id;
                    return (
                      <View key={item.id} style={[s.savedItem, isSelected && s.savedItemSelected]}>
                        <View style={{ flex: 1, paddingRight: 8 }}>
                          <Text style={s.savedTitle}>{item.name}</Text>
                          <Text style={s.savedMeta}>{item.timestamp}</Text>
                          <Text style={s.savedMetaSub}>{item.steps} steps • {item.distance.toFixed(2)}m • {item.points?.length || 0} pts</Text>
                        </View>
                        <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
                          <Pressable
                            onPress={() => handleTogglePreviousPath(item)}
                            style={[s.actionBtn, isSelected ? s.actionBtnActive : s.actionBtnOutline]}
                          >
                            <Text style={[s.actionBtnText, isSelected && { color: "white" }]}>
                              {isSelected ? "Hide" : "Show Map"}
                            </Text>
                          </Pressable>
                          <Pressable
                            onPress={() => handleDeletePath(item.id)}
                            style={[s.actionBtn, s.actionBtnDanger]}
                          >
                            <Text style={[s.actionBtnText, { color: "#cf222e" }]}>Delete</Text>
                          </Pressable>
                        </View>
                      </View>
                    );
                  })}
                </ScrollView>
              )}
            </View>

            <View style={s.card}>
              <Text style={s.label}>Android Guide</Text>
              <Text style={s.help}>
                • Hold phone flat, top of phone pointed forward in the direction you are walking.{"\n"}
                • Tap "Set Heading Zero" while facing forward, then tap "Start Tracking".{"\n"}
                • Accelerometer FSM will register each step dynamically without pedometer lag.
              </Text>
            </View>
          </>
        )}

        {/* Global App-Level OTA Updates */}
        <OtaUpdateCard />
      </ScrollView>
    </SafeAreaView>
  );
}

function Metric({ label, value, fullWidth, highlight }) {
  return (
    <View style={[s.metric, fullWidth && { flex: undefined, width: "100%" }, highlight && s.metricHighlight]}>
      <Text style={s.metricLabel}>{label}</Text>
      <Text style={[s.metricValue, highlight && { color: "#0969da" }]}>{value}</Text>
    </View>
  );
}

function Btn({ text, onPress, strong, bg, color }) {
  return (
    <Pressable onPress={onPress} style={[s.btn, strong && s.btnStrong, bg ? { backgroundColor: bg, borderColor: bg } : null]}>
      <Text style={[s.btnText, strong && { color: "white" }, color ? { color } : null]}>{text}</Text>
    </Pressable>
  );
}

function PathPlot({ points, heading, previousPath }) {
  const screenWidth = Dimensions.get("window").width;
  const width = Math.max(280, Math.min(screenWidth - 32, 520));
  const height = 340;
  const pad = 40;

  // Filter valid points only
  const validPoints = (Array.isArray(points) ? points : [{ x: 0, y: 0 }])
    .filter(p => p && typeof p.x === "number" && typeof p.y === "number" && isFinite(p.x) && isFinite(p.y));
  const pts = validPoints.length > 0 ? validPoints : [{ x: 0, y: 0 }];

  const validPrevPoints = (previousPath?.points && Array.isArray(previousPath.points) ? previousPath.points : [])
    .filter(p => p && typeof p.x === "number" && typeof p.y === "number" && isFinite(p.x) && isFinite(p.y));

  const allPts = [...pts, ...validPrevPoints];

  let minX = 0, maxX = 0, minY = 0, maxY = 0;
  allPts.forEach(p => {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  });

  const spanX = Math.max(3.0, (maxX - minX) * 1.25);
  const spanY = Math.max(3.0, (maxY - minY) * 1.25);
  const scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  // Map real-world Cartesian (m) to SVG Canvas (pixels)
  const map = p => {
    const px = (p && isFinite(p.x)) ? p.x : 0;
    const py = (p && isFinite(p.y)) ? p.y : 0;
    return {
      x: Number((width / 2 + (px - cx) * scale).toFixed(1)),
      y: Number((height / 2 - (py - cy) * scale).toFixed(1))
    };
  };

  const m = pts.map(map);
  const poly = m.map(p => `${p.x},${p.y}`).join(" ");
  const start = map({ x: 0, y: 0 });
  const end = m[m.length - 1] || start;

  let prevM = [], prevPoly = "", prevEnd = null;
  if (validPrevPoints.length > 0) {
    prevM = validPrevPoints.map(map);
    prevPoly = prevM.map(p => `${p.x},${p.y}`).join(" ");
    prevEnd = prevM[prevM.length - 1];
  }

  // Calculate live heading arrow points at user's current position (end)
  const safeHeading = isFinite(heading) ? heading : 0;
  const headingRad = (safeHeading * Math.PI) / 180;
  const arrowLength = 18;
  const arrowWingDist = 10;
  const arrowAngleSpread = 2.4; // radians (~137 degrees)

  const tip = {
    x: Number((end.x + arrowLength * Math.sin(headingRad)).toFixed(1)),
    y: Number((end.y - arrowLength * Math.cos(headingRad)).toFixed(1))
  };
  const leftWing = {
    x: Number((end.x + arrowWingDist * Math.sin(headingRad - arrowAngleSpread)).toFixed(1)),
    y: Number((end.y - arrowWingDist * Math.cos(headingRad - arrowAngleSpread)).toFixed(1))
  };
  const rightWing = {
    x: Number((end.x + arrowWingDist * Math.sin(headingRad + arrowAngleSpread)).toFixed(1)),
    y: Number((end.y - arrowWingDist * Math.cos(headingRad + arrowAngleSpread)).toFixed(1))
  };
  const arrowPolygon = `${tip.x},${tip.y} ${leftWing.x},${leftWing.y} ${end.x},${end.y} ${rightWing.x},${rightWing.y}`;

  const lastPt = pts[pts.length - 1] || { x: 0, y: 0 };

  return (
    <View style={s.plot}>
      <Text style={s.label}>Live PDR Walk Route Map (Android)</Text>

      {/* Map Legend */}
      <View style={s.legendRow}>
        <View style={s.legendItem}>
          <View style={[s.legendColor, { backgroundColor: "#1f6feb" }]} />
          <Text style={s.legendText}>Route ({pts.length} pts)</Text>
        </View>
        <View style={s.legendItem}>
          <View style={[s.legendColor, { backgroundColor: "#cf222e" }]} />
          <Text style={s.legendText}>Live Heading ({safeHeading.toFixed(0)}°)</Text>
        </View>
        {previousPath && (
          <View style={s.legendItem}>
            <View style={[s.legendColor, { backgroundColor: "#d97706" }]} />
            <Text style={s.legendText}>Previous Path</Text>
          </View>
        )}
      </View>

      <Svg width={width} height={height}>
        {/* Background Grid Canvas */}
        <Rect x="0" y="0" width={width} height={height} fill="#fafbfc" rx="10" />

        {/* Origin Axes Grid Lines */}
        <Line x1="0" y1={start.y} x2={width} y2={start.y} stroke="#d0d7de" strokeWidth="1" strokeDasharray="4,4" />
        <Line x1={start.x} y1="0" x2={start.x} y2={height} stroke="#d0d7de" strokeWidth="1" strokeDasharray="4,4" />

        {/* Previous Saved Path Overlay */}
        {previousPath && prevPoly.length > 0 && (
          <>
            <Polyline points={prevPoly} fill="none" stroke="#d97706" strokeWidth="3" strokeDasharray="6,4" strokeLinejoin="round" strokeLinecap="round" opacity={0.85} />
            {prevM.map((pt, i) => (
              <Circle key={`prev-${i}`} cx={pt.x} cy={pt.y} r={i === prevM.length - 1 ? 4.5 : 2.5} fill="#d97706" opacity={0.85} />
            ))}
            {prevEnd && (
              <SvgText x={prevEnd.x + 8} y={prevEnd.y - 8} fontSize="10" fontWeight="bold" fill="#b45309">
                PREV ({validPrevPoints[validPrevPoints.length - 1].x.toFixed(1)}, {validPrevPoints[validPrevPoints.length - 1].y.toFixed(1)})
              </SvgText>
            )}
          </>
        )}

        {/* Live Active Path Polyline */}
        {m.length > 1 && (
          <Polyline points={poly} fill="none" stroke="#1f6feb" strokeWidth="4" strokeLinejoin="round" strokeLinecap="round" />
        )}

        {/* Waypoint Circles */}
        {m.map((pt, i) => (
          <Circle key={`curr-${i}`} cx={pt.x} cy={pt.y} r={i === 0 ? 5 : i === m.length - 1 ? 5.5 : 3.5} fill={i === 0 ? "#1a7f37" : i === m.length - 1 ? "#1f6feb" : "#0969da"} />
        ))}

        {/* Start Position Marker */}
        <Circle cx={start.x} cy={start.y} r="6" fill="#1a7f37" stroke="#ffffff" strokeWidth="1.5" />
        <SvgText x={start.x + 8} y={start.y - 6} fontSize="11" fontWeight="bold" fill="#1a7f37">START (0,0)</SvgText>

        {/* Live Facing Direction Arrow Pointer */}
        <Polygon points={arrowPolygon} fill="#cf222e" stroke="#ffffff" strokeWidth="1" />
        <Circle cx={end.x} cy={end.y} r="5" fill="#cf222e" stroke="#ffffff" strokeWidth="1" />
        <SvgText x={end.x + 8} y={end.y + 14} fontSize="11" fontWeight="bold" fill="#cf222e">
          NOW ({lastPt.x.toFixed(1)}, {lastPt.y.toFixed(1)})
        </SvgText>
      </Svg>
    </View>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#f6f8fa" },
  container: { padding: 16, paddingBottom: 40 },
  title: { fontSize: 26, fontWeight: "800", color: "#24292f" },
  sub: { color: "#57606a", marginBottom: 12, fontSize: 13 },
  card: { backgroundColor: "white", borderRadius: 14, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: "#d0d7de" },
  plot: { backgroundColor: "white", borderRadius: 14, paddingTop: 14, marginBottom: 12, borderWidth: 1, borderColor: "#d0d7de", alignItems: "center" },
  label: { fontWeight: "700", color: "#57606a", marginBottom: 6, fontSize: 13 },
  sensorAvailText: { fontSize: 13, color: "#24292f", fontFamily: "monospace" },
  status: { marginTop: 4, color: "#0969da", fontWeight: "600", fontSize: 13 },
  row: { flexDirection: "row", gap: 10, marginBottom: 10 },
  metric: { flex: 1, backgroundColor: "white", borderRadius: 12, padding: 12, borderWidth: 1, borderColor: "#d0d7de" },
  metricHighlight: { borderColor: "#54aeff", backgroundColor: "#f0f8ff" },
  metricLabel: { fontSize: 11, color: "#57606a", fontWeight: "600" },
  metricValue: { fontSize: 20, fontWeight: "800", color: "#24292f", marginTop: 2 },
  help: { color: "#57606a", lineHeight: 19, fontSize: 12 },
  btn: { flex: 1, borderRadius: 10, paddingVertical: 12, alignItems: "center", borderWidth: 1, borderColor: "#8c959f", backgroundColor: "white" },
  btnStrong: { backgroundColor: "#1f6feb", borderColor: "#1f6feb" },
  btnText: { fontWeight: "700", fontSize: 13 },

  // Sensitivity controls
  sensitivityRow: { flexDirection: "row", gap: 8, marginTop: 4 },
  sensBtn: { flex: 1, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: "#d0d7de", alignItems: "center", backgroundColor: "#f6f8fa" },
  sensBtnActive: { backgroundColor: "#1f6feb", borderColor: "#1f6feb" },
  sensBtnText: { fontSize: 12, fontWeight: "700", color: "#57606a" },
  sensBtnTextActive: { color: "#ffffff" },
  toggleBtn: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, borderWidth: 1 },
  toggleBtnOn: { backgroundColor: "#0969da", borderColor: "#0969da" },
  toggleBtnOff: { backgroundColor: "#ffffff", borderColor: "#8c959f" },
  toggleBtnText: { fontSize: 11, fontWeight: "700", color: "#57606a" },

  // Tab switcher styles
  tabContainer: {
    flexDirection: "row",
    backgroundColor: "#e1e4e8",
    borderRadius: 12,
    padding: 4,
    marginBottom: 14,
    gap: 4
  },
  tabBtn: {
    flex: 1,
    paddingVertical: 10,
    alignItems: "center",
    borderRadius: 8
  },
  tabBtnActive: {
    backgroundColor: "#ffffff",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2
  },
  tabBtnText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#57606a"
  },
  tabBtnTextActive: {
    color: "#1f6feb"
  },

  // Legend styles
  legendRow: { flexDirection: "row", gap: 12, marginBottom: 8, marginTop: 2 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 5 },
  legendColor: { width: 12, height: 4, borderRadius: 2 },
  legendText: { fontSize: 11, color: "#57606a", fontWeight: "600" },

  // Saved Paths list styles
  clearBtn: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, backgroundColor: "#fff0f0", borderWidth: 1, borderColor: "#ffc9c9" },
  clearBtnText: { fontSize: 11, color: "#cf222e", fontWeight: "700" },
  savedItem: { flexDirection: "row", alignItems: "center", paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, borderWidth: 1, borderColor: "#e1e4e8", marginBottom: 8, backgroundColor: "#fafafa" },
  savedItemSelected: { borderColor: "#d97706", backgroundColor: "#fffbeb" },
  savedTitle: { fontWeight: "700", fontSize: 13, color: "#24292f" },
  savedMeta: { fontSize: 11, color: "#57606a", marginTop: 1 },
  savedMetaSub: { fontSize: 11, color: "#0969da", fontWeight: "600", marginTop: 1 },
  actionBtn: { paddingVertical: 5, paddingHorizontal: 8, borderRadius: 6, borderWidth: 1, alignItems: "center" },
  actionBtnOutline: { borderColor: "#1f6feb", backgroundColor: "white" },
  actionBtnActive: { backgroundColor: "#d97706", borderColor: "#d97706" },
  actionBtnDanger: { borderColor: "#ffc9c9", backgroundColor: "#fff0f0" },
  actionBtnText: { fontSize: 11, fontWeight: "700", color: "#1f6feb" }
});
