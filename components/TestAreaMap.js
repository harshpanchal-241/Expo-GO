// ============================================================================
// TestAreaMap — SVG 18×15 ft Indoor Room Map
// Renders beacon markers (smoothly draggable in setup mode), user position,
// heading orientation, trail, grid, and interactive ground truth validation.
// ============================================================================

import React, { useRef, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  PanResponder,
  Dimensions,
} from "react-native";
import Svg, {
  Rect,
  Line,
  Circle,
  Text as SvgText,
  Polyline,
  Polygon,
  G,
} from "react-native-svg";
import {
  feetToScreen,
  screenToFeet,
  clampToRoom,
  ROOM_WIDTH_FT,
  ROOM_HEIGHT_FT,
} from "../services/twoBeaconServices.js";

const GRID_STEP_FT = 3; // 3 ft grid lines

export default function TestAreaMap({
  beacon1,           // { x, y } in feet
  beacon2,           // { x, y } in feet
  beacon1Dist,       // estimated distance to B1 in feet
  beacon2Dist,       // estimated distance to B2 in feet
  userPosition,      // { fusedX, fusedY, activeX, activeY }
  blePosition,       // { bleX, bleY } (optional overlay)
  pdrPosition,       // { pdrX, pdrY } (optional overlay)
  trail,             // [{ x, y }, ...] in feet
  heading = 0,       // compass heading in degrees
  groundTruth,       // { x, y } ground truth pin in feet
  isSetupMode,       // true → beacons draggable
  showDebugOverlays, // show raw BLE + PDR dots
  onBeacon1Move,     // (x, y) live updates during drag
  onBeacon1Commit,   // (x, y) final save on release
  onBeacon2Move,     // (x, y) live updates during drag
  onBeacon2Commit,   // (x, y) final save on release
  onDragStateChange, // (isDragging: boolean) locks parent ScrollView
  onMapTap,          // (x, y) called on tap in test mode
}) {
  const [activeDrag, setActiveDrag] = useState(null); // 'b1' | 'b2' | null
  const dragStartFeetRef = useRef({ x: 0, y: 0 });

  // Compute map size — maintain 18:15 aspect ratio and fit inside screen
  const screenWidth = Dimensions.get("window").width;
  const PAD = 24;  // label padding inside the SVG canvas
  const availableWidth = screenWidth - 32;  // 16px padding each side from parent
  const svgW    = availableWidth;
  const mapWidth  = Math.max(100, svgW - PAD * 2);
  const mapHeight = mapWidth * (ROOM_HEIGHT_FT / ROOM_WIDTH_FT);
  const svgH    = mapHeight + PAD * 2;

  // Conversion helpers (room coordinates, not canvas)
  const toScreen = useCallback(
    (rx, ry) => {
      const s = feetToScreen(rx, ry, mapWidth, mapHeight);
      return { sx: s.sx + PAD, sy: s.sy + PAD };
    },
    [mapWidth, mapHeight],
  );

  const fromScreen = useCallback(
    (sx, sy) => screenToFeet(sx - PAD, sy - PAD, mapWidth, mapHeight),
    [mapWidth, mapHeight],
  );

  // ─── PanResponder for Beacon 1 (Kinematic Delta Math) ────────────────────
  const pan1 = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => isSetupMode,
      onStartShouldSetPanResponderCapture: () => isSetupMode,
      onMoveShouldSetPanResponder: () => isSetupMode,
      onMoveShouldSetPanResponderCapture: () => isSetupMode,
      onPanResponderGrant: () => {
        dragStartFeetRef.current = {
          x: beacon1?.x ?? 0,
          y: beacon1?.y ?? ROOM_HEIGHT_FT,
        };
        setActiveDrag("b1");
        onDragStateChange?.(true);
      },
      onPanResponderMove: (_, gestureState) => {
        const deltaX_ft = (gestureState.dx / mapWidth) * ROOM_WIDTH_FT;
        const deltaY_ft = -(gestureState.dy / mapHeight) * ROOM_HEIGHT_FT;
        const newX = dragStartFeetRef.current.x + deltaX_ft;
        const newY = dragStartFeetRef.current.y + deltaY_ft;
        const clamped = clampToRoom(newX, newY);
        onBeacon1Move?.(Number(clamped.x.toFixed(2)), Number(clamped.y.toFixed(2)));
      },
      onPanResponderRelease: (_, gestureState) => {
        const deltaX_ft = (gestureState.dx / mapWidth) * ROOM_WIDTH_FT;
        const deltaY_ft = -(gestureState.dy / mapHeight) * ROOM_HEIGHT_FT;
        const newX = dragStartFeetRef.current.x + deltaX_ft;
        const newY = dragStartFeetRef.current.y + deltaY_ft;
        const clamped = clampToRoom(newX, newY);
        setActiveDrag(null);
        onDragStateChange?.(false);
        const finalX = Number(clamped.x.toFixed(2));
        const finalY = Number(clamped.y.toFixed(2));
        onBeacon1Move?.(finalX, finalY);
        onBeacon1Commit?.(finalX, finalY);
      },
      onPanResponderTerminate: () => {
        setActiveDrag(null);
        onDragStateChange?.(false);
      },
    }),
  ).current;

  // ─── PanResponder for Beacon 2 (Kinematic Delta Math) ────────────────────
  const pan2 = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => isSetupMode,
      onStartShouldSetPanResponderCapture: () => isSetupMode,
      onMoveShouldSetPanResponder: () => isSetupMode,
      onMoveShouldSetPanResponderCapture: () => isSetupMode,
      onPanResponderGrant: () => {
        dragStartFeetRef.current = {
          x: beacon2?.x ?? ROOM_WIDTH_FT,
          y: beacon2?.y ?? ROOM_HEIGHT_FT,
        };
        setActiveDrag("b2");
        onDragStateChange?.(true);
      },
      onPanResponderMove: (_, gestureState) => {
        const deltaX_ft = (gestureState.dx / mapWidth) * ROOM_WIDTH_FT;
        const deltaY_ft = -(gestureState.dy / mapHeight) * ROOM_HEIGHT_FT;
        const newX = dragStartFeetRef.current.x + deltaX_ft;
        const newY = dragStartFeetRef.current.y + deltaY_ft;
        const clamped = clampToRoom(newX, newY);
        onBeacon2Move?.(Number(clamped.x.toFixed(2)), Number(clamped.y.toFixed(2)));
      },
      onPanResponderRelease: (_, gestureState) => {
        const deltaX_ft = (gestureState.dx / mapWidth) * ROOM_WIDTH_FT;
        const deltaY_ft = -(gestureState.dy / mapHeight) * ROOM_HEIGHT_FT;
        const newX = dragStartFeetRef.current.x + deltaX_ft;
        const newY = dragStartFeetRef.current.y + deltaY_ft;
        const clamped = clampToRoom(newX, newY);
        setActiveDrag(null);
        onDragStateChange?.(false);
        const finalX = Number(clamped.x.toFixed(2));
        const finalY = Number(clamped.y.toFixed(2));
        onBeacon2Move?.(finalX, finalY);
        onBeacon2Commit?.(finalX, finalY);
      },
      onPanResponderTerminate: () => {
        setActiveDrag(null);
        onDragStateChange?.(false);
      },
    }),
  ).current;

  // ─── Screen space points ──────────────────────────────────────────────────
  const b1s   = toScreen(beacon1?.x ?? 0, beacon1?.y ?? ROOM_HEIGHT_FT);
  const b2s   = toScreen(beacon2?.x ?? ROOM_WIDTH_FT, beacon2?.y ?? ROOM_HEIGHT_FT);
  const curX  = userPosition?.activeX ?? userPosition?.fusedX ?? 9;
  const curY  = userPosition?.activeY ?? userPosition?.fusedY ?? 7.5;
  const userS = toScreen(curX, curY);
  const bleS  = blePosition  ? toScreen(blePosition.bleX,  blePosition.bleY)  : null;
  const pdrS  = pdrPosition  ? toScreen(pdrPosition.pdrX,  pdrPosition.pdrY)  : null;
  const gtS   = groundTruth  ? toScreen(groundTruth.x, groundTruth.y)         : null;

  // Trail polyline
  const trailPts = (trail || [])
    .map(p => { const s = toScreen(p.x, p.y); return `${s.sx.toFixed(1)},${s.sy.toFixed(1)}`; })
    .join(" ");

  // Grid lines
  const gridLines = [];
  for (let gx = 0; gx <= ROOM_WIDTH_FT; gx += GRID_STEP_FT) {
    const { sx } = toScreen(gx, 0);
    gridLines.push(
      <Line key={`vg${gx}`} x1={sx} y1={PAD} x2={sx} y2={PAD + mapHeight}
        stroke="#e2e8f0" strokeWidth={gx === 0 || gx === ROOM_WIDTH_FT ? 1.5 : 0.8} />,
    );
  }
  for (let gy = 0; gy <= ROOM_HEIGHT_FT; gy += GRID_STEP_FT) {
    const { sy } = toScreen(0, gy);
    gridLines.push(
      <Line key={`hg${gy}`} x1={PAD} y1={sy} x2={PAD + mapWidth} y2={sy}
        stroke="#e2e8f0" strokeWidth={gy === 0 || gy === ROOM_HEIGHT_FT ? 1.5 : 0.8} />,
    );
  }

  // Axis labels
  const xLabels = [0, 6, 12, 18].map(ft => {
    const { sx } = toScreen(ft, 0);
    return (
      <SvgText key={`xl${ft}`} x={sx} y={PAD + mapHeight + 16}
        fontSize="9" fill="#94a3b8" textAnchor="middle">{ft}ft</SvgText>
    );
  });
  const yLabels = [0, 5, 10, 15].map(ft => {
    const { sy } = toScreen(0, ft);
    return (
      <SvgText key={`yl${ft}`} x={PAD - 4} y={sy + 4}
        fontSize="9" fill="#94a3b8" textAnchor="end">{ft}ft</SvgText>
    );
  });

  // Handle map tap in test mode
  const handleMapPress = (e) => {
    if (isSetupMode || !onMapTap) return;
    const { locationX, locationY } = e.nativeEvent;
    const { realX, realY } = fromScreen(locationX, locationY);
    const clamped = clampToRoom(realX, realY);
    onMapTap(Number(clamped.x.toFixed(2)), Number(clamped.y.toFixed(2)));
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>18 × 15 ft Indoor Room</Text>
        {isSetupMode ? (
          <Text style={styles.hint}>Drag B1 / B2 to place beacons</Text>
        ) : (
          <Text style={styles.hintTap}>Tap map to test accuracy vs target</Text>
        )}
      </View>

      <View style={styles.svgWrapper}>
        <Svg width={svgW} height={svgH} onPress={handleMapPress}>
          {/* Room background */}
          <Rect x={PAD} y={PAD} width={mapWidth} height={mapHeight}
            fill="#f8fafc" rx="6" stroke="#cbd5e1" strokeWidth="1.5" />

          {/* Grid lines */}
          {gridLines}

          {/* Axis labels */}
          {xLabels}
          {yLabels}

          {/* Distance ranging circle from Beacon 1 */}
          {beacon1Dist && beacon1Dist > 0 && (
            <G>
              <Circle
                cx={b1s.sx}
                cy={b1s.sy}
                r={(beacon1Dist / ROOM_WIDTH_FT) * mapWidth}
                stroke="#0ea5e9"
                strokeWidth="1.5"
                strokeDasharray="4,4"
                fill="none"
                opacity={0.4}
              />
              <SvgText
                x={b1s.sx}
                y={Math.max(PAD + 12, b1s.sy - (beacon1Dist / ROOM_WIDTH_FT) * mapWidth - 4)}
                fontSize="8.5"
                fill="#0284c7"
                fontWeight="700"
                textAnchor="middle"
              >
                {beacon1Dist.toFixed(1)} ft
              </SvgText>
            </G>
          )}

          {/* Distance ranging circle from Beacon 2 */}
          {beacon2Dist && beacon2Dist > 0 && (
            <G>
              <Circle
                cx={b2s.sx}
                cy={b2s.sy}
                r={(beacon2Dist / ROOM_WIDTH_FT) * mapWidth}
                stroke="#8b5cf6"
                strokeWidth="1.5"
                strokeDasharray="4,4"
                fill="none"
                opacity={0.4}
              />
              <SvgText
                x={b2s.sx}
                y={Math.max(PAD + 12, b2s.sy - (beacon2Dist / ROOM_WIDTH_FT) * mapWidth - 4)}
                fontSize="8.5"
                fill="#7c3aed"
                fontWeight="700"
                textAnchor="middle"
              >
                {beacon2Dist.toFixed(1)} ft
              </SvgText>
            </G>
          )}

          {/* Ground Truth Validation Target & Line */}
          {gtS && (
            <G>
              <Line
                x1={userS.sx}
                y1={userS.sy}
                x2={gtS.sx}
                y2={gtS.sy}
                stroke="#e11d48"
                strokeWidth="1.8"
                strokeDasharray="3,3"
              />
              {/* Target Bullseye */}
              <Circle cx={gtS.sx} cy={gtS.sy} r="14" fill="#e11d48" opacity={0.15} />
              <Circle cx={gtS.sx} cy={gtS.sy} r="8" fill="#e11d48" opacity={0.3} />
              <Circle cx={gtS.sx} cy={gtS.sy} r="3.5" fill="#e11d48" />
              <SvgText x={gtS.sx} y={gtS.sy + 16} fontSize="8.5" fill="#be123c" fontWeight="bold" textAnchor="middle">
                TARGET ({groundTruth.x.toFixed(1)}, {groundTruth.y.toFixed(1)})
              </SvgText>
            </G>
          )}

          {/* Trail */}
          {trail && trail.length > 1 && (
            <Polyline
              points={trailPts}
              fill="none"
              stroke="#6366f1"
              strokeWidth="2.5"
              strokeLinejoin="round"
              strokeLinecap="round"
              opacity={0.7}
            />
          )}

          {/* Debug overlays — raw BLE & PDR dots */}
          {showDebugOverlays && bleS && (
            <G>
              <Circle cx={bleS.sx} cy={bleS.sy} r="5" fill="#f59e0b" opacity={0.75} />
              <SvgText x={bleS.sx + 7} y={bleS.sy + 4} fontSize="9" fill="#b45309" fontWeight="600">BLE</SvgText>
            </G>
          )}
          {showDebugOverlays && pdrS && (
            <G>
              <Circle cx={pdrS.sx} cy={pdrS.sy} r="5" fill="#10b981" opacity={0.75} />
              <SvgText x={pdrS.sx + 7} y={pdrS.sy + 4} fontSize="9" fill="#047857" fontWeight="600">PDR</SvgText>
            </G>
          )}

          {/* User Position Marker with Heading Cone */}
          <G>
            {/* Heading Pointer Arrow */}
            <G transform={`rotate(${heading || 0}, ${userS.sx}, ${userS.sy})`}>
              <Polygon
                points={`${userS.sx},${userS.sy - 18} ${userS.sx - 5.5},${userS.sy - 7} ${userS.sx + 5.5},${userS.sy - 7}`}
                fill="#2563eb"
                opacity={0.85}
              />
            </G>

            {/* Pulse rings */}
            <Circle cx={userS.sx} cy={userS.sy} r="18" fill="#2563eb" opacity={0.12} />
            <Circle cx={userS.sx} cy={userS.sy} r="10" fill="#2563eb" opacity={0.25} />
            {/* Center dot */}
            <Circle cx={userS.sx} cy={userS.sy} r="7" fill="#1d4ed8" stroke="#ffffff" strokeWidth="2" />
            <SvgText x={userS.sx} y={userS.sy + 18} fontSize="10"
              fill="#1e3a8a" fontWeight="bold" textAnchor="middle">YOU</SvgText>
            <SvgText x={userS.sx} y={userS.sy + 29} fontSize="8.5"
              fill="#2563eb" fontWeight="700" textAnchor="middle">
              {curX.toFixed(1)}, {curY.toFixed(1)} ft
            </SvgText>
          </G>

          {/* Beacon 1 Marker (Smooth draggable with enlarged hit target) */}
          <G {...(isSetupMode ? pan1.panHandlers : {})}>
            {/* Invisible 64px touch target for effortless dragging */}
            {isSetupMode && (
              <Circle cx={b1s.sx} cy={b1s.sy} r="32" fill="transparent" />
            )}
            {/* Active drag halo */}
            {activeDrag === "b1" && (
              <Circle cx={b1s.sx} cy={b1s.sy} r="24" fill="#0ea5e9" opacity={0.3} />
            )}
            <Circle cx={b1s.sx} cy={b1s.sy} r="15" fill="#0ea5e9" opacity={0.2} />
            <Circle cx={b1s.sx} cy={b1s.sy} r="10" fill="#0ea5e9" stroke="#ffffff" strokeWidth="2" />
            <SvgText x={b1s.sx} y={b1s.sy + 4} fontSize="9"
              fill="#ffffff" fontWeight="bold" textAnchor="middle">B1</SvgText>
            <SvgText x={b1s.sx} y={b1s.sy + 22} fontSize="8.5"
              fill="#0369a1" fontWeight="600" textAnchor="middle">
              {(beacon1?.x ?? 0).toFixed(1)},{(beacon1?.y ?? 0).toFixed(1)}ft
            </SvgText>
          </G>

          {/* Beacon 2 Marker (Smooth draggable with enlarged hit target) */}
          <G {...(isSetupMode ? pan2.panHandlers : {})}>
            {/* Invisible 64px touch target for effortless dragging */}
            {isSetupMode && (
              <Circle cx={b2s.sx} cy={b2s.sy} r="32" fill="transparent" />
            )}
            {/* Active drag halo */}
            {activeDrag === "b2" && (
              <Circle cx={b2s.sx} cy={b2s.sy} r="24" fill="#8b5cf6" opacity={0.3} />
            )}
            <Circle cx={b2s.sx} cy={b2s.sy} r="15" fill="#8b5cf6" opacity={0.2} />
            <Circle cx={b2s.sx} cy={b2s.sy} r="10" fill="#8b5cf6" stroke="#ffffff" strokeWidth="2" />
            <SvgText x={b2s.sx} y={b2s.sy + 4} fontSize="9"
              fill="#ffffff" fontWeight="bold" textAnchor="middle">B2</SvgText>
            <SvgText x={b2s.sx} y={b2s.sy + 22} fontSize="8.5"
              fill="#6d28d9" fontWeight="600" textAnchor="middle">
              {(beacon2?.x ?? 0).toFixed(1)},{(beacon2?.y ?? 0).toFixed(1)}ft
            </SvgText>
          </G>
        </Svg>
      </View>

      {/* Legend */}
      <View style={styles.legend}>
        <LegendDot color="#1d4ed8" label="You (Heading)" />
        <LegendDot color="#0ea5e9" label="Beacon 1" />
        <LegendDot color="#8b5cf6" label="Beacon 2" />
        <LegendDot color="#6366f1" label="Trail" />
        {groundTruth && <LegendDot color="#e11d48" label="Target Pin" />}
        {showDebugOverlays && <LegendDot color="#f59e0b" label="Raw BLE" />}
        {showDebugOverlays && <LegendDot color="#10b981" label="PDR" />}
      </View>
    </View>
  );
}

function LegendDot({ color, label }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <Text style={styles.legendText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: "#ffffff",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    marginBottom: 12,
    overflow: "hidden",
    width: "100%",
  },
  svgWrapper: {
    width: "100%",
    alignItems: "center",
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 4,
  },
  title: { fontWeight: "700", fontSize: 13, color: "#334155" },
  hint:  { fontSize: 11, color: "#0284c7", fontWeight: "600" },
  hintTap: { fontSize: 11, color: "#e11d48", fontWeight: "600" },
  legend: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    paddingHorizontal: 14,
    paddingBottom: 12,
    paddingTop: 4,
  },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 5 },
  legendDot:  { width: 10, height: 10, borderRadius: 5 },
  legendText: { fontSize: 10, color: "#64748b", fontWeight: "600" },
});

