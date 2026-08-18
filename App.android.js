import React, { useEffect, useRef, useState } from "react";
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

const norm = d => {
  let x = d % 360;
  if (x < 0) x += 360;
  return x;
};

const signed = d => {
  let x = norm(d);
  if (x > 180) x -= 360;
  return x;
};

const alphaDeg = a => (Math.abs(a) <= Math.PI * 2.2 ? (a * 180) / Math.PI : a);

export default function AppAndroid() {
  const [running, setRunning] = useState(false);
  const [available, setAvailable] = useState("checking...");
  const [steps, setSteps] = useState(0);
  const [stepLength, setStepLength] = useState(0.70);
  const [heading, setHeading] = useState(0);
  const [headingZero, setHeadingZero] = useState(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [path, setPath] = useState([{ x: 0, y: 0 }]);
  const [status, setStatus] = useState("Ready (Android)");
  const [rawHeading, setRawHeading] = useState(0);
  const [isStationary, setIsStationary] = useState(true);

  const [magneticField, setMagneticField] = useState({ x: 0, y: 0, z: 0, total: 0 });

  // Saved Paths state
  const [savedPaths, setSavedPaths] = useState([]);
  const [selectedPreviousPath, setSelectedPreviousPath] = useState(null);

  // Mode switch: 'pdr' | 'ble'
  const [activeTab, setActiveTab] = useState("pdr");

  const runningRef = useRef(false);
  const headingRef = useRef(0);
  const headingZeroRef = useRef(null);
  const smoothedHeadingRef = useRef(0);
  const positionRef = useRef({ x: 0, y: 0 });
  const stepLengthRef = useRef(0.70);
  const lastStepTimeRef = useRef(0);
  const gravityRef = useRef(1.0);
  const hasMotionRotationRef = useRef(false);

  // Stationary / Zero-Velocity Update (ZUPT) & Peak-Valley Detection Refs
  const accelWindowRef = useRef([]);
  const stepPhaseRef = useRef("IDLE"); // 'IDLE' | 'RISING' | 'FALLING'
  const peakValRef = useRef(0);
  const valleyValRef = useRef(0);

  // Load saved paths on mount
  useEffect(() => {
    loadSavedPathsHistory();
  }, []);

  const loadSavedPathsHistory = async () => {
    const list = await getSavedPaths();
    setSavedPaths(list);
  };

  // Add a step and update position & path
  const addStep = (customLen = null) => {
    const len = customLen || stepLengthRef.current || 0.70;
    const curHeading = headingRef.current || 0;
    const rad = (curHeading * Math.PI) / 180;
    const old = positionRef.current;

    // Standard Navigation coordinates:
    // Heading 0° = +Y (Forward/North)
    // Heading +90° = +X (Right/East)
    // Heading -90° = -X (Left/West)
    // Heading 180° = -Y (Backward/South)
    const next = {
      x: Number((old.x + len * Math.sin(rad)).toFixed(2)),
      y: Number((old.y + len * Math.cos(rad)).toFixed(2))
    };

    positionRef.current = next;
    setPosition(next);
    setPath(p => [...p, next]);
    setSteps(s => {
      const nextCount = s + 1;
      console.log(`[PDR Step #${nextCount}] Heading: ${curHeading.toFixed(1)}° | Pos: (${next.x}, ${next.y})`);
      return nextCount;
    });
  };

  // --------------------------------------------------------------------------
  // Hardware Sensors (Accelerometer Step Detection + Heading)
  // --------------------------------------------------------------------------
  useEffect(() => {
    let motionSub, pedSub, accelSub, magSub;
    let isMounted = true;

    (async () => {
      try {
        if (Platform.OS === "android" && Platform.Version >= 29) {
          try {
            await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACTIVITY_RECOGNITION);
          } catch (pe) {
            console.warn("Activity recognition error:", pe);
          }
        }

        const [pAvail, mAvail, magAvail] = await Promise.all([
          Pedometer.isAvailableAsync().catch(() => false),
          DeviceMotion.isAvailableAsync().catch(() => false),
          Magnetometer.isAvailableAsync().catch(() => false)
        ]);

        if (!isMounted) return;
        setAvailable(`Sensors: Motion ${mAvail ? "✓" : "✗"} • Mag ${magAvail ? "✓" : "✗"} • Pedometer ${pAvail ? "✓" : "✗"}`);

        if (mAvail) await DeviceMotion.requestPermissionsAsync().catch(() => {});
        if (magAvail) await Magnetometer.requestPermissionsAsync().catch(() => {});
        if (pAvail) await Pedometer.requestPermissionsAsync().catch(() => {});

        // 1. Magnetometer (Compass Azimuth + Diagnostics)
        Magnetometer.setUpdateInterval(50);
        magSub = Magnetometer.addListener(data => {
          if (!data) return;
          const { x, y, z } = data;
          const totalField = Math.sqrt(x * x + y * y + z * z);
          setMagneticField({
            x: Number(x.toFixed(1)),
            y: Number(y.toFixed(1)),
            z: Number(z.toFixed(1)),
            total: Number(totalField.toFixed(1))
          });

          // If DeviceMotion rotation is not active on this device, use Magnetometer compass
          if (!hasMotionRotationRef.current) {
            let magDeg = Math.atan2(-x, y) * (180 / Math.PI);
            magDeg = norm(magDeg);
            setRawHeading(magDeg);

            if (headingZeroRef.current !== null) {
              const rel = signed(headingZeroRef.current - magDeg);
              headingRef.current = rel;
              setHeading(rel);
            }
          }
        });

        // 2. DeviceMotion / Rotation
        DeviceMotion.setUpdateInterval(50);
        motionSub = DeviceMotion.addListener(data => {
          if (!data?.rotation?.alpha) return;
          hasMotionRotationRef.current = true;
          const raw = norm(alphaDeg(data.rotation.alpha));
          setRawHeading(raw);

          if (headingZeroRef.current !== null) {
            const rel = signed(headingZeroRef.current - raw);
            let diff = rel - smoothedHeadingRef.current;
            if (diff > 180) diff -= 360;
            if (diff < -180) diff += 360;

            smoothedHeadingRef.current = norm(smoothedHeadingRef.current + 0.25 * diff);
            const formatted = signed(smoothedHeadingRef.current);
            headingRef.current = formatted;
            setHeading(formatted);
          }
        });

        // 3. High-Precision Accelerometer Step Detector with Zero-Velocity (ZUPT) Suppression
        Accelerometer.setUpdateInterval(30);
        accelSub = Accelerometer.addListener(data => {
          if (!runningRef.current) return;
          const { x, y, z } = data;
          const mag = Math.sqrt(x * x + y * y + z * z); // in g

          // Update rolling acceleration window (12 samples = ~360ms) for stationary detection
          accelWindowRef.current.push(mag);
          if (accelWindowRef.current.length > 12) {
            accelWindowRef.current.shift();
          }

          // Calculate peak-to-peak amplitude swing in current window
          const maxInWin = Math.max(...accelWindowRef.current);
          const minInWin = Math.min(...accelWindowRef.current);
          const swing = maxInWin - minInWin;

          // Zero-Velocity Check: true walking produces swing >= 0.26g; standing still produces swing < 0.20g
          const walking = swing >= 0.26;
          setIsStationary(!walking);

          // Update dynamic gravity baseline
          gravityRef.current = 0.92 * gravityRef.current + 0.08 * mag;
          const dynamicAccel = mag - gravityRef.current;

          const now = Date.now();

          // Peak-Valley Zero-Crossing State Machine (Eliminates false steps when standing still)
          if (!walking) {
            // Stationary: lock detector, prevent false triggers from tremors/tilting
            stepPhaseRef.current = "IDLE";
          } else {
            if (stepPhaseRef.current === "IDLE") {
              // Upward foot-strike impact peak (> +0.18g)
              if (dynamicAccel > 0.18 && (now - lastStepTimeRef.current) > 280) {
                stepPhaseRef.current = "RISING";
                peakValRef.current = dynamicAccel;
              }
            } else if (stepPhaseRef.current === "RISING") {
              if (dynamicAccel > peakValRef.current) {
                peakValRef.current = dynamicAccel;
              }
              // Downward swing valley (< -0.12g)
              if (dynamicAccel < -0.12) {
                stepPhaseRef.current = "FALLING";
                valleyValRef.current = dynamicAccel;
              }
            } else if (stepPhaseRef.current === "FALLING") {
              if (dynamicAccel < valleyValRef.current) {
                valleyValRef.current = dynamicAccel;
              }
              // Recovery back to baseline
              if (dynamicAccel > -0.04) {
                const dt = now - lastStepTimeRef.current;
                const totalWaveHeight = peakValRef.current - valleyValRef.current;

                // Step confirmed only if cadence and wave height match authentic walking
                if (dt >= 280 && dt <= 1200 && totalWaveHeight >= 0.30) {
                  lastStepTimeRef.current = now;
                  addStep();
                }
                stepPhaseRef.current = "IDLE";
              }
            }
          }
        });

        // 4. Hardware Pedometer backup
        pedSub = Pedometer.watchStepCount(result => {});

      } catch (e) {
        if (isMounted) setStatus("Sensor Error: " + (e?.message || String(e)));
      }
    })();

    return () => {
      isMounted = false;
      motionSub?.remove?.();
      pedSub?.remove?.();
      accelSub?.remove?.();
      magSub?.remove?.();
    };
  }, []);

  // --------------------------------------------------------------------------
  // User Actions
  // --------------------------------------------------------------------------
  const setZero = () => {
    headingZeroRef.current = rawHeading;
    setHeadingZero(rawHeading);
    smoothedHeadingRef.current = 0;
    headingRef.current = 0;
    setHeading(0);
    setStatus("Heading zero calibrated (Forward = 0°)");
  };

  const start = () => {
    if (headingZeroRef.current === null) {
      headingZeroRef.current = rawHeading;
      setHeadingZero(rawHeading);
      smoothedHeadingRef.current = 0;
      headingRef.current = 0;
      setHeading(0);
    }
    runningRef.current = true;
    setRunning(true);
    setStatus("Recording PDR path...");
  };

  const stop = () => {
    runningRef.current = false;
    setRunning(false);
    setIsStationary(true);
    setStatus("Tracking stopped");
  };

  const reset = () => {
    runningRef.current = false;
    setRunning(false);
    setSteps(0);
    setIsStationary(true);
    positionRef.current = { x: 0, y: 0 };
    setPosition({ x: 0, y: 0 });
    setPath([{ x: 0, y: 0 }]);
    setStatus("Reset to (0,0)");
  };

  const closeLoop = () => {
    if (path.length <= 2) {
      Alert.alert("Loop Closure Error", "Walk a closed loop path before applying loop closure.");
      return;
    }
    const lastPt = path[path.length - 1];
    const totalSteps = path.length - 1;
    const dx = lastPt.x / totalSteps;
    const dy = lastPt.y / totalSteps;

    const correctedPath = path.map((pt, i) => ({
      x: Number((pt.x - dx * i).toFixed(2)),
      y: Number((pt.y - dy * i).toFixed(2))
    }));

    const finalPos = correctedPath[correctedPath.length - 1];
    positionRef.current = finalPos;
    setPosition(finalPos);
    setPath(correctedPath);
    setStatus("Loop Closure Applied! Drift eliminated.");
    Alert.alert("Loop Closure Complete", `Corrected drift of X: ${lastPt.x.toFixed(2)}m, Y: ${lastPt.y.toFixed(2)}m back to origin.`);
  };

  const handleSavePath = async () => {
    if (path.length <= 1 && steps === 0) {
      Alert.alert("Cannot Save Path", "Walk a path first before saving.");
      return;
    }
    const totalDist = steps * stepLength;
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

  const dist = steps * stepLength;

  return (
    <SafeAreaView style={s.safe}>
      <ScrollView contentContainerStyle={s.container}>
        <Text style={s.title}>Indoor PDR Navigation</Text>
        <Text style={s.sub}>Real-Time Step Tracking • Compass & Gyro Heading • 2D Map</Text>

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
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <Text style={s.label}>Hardware Sensors Status</Text>
                <View style={[s.motionBadge, isStationary ? s.motionBadgeStationary : s.motionBadgeWalking]}>
                  <Text style={[s.motionBadgeText, isStationary ? s.motionTextStationary : s.motionTextWalking]}>
                    {running ? (isStationary ? "🛑 Stationary (Still)" : "🚶 Walking") : "⏸ Idle"}
                  </Text>
                </View>
              </View>
              <Text style={{ fontSize: 13, color: "#24292f", marginTop: 4 }}>{available}</Text>
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
              <Metric label="Step Length" value={`${stepLength.toFixed(2)} m`} />
            </View>

            {/* Step Length Adjuster & Test Step Button */}
            <View style={s.card}>
              <Text style={s.label}>Step Length Configuration & Test</Text>
              <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                <Pressable
                  onPress={() => {
                    const nextLen = Number(Math.max(0.40, stepLength - 0.05).toFixed(2));
                    setStepLength(nextLen);
                    stepLengthRef.current = nextLen;
                  }}
                  style={s.stepAdjustBtn}
                >
                  <Text style={s.stepAdjustText}>- 0.05m</Text>
                </Pressable>
                <View style={{ flex: 1, alignItems: "center" }}>
                  <Text style={{ fontSize: 16, fontWeight: "800", color: "#1f6feb" }}>{stepLength.toFixed(2)} m</Text>
                </View>
                <Pressable
                  onPress={() => {
                    const nextLen = Number(Math.min(1.20, stepLength + 0.05).toFixed(2));
                    setStepLength(nextLen);
                    stepLengthRef.current = nextLen;
                  }}
                  style={s.stepAdjustBtn}
                >
                  <Text style={s.stepAdjustText}>+ 0.05m</Text>
                </Pressable>
              </View>
              {/* Test Manual Step Button */}
              <Pressable
                onPress={() => addStep()}
                style={s.manualStepBtn}
              >
                <Text style={s.manualStepBtnText}>👣 Add Test Step Manually</Text>
              </Pressable>
            </View>

            {/* 2D Path Map with Live Orientation Arrow */}
            <PathPlot points={path} heading={heading} previousPath={selectedPreviousPath} />

            {/* Main Action Buttons */}
            <View style={s.row}>
              <Btn text="Set Heading Zero" onPress={setZero} />
              <Btn text={running ? "Stop Tracking" : "Start Tracking"} onPress={running ? stop : start} strong />
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
                1. Face the direction you want to walk and tap "Set Heading Zero".{"\n"}
                2. Tap "Start Tracking" and begin walking.{"\n"}
                3. The blue line and red orientation pointer will draw your path live on the map.
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

  const validPts = (points && points.length > 0) ? points : [{ x: 0, y: 0 }];
  let allPts = [...validPts];
  if (previousPath?.points?.length > 0) {
    allPts = [...allPts, ...previousPath.points];
  }

  let minX = 0, maxX = 0, minY = 0, maxY = 0;
  allPts.forEach(p => {
    if (typeof p?.x === "number") {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
    }
    if (typeof p?.y === "number") {
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
  });

  const spanX = Math.max(4.0, maxX - minX);
  const spanY = Math.max(4.0, maxY - minY);
  const scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  const map = p => ({
    x: Number((width / 2 + (p.x - cx) * scale).toFixed(1)),
    y: Number((height / 2 - (p.y - cy) * scale).toFixed(1))
  });

  const m = validPts.map(map);
  const poly = m.map(p => `${p.x},${p.y}`).join(" ");
  const start = map({ x: 0, y: 0 });
  const end = m[m.length - 1] || start;

  const safeHeading = typeof heading === "number" && !isNaN(heading) ? heading : 0;
  const rad = (safeHeading * Math.PI) / 180;
  const arrowLen = 18;
  const tip = {
    x: Number((end.x + arrowLen * Math.sin(rad)).toFixed(1)),
    y: Number((end.y - arrowLen * Math.cos(rad)).toFixed(1))
  };
  const left = {
    x: Number((end.x + 10 * Math.sin(rad - 2.4)).toFixed(1)),
    y: Number((end.y - 10 * Math.cos(rad - 2.4)).toFixed(1))
  };
  const right = {
    x: Number((end.x + 10 * Math.sin(rad + 2.4)).toFixed(1)),
    y: Number((end.y - 10 * Math.cos(rad + 2.4)).toFixed(1))
  };
  const arrowPoly = `${tip.x},${tip.y} ${left.x},${left.y} ${end.x},${end.y} ${right.x},${right.y}`;

  const lastPt = validPts[validPts.length - 1] || { x: 0, y: 0 };

  return (
    <View style={s.plot}>
      <Text style={s.label}>Live PDR Walk Route Map</Text>

      <View style={s.legendRow}>
        <View style={s.legendItem}>
          <View style={[s.legendColor, { backgroundColor: "#1f6feb" }]} />
          <Text style={s.legendText}>Route ({validPts.length} pts)</Text>
        </View>
        <View style={s.legendItem}>
          <View style={[s.legendColor, { backgroundColor: "#cf222e" }]} />
          <Text style={s.legendText}>Facing ({safeHeading.toFixed(0)}°)</Text>
        </View>
        {previousPath && (
          <View style={s.legendItem}>
            <View style={[s.legendColor, { backgroundColor: "#d97706" }]} />
            <Text style={s.legendText}>Previous ({previousPath.name})</Text>
          </View>
        )}
      </View>

      <Svg width={width} height={height}>
        <Rect x="0" y="0" width={width} height={height} fill="#fafbfc" rx="10" />

        {/* Origin Axes Lines */}
        <Line x1="0" y1={start.y} x2={width} y2={start.y} stroke="#d0d7de" strokeWidth="1" strokeDasharray="4,4" />
        <Line x1={start.x} y1="0" x2={start.x} y2={height} stroke="#d0d7de" strokeWidth="1" strokeDasharray="4,4" />

        {/* Previous Saved Path Overlay */}
        {previousPath?.points?.length > 0 && (
          <Polyline
            points={previousPath.points.map(map).map(p => `${p.x},${p.y}`).join(" ")}
            fill="none"
            stroke="#d97706"
            strokeWidth="3"
            strokeDasharray="6,4"
            opacity={0.8}
          />
        )}

        {/* Live Active Path Polyline */}
        {m.length > 1 && (
          <Polyline points={poly} fill="none" stroke="#1f6feb" strokeWidth="4" strokeLinejoin="round" strokeLinecap="round" />
        )}

        {/* Waypoint Circles */}
        {m.map((pt, i) => (
          <Circle key={i} cx={pt.x} cy={pt.y} r={i === 0 ? 5 : i === m.length - 1 ? 5.5 : 3.5} fill={i === 0 ? "#1a7f37" : "#1f6feb"} />
        ))}

        {/* Start Position Marker */}
        <Circle cx={start.x} cy={start.y} r="6" fill="#1a7f37" stroke="#ffffff" strokeWidth="1.5" />
        <SvgText x={start.x + 8} y={start.y - 6} fontSize="11" fontWeight="bold" fill="#1a7f37">START (0,0)</SvgText>

        {/* Live Direction Pointer & Current Position Marker */}
        <Polygon points={arrowPoly} fill="#cf222e" stroke="#ffffff" strokeWidth="1" />
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

  motionBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, borderWidth: 1 },
  motionBadgeWalking: { backgroundColor: "#dafbe1", borderColor: "#2da44e" },
  motionBadgeStationary: { backgroundColor: "#f6f8fa", borderColor: "#d0d7de" },
  motionBadgeText: { fontSize: 11, fontWeight: "700" },
  motionTextWalking: { color: "#1a7f37" },
  motionTextStationary: { color: "#57606a" },

  stepAdjustBtn: { paddingVertical: 6, paddingHorizontal: 12, backgroundColor: "#f6f8fa", borderRadius: 8, borderWidth: 1, borderColor: "#d0d7de" },
  stepAdjustText: { fontSize: 12, fontWeight: "700", color: "#1f6feb" },
  manualStepBtn: { marginTop: 10, backgroundColor: "#eef5ff", paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: "#54aeff", alignItems: "center" },
  manualStepBtnText: { fontSize: 13, fontWeight: "700", color: "#0969da" },

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
