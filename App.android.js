import React, { useEffect, useRef, useState } from "react";
import { SafeAreaView, View, Text, Pressable, ScrollView, StyleSheet, Alert, Dimensions } from "react-native";
import Svg, { Polyline, Circle, Line, Text as SvgText } from "react-native-svg";
import { Pedometer, DeviceMotion, Accelerometer, Magnetometer } from "expo-sensors";
import { getSavedPaths, savePath, deleteSavedPath, clearAllSavedPaths } from "./PathStorage.js";
import BleScannerSection from "./components/BleScannerSection.js";

const norm = d => { let x = d % 360; if (x < 0) x += 360; return x; };
const signed = d => { let x = norm(d); if (x > 180) x -= 360; return x; };
const alphaDeg = a => Math.abs(a) <= Math.PI * 2.2 ? a * 180 / Math.PI : a;

const ACCEL_THRESHOLD = 1.18; 
const ACCEL_MIN_DELAY = 330; 
const LPF_ALPHA = 0.25; 
const WEINBERG_K = 0.45; 

export default function AppAndroid() {
  const [running, setRunning] = useState(false);
  const [available, setAvailable] = useState("checking");
  const [steps, setSteps] = useState(0);
  const [currentStepLength, setCurrentStepLength] = useState(0.70);
  const [rawHeading, setRawHeading] = useState(0);
  const [heading, setHeading] = useState(0);
  const [headingZero, setHeadingZero] = useState(null);
  const [position, setPosition] = useState({x:0,y:0});
  const [path, setPath] = useState([{x:0,y:0}]);
  const [status, setStatus] = useState("Ready (Android)");
  
  const [magneticField, setMagneticField] = useState({ x: 0, y: 0, z: 0, total: 0 });

  // Saved Paths state
  const [savedPaths, setSavedPaths] = useState([]);
  const [selectedPreviousPath, setSelectedPreviousPath] = useState(null);

  // Mode switch: 'pdr' | 'ble'
  const [activeTab, setActiveTab] = useState("pdr");

  const runningRef = useRef(false);
  const headingRef = useRef(0);
  const smoothedHeadingRef = useRef(0);
  const prevPedRef = useRef(0);
  const initializedPedRef = useRef(false);
  const lastStepTimeRef = useRef(0);
  const positionRef = useRef({x:0,y:0});
  const stepLengthRef = useRef(0.70);
  const stepAccelBufferRef = useRef([]);

  // Load saved paths on mount
  useEffect(() => {
    loadSavedPathsHistory();
  }, []);

  const loadSavedPathsHistory = async () => {
    const list = await getSavedPaths();
    setSavedPaths(list);
  };

  const addStep = (dynamicLen = null) => {
    const len = dynamicLen && dynamicLen >= 0.4 && dynamicLen <= 1.2 ? dynamicLen : stepLengthRef.current;
    stepLengthRef.current = len;
    setCurrentStepLength(len);

    const theta = smoothedHeadingRef.current * Math.PI / 180;
    const old = positionRef.current;
    const next = { 
      x: Number((old.x + len * Math.sin(theta)).toFixed(3)), 
      y: Number((old.y + len * Math.cos(theta)).toFixed(3)) 
    };
    positionRef.current = next;
    setPosition(next);
    setSteps(s => {
      const nextStepCount = s + 1;
      console.log(`[Android PDR LOG] Step #${nextStepCount} | Auto Step Length: ${len.toFixed(2)}m | Heading: ${headingRef.current.toFixed(1)}° | Pos: X=${next.x}m, Y=${next.y}m`);
      return nextStepCount;
    });
    setPath(p => [...p, next]);
  };

  const computeWeinbergStepLength = () => {
    const buf = stepAccelBufferRef.current;
    if (buf.length < 3) return 0.70;
    const maxAccel = Math.max(...buf);
    const minAccel = Math.min(...buf);
    stepAccelBufferRef.current = [];
    
    const bounceDiff = Math.max(0.1, maxAccel - minAccel);
    const estimatedLen = WEINBERG_K * Math.pow(bounceDiff, 0.25);
    return Number(Math.min(1.1, Math.max(0.45, estimatedLen)).toFixed(2));
  };

  useEffect(() => {
    let motionSub, pedSub, accelSub, magSub;
    (async () => {
      try {
        const pAvail = await Pedometer.isAvailableAsync();
        const mAvail = await DeviceMotion.isAvailableAsync();
        const magAvail = await Magnetometer.isAvailableAsync();
        
        setAvailable(`Pedometer: ${pAvail ? "yes" : "no"} | Motion: ${mAvail ? "yes" : "no"} | Mag: ${magAvail ? "yes" : "no"}`);
        if (pAvail) await Pedometer.requestPermissionsAsync();
        if (mAvail) await DeviceMotion.requestPermissionsAsync();
        if (magAvail) await Magnetometer.requestPermissionsAsync();

        Magnetometer.setUpdateInterval(100);
        magSub = Magnetometer.addListener(data => {
          const { x, y, z } = data;
          const totalField = Math.sqrt(x * x + y * y + z * z);
          setMagneticField({
            x: Number(x.toFixed(1)),
            y: Number(y.toFixed(1)),
            z: Number(z.toFixed(1)),
            total: Number(totalField.toFixed(1))
          });
        });

        DeviceMotion.setUpdateInterval(40);
        motionSub = DeviceMotion.addListener(data => {
          if (!data?.rotation) return;
          const raw = norm(alphaDeg(data.rotation.alpha));
          setRawHeading(raw);
          if (headingZero !== null) {
            // Android rotation alpha orientation reversal
            const rel = signed(headingZero - raw);
            let diff = rel - smoothedHeadingRef.current;
            if (diff > 180) diff -= 360;
            if (diff < -180) diff += 360;
            
            smoothedHeadingRef.current = norm(smoothedHeadingRef.current + LPF_ALPHA * diff);
            const formattedHeading = signed(smoothedHeadingRef.current);
            headingRef.current = formattedHeading;
            setHeading(formattedHeading);
          }
        });

        pedSub = Pedometer.watchStepCount(result => {
          const current = result.steps || 0;
          if (!initializedPedRef.current) {
            prevPedRef.current = current;
            initializedPedRef.current = true;
            return;
          }
          const prev = prevPedRef.current;
          if (runningRef.current && current > prev) {
            const autoLen = computeWeinbergStepLength();
            for (let i = 0; i < current - prev; i++) addStep(autoLen);
          }
          prevPedRef.current = current;
        });

        Accelerometer.setUpdateInterval(40);
        accelSub = Accelerometer.addListener(data => {
          if (!runningRef.current) return;
          const { x, y, z } = data;
          const mag = Math.sqrt(x * x + y * y + z * z);
          stepAccelBufferRef.current.push(mag);

          const now = Date.now();
          if (mag > ACCEL_THRESHOLD && (now - lastStepTimeRef.current) > ACCEL_MIN_DELAY) {
            if (!pAvail || !initializedPedRef.current) {
              lastStepTimeRef.current = now;
              const autoLen = computeWeinbergStepLength();
              addStep(autoLen);
            }
          }
        });
      } catch (e) {
        setStatus("Android Sensor error: " + (e?.message || String(e)));
      }
    })();
    return () => { motionSub?.remove?.(); pedSub?.remove?.(); accelSub?.remove?.(); magSub?.remove?.(); };
  }, [headingZero]);

  const closeLoop = () => {
    if (path.length <= 2) {
      Alert.alert("Loop Closure Error", "Walk a complete loop first before applying loop closure.");
      return;
    }
    const lastPt = path[path.length - 1];
    const totalSteps = path.length - 1;
    const dx = lastPt.x / totalSteps;
    const dy = lastPt.y / totalSteps;

    const correctedPath = path.map((pt, i) => ({
      x: Number((pt.x - dx * i).toFixed(3)),
      y: Number((pt.y - dy * i).toFixed(3))
    }));

    const finalPos = correctedPath[correctedPath.length - 1];
    positionRef.current = finalPos;
    setPosition(finalPos);
    setPath(correctedPath);
    setStatus("Loop Closure Applied! Drift eliminated.");
    Alert.alert("Android Loop Closure Complete", `Accumulated drift of X:${lastPt.x.toFixed(2)}m, Y:${lastPt.y.toFixed(2)}m corrected back to (0,0).`);
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
      Alert.alert("Save Error", "Failed to save path to local storage.");
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
          if (selectedPreviousPath?.id === id) {
            setSelectedPreviousPath(null);
          }
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

  const setZero = () => { setHeadingZero(rawHeading); headingRef.current = 0; setHeading(0); setStatus("Android Heading zero calibrated"); };
  const start = () => { if (headingZero === null) { Alert.alert("Set heading first", "Face forward and tap Set Heading Zero."); return; } runningRef.current = true; setRunning(true); setStatus("Recording Android PDR path"); };
  const stop = () => { runningRef.current = false; setRunning(false); setStatus("Stopped"); };
  const reset = () => { runningRef.current = false; setRunning(false); setSteps(0); setPosition({x:0,y:0}); positionRef.current={x:0,y:0}; setPath([{x:0,y:0}]); setStatus("Reset to (0,0)"); };

  const dist = steps * currentStepLength;

  return (
    <SafeAreaView style={s.safe}>
      <ScrollView contentContainerStyle={s.container}>
        <Text style={s.title}>Indoor PDR Navigation</Text>
        <Text style={s.sub}>Hardware Sensors • BLE Proximity • Start (0,0)</Text>

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
              <Text style={s.label}>Sensors</Text>
              <Text>{available}</Text>
              <Text style={s.status}>{status}</Text>
            </View>
            <View style={s.row}><Metric label="Steps" value={String(steps)}/><Metric label="Heading" value={`${heading.toFixed(1)}°`}/></View>
            <View style={s.row}><Metric label="X" value={`${position.x.toFixed(2)} m`}/><Metric label="Y" value={`${position.y.toFixed(2)} m`}/></View>
            <View style={s.row}><Metric label="Distance" value={`${dist.toFixed(2)} m`}/><Metric label="Auto Step Length" value={`${currentStepLength.toFixed(2)} m`}/></View>
            
            <View style={s.card}>
              <Text style={s.label}>Magnetic Field Intensity (Magnetometer)</Text>
              <View style={s.row}>
                <Metric label="Total B-Field" value={`${magneticField.total} μT`}/>
              </View>
              <View style={{marginTop: 8}}>
                <Metric label="B-Vector (X, Y, Z μT)" value={`X: ${magneticField.x} | Y: ${magneticField.y} | Z: ${magneticField.z}`} fullWidth/>
              </View>
            </View>

            <View style={s.card}>
              <Text style={s.label}>Live Waypoint List (Coordinates)</Text>
              <ScrollView style={{maxHeight: 140}}>
                {path.map((pt, idx) => (
                  <Text key={idx} style={{fontFamily: "monospace", fontSize: 13, color: idx === path.length - 1 ? "#1f6feb" : "#24292f"}}>
                    Step {idx}: X={pt.x.toFixed(2)}m, Y={pt.y.toFixed(2)}m
                  </Text>
                ))}
              </ScrollView>
            </View>

            <PathPlot points={path} previousPath={selectedPreviousPath} />

            <View style={s.row}>
              <Btn text="Set Heading Zero" onPress={setZero}/>
              <Btn text={running?"Stop":"Start"} onPress={running?stop:start} strong/>
            </View>

            <View style={s.row}>
              <Btn text="Save Path" onPress={handleSavePath} bg="#1a7f37" color="white" />
              <Btn text="Close Loop" onPress={closeLoop} />
              <Btn text="Reset Path" onPress={reset}/>
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
                <ScrollView style={{ maxHeight: 220 }}>
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
              <Text style={s.help}>Hold phone flat, screen facing up. Android activity recognition permissions will track steps and device motion sensors will track turns.</Text>
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Metric({label,value,fullWidth}){
  return <View style={[s.metric, fullWidth && {flex: undefined, width: "100%"}]}>
    <Text style={s.metricLabel}>{label}</Text>
    <Text style={s.metricValue}>{value}</Text>
  </View>
}

function Btn({text, onPress, strong, bg, color}){
  return (
    <Pressable onPress={onPress} style={[s.btn, strong && s.btnStrong, bg ? { backgroundColor: bg, borderColor: bg } : null]}>
      <Text style={[s.btnText, strong && {color:"white"}, color ? { color } : null]}>{text}</Text>
    </Pressable>
  );
}

function PathPlot({ points, previousPath }){
  const width = Math.min(Dimensions.get("window").width - 32, 520), height = 340, pad = 40;
  
  let allPts = [...points];
  if (previousPath && previousPath.points && previousPath.points.length > 0) {
    allPts = [...allPts, ...previousPath.points];
  }

  let minX = 0, maxX = 0, minY = 0, maxY = 0; 
  allPts.forEach(p => {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  });
  
  const spanX = Math.max(4, maxX - minX), spanY = Math.max(4, maxY - minY);
  const scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const map = p => ({ x: width / 2 + (p.x - cx) * scale, y: height / 2 - (p.y - cy) * scale });
  
  const m = points.map(map);
  const poly = m.map(p => `${p.x},${p.y}`).join(" ");
  const start = map({ x: 0, y: 0 });
  const end = m[m.length - 1] || start;

  let prevM = [], prevPoly = "", prevEnd = null;
  if (previousPath && previousPath.points && previousPath.points.length > 0) {
    prevM = previousPath.points.map(map);
    prevPoly = prevM.map(p => `${p.x},${p.y}`).join(" ");
    prevEnd = prevM[prevM.length - 1];
  }
  
  return (
    <View style={s.plot}>
      <Text style={s.label}>Live PDR Walk Route Map (Android)</Text>
      
      {/* Map Legend */}
      <View style={s.legendRow}>
        <View style={s.legendItem}>
          <View style={[s.legendColor, { backgroundColor: "#1f6feb" }]} />
          <Text style={s.legendText}>Current Path</Text>
        </View>
        {previousPath && (
          <View style={s.legendItem}>
            <View style={[s.legendColor, { backgroundColor: "#d97706" }]} />
            <Text style={s.legendText}>Previous ({previousPath.name})</Text>
          </View>
        )}
      </View>

      <Svg width={width} height={height}>
        <Line x1="0" y1={start.y} x2={width} y2={start.y} stroke="#e1e4e8" strokeDasharray="4,4"/>
        <Line x1={start.x} y1="0" x2={start.x} y2={height} stroke="#e1e4e8" strokeDasharray="4,4"/>
        
        {/* Render Previous Path Overlay */}
        {previousPath && prevPoly.length > 0 && (
          <>
            <Polyline points={prevPoly} fill="none" stroke="#d97706" strokeWidth="3.5" strokeDasharray="6,4" strokeLinejoin="round" strokeLinecap="round" opacity={0.85} />
            {prevM.map((pt, i) => (
              <Circle key={`prev-${i}`} cx={pt.x} cy={pt.y} r={i === prevM.length - 1 ? 5 : 3} fill="#d97706" opacity={0.85} />
            ))}
            {prevEnd && (
              <SvgText x={prevEnd.x + 8} y={prevEnd.y - 8} fontSize="11" fontWeight="bold" fill="#b45309">
                PREV ({previousPath.points[previousPath.points.length - 1].x.toFixed(1)}, {previousPath.points[previousPath.points.length - 1].y.toFixed(1)})
              </SvgText>
            )}
          </>
        )}

        {/* Render Current Live Path */}
        <Polyline points={poly} fill="none" stroke="#1f6feb" strokeWidth="4" strokeLinejoin="round" strokeLinecap="round"/>
        {m.map((pt, i) => (
          <Circle key={`curr-${i}`} cx={pt.x} cy={pt.y} r={i === m.length - 1 ? 5 : 3} fill={i === m.length - 1 ? "#1f6feb" : "#0969da"} />
        ))}

        <Circle cx={start.x} cy={start.y} r="7" fill="#1a7f37"/>
        <SvgText x={start.x+10} y={start.y-8} fontSize="12" fontWeight="bold" fill="#1a7f37">START (0,0)</SvgText>
        <Circle cx={end.x} cy={end.y} r="8" fill="#cf222e"/>
        <SvgText x={end.x+10} y={end.y+16} fontSize="12" fontWeight="bold" fill="#cf222e">
          NOW ({points[points.length-1].x.toFixed(1)}, {points[points.length-1].y.toFixed(1)})
        </SvgText>
      </Svg>
    </View>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#f6f8fa" },
  container: { padding: 16, paddingBottom: 40 },
  title: { fontSize: 30, fontWeight: "800" },
  sub: { color: "#57606a", marginBottom: 14 },
  card: { backgroundColor: "white", borderRadius: 14, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: "#d0d7de" },
  plot: { backgroundColor: "white", borderRadius: 14, paddingTop: 14, marginBottom: 12, borderWidth: 1, borderColor: "#d0d7de", alignItems: "center" },
  label: { fontWeight: "700", color: "#57606a", marginBottom: 6 },
  status: { marginTop: 5, color: "#57606a" },
  row: { flexDirection: "row", gap: 10, marginBottom: 10 },
  metric: { flex: 1, backgroundColor: "white", borderRadius: 14, padding: 14, borderWidth: 1, borderColor: "#d0d7de" },
  metricLabel: { fontSize: 12, color: "#57606a" },
  metricValue: { fontSize: 22, fontWeight: "800" },
  input: { borderWidth: 1, borderColor: "#8c959f", borderRadius: 10, padding: 10, fontSize: 18 },
  help: { color: "#57606a", lineHeight: 20 },
  btn: { flex: 1, borderRadius: 12, paddingVertical: 13, alignItems: "center", borderWidth: 1, borderColor: "#8c959f", backgroundColor: "white" },
  btnStrong: { backgroundColor: "#1f6feb", borderColor: "#1f6feb" },
  btnText: { fontWeight: "700" },

  // Tab switcher styles
  tabContainer: {
    flexDirection: "row",
    backgroundColor: "#e1e4e8",
    borderRadius: 12,
    padding: 4,
    marginBottom: 14,
    gap: 4,
  },
  tabBtn: {
    flex: 1,
    paddingVertical: 10,
    alignItems: "center",
    borderRadius: 8,
  },
  tabBtnActive: {
    backgroundColor: "#ffffff",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  tabBtnText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#57606a",
  },
  tabBtnTextActive: {
    color: "#1f6feb",
  },

  // Legend styles
  legendRow: { flexDirection: "row", gap: 16, marginBottom: 8, marginTop: 2 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  legendColor: { width: 14, height: 4, borderRadius: 2 },
  legendText: { fontSize: 12, color: "#57606a", fontWeight: "600" },

  // Saved Paths list styles
  clearBtn: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, backgroundColor: "#fff0f0", borderWidth: 1, borderColor: "#ffc9c9" },
  clearBtnText: { fontSize: 12, color: "#cf222e", fontWeight: "700" },
  savedItem: { flexDirection: "row", alignItems: "center", paddingVertical: 10, paddingHorizontal: 10, borderRadius: 10, borderWidth: 1, borderColor: "#e1e4e8", marginBottom: 8, backgroundColor: "#fafafa" },
  savedItemSelected: { borderColor: "#d97706", backgroundColor: "#fffbeb" },
  savedTitle: { fontWeight: "700", fontSize: 14, color: "#24292f" },
  savedMeta: { fontSize: 12, color: "#57606a", marginTop: 2 },
  savedMetaSub: { fontSize: 11, color: "#0969da", fontWeight: "600", marginTop: 1 },
  actionBtn: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, alignItems: "center" },
  actionBtnOutline: { borderColor: "#1f6feb", backgroundColor: "white" },
  actionBtnActive: { backgroundColor: "#d97706", borderColor: "#d97706" },
  actionBtnDanger: { borderColor: "#ffc9c9", backgroundColor: "#fff0f0" },
  actionBtnText: { fontSize: 12, fontWeight: "700", color: "#1f6feb" }
});
