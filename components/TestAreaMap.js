// ============================================================================
// TestAreaMap — SVG 18×15 ft Indoor Room Map
// Renders beacon markers (draggable in setup mode), user position, trail, grid.
// Uses react-native-svg (already installed) + PanResponder for drag-and-drop.
// ============================================================================

import React, { useRef, useCallback } from "react";
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
  beacon1,          // { x, y } in feet
  beacon2,          // { x, y } in feet
  beacon1Dist,      // estimated distance to B1 in feet
  beacon2Dist,      // estimated distance to B2 in feet
  userPosition,     // { fusedX, fusedY } — fused position
  blePosition,      // { bleX, bleY }   — raw BLE (optional overlay)
  pdrPosition,      // { pdrX, pdrY }   // PDR (optional overlay)
  trail,            // [{ x, y }, ...] in feet
  isSetupMode,      // true → beacons draggable
  showDebugOverlays,// show raw BLE + PDR dots
  onBeacon1Move,    // (x, y) called during drag
  onBeacon2Move,    // (x, y) called during drag
}) {
  // Compute map size — maintain 18:15 aspect ratio and fit inside screen
  // screenWidth minus the ScrollView padding (16 each side) minus extra room for safety
  const screenWidth = Dimensions.get("window").width;
  const PAD = 24;  // label padding inside the SVG canvas
  // Available width for the full SVG canvas (room + PAD on each side)
  const availableWidth = screenWidth - 32;  // 16px padding each side from ScrollView
  const svgW    = availableWidth;
  const mapWidth  = Math.max(100, svgW - PAD * 2);   // room area width
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

  // ─── PanResponder for Beacon 1 ────────────────────────────────────────────
  const b1ScreenRef = useRef(toScreen(beacon1?.x ?? 0, beacon1?.y ?? ROOM_HEIGHT_FT));
  const pan1 = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => isSetupMode,
      onMoveShouldSetPanResponder:  () => isSetupMode,
      onPanResponderMove: (_, gestureState) => {
        const sx = b1ScreenRef.current.sx + gestureState.dx;
        const sy = b1ScreenRef.current.sy + gestureState.dy;
        const { realX, realY } = fromScreen(sx, sy);
        const clamped = clampToRoom(realX, realY);
        onBeacon1Move?.(clamped.x, clamped.y);
      },
      onPanResponderRelease: (_, gestureState) => {
        const sx = b1ScreenRef.current.sx + gestureState.dx;
        const sy = b1ScreenRef.current.sy + gestureState.dy;
        const { realX, realY } = fromScreen(sx, sy);
        const clamped = clampToRoom(realX, realY);
        b1ScreenRef.current = toScreen(clamped.x, clamped.y);
        onBeacon1Move?.(clamped.x, clamped.y);
      },
    }),
  ).current;

  // ─── PanResponder for Beacon 2 ────────────────────────────────────────────
  const b2ScreenRef = useRef(toScreen(beacon2?.x ?? ROOM_WIDTH_FT, beacon2?.y ?? ROOM_HEIGHT_FT));
  const pan2 = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => isSetupMode,
      onMoveShouldSetPanResponder:  () => isSetupMode,
      onPanResponderMove: (_, gestureState) => {
        const sx = b2ScreenRef.current.sx + gestureState.dx;
        const sy = b2ScreenRef.current.sy + gestureState.dy;
        const { realX, realY } = fromScreen(sx, sy);
        const clamped = clampToRoom(realX, realY);
        onBeacon2Move?.(clamped.x, clamped.y);
      },
      onPanResponderRelease: (_, gestureState) => {
        const sx = b2ScreenRef.current.sx + gestureState.dx;
        const sy = b2ScreenRef.current.sy + gestureState.dy;
        const { realX, realY } = fromScreen(sx, sy);
        const clamped = clampToRoom(realX, realY);
        b2ScreenRef.current = toScreen(clamped.x, clamped.y);
        onBeacon2Move?.(clamped.x, clamped.y);
      },
    }),
  ).current;

  // Update screen refs when beacon positions change from outside
  b1ScreenRef.current = toScreen(beacon1?.x ?? 0,             beacon1?.y ?? ROOM_HEIGHT_FT);
  b2ScreenRef.current = toScreen(beacon2?.x ?? ROOM_WIDTH_FT, beacon2?.y ?? ROOM_HEIGHT_FT);

  // ─── Positions in screen space ────────────────────────────────────────────
  const b1s  = b1ScreenRef.current;
  const b2s  = b2ScreenRef.current;
  const userS = toScreen(userPosition?.fusedX ?? 9, userPosition?.fusedY ?? 7.5);
  const bleS  = blePosition  ? toScreen(blePosition.bleX,  blePosition.bleY)  : null;
  const pdrS  = pdrPosition  ? toScreen(pdrPosition.pdrX,  pdrPosition.pdrY)  : null;

  // Trail polyline string
  const trailPts = (trail || [])
    .map(p => { const s = toScreen(p.x, p.y); return `${s.sx.toFixed(1)},${s.sy.toFixed(1)}`; })
    .join(" ");

  // Grid lines
  const gridLines = [];
  for (let gx = 0; gx <= ROOM_WIDTH_FT; gx += GRID_STEP_FT) {
    const { sx } = toScreen(gx, 0);
    const { sy: sy0 } = toScreen(gx, 0);
    const { sy: sy1 } = toScreen(gx, ROOM_HEIGHT_FT);
    gridLines.push(
      <Line key={`vg${gx}`} x1={sx} y1={PAD} x2={sx} y2={PAD + mapHeight}
        stroke="#e1e4e8" strokeWidth={gx === 0 || gx === ROOM_WIDTH_FT ? 1.5 : 0.8} />,
    );
  }
  for (let gy = 0; gy <= ROOM_HEIGHT_FT; gy += GRID_STEP_FT) {
    const { sy } = toScreen(0, gy);
    gridLines.push(
      <Line key={`hg${gy}`} x1={PAD} y1={sy} x2={PAD + mapWidth} y2={sy}
        stroke="#e1e4e8" strokeWidth={gy === 0 || gy === ROOM_HEIGHT_FT ? 1.5 : 0.8} />,
    );
  }

  // Axis labels
  const xLabels = [0, 6, 12, 18].map(ft => {
    const { sx } = toScreen(ft, 0);
    return (
      <SvgText key={`xl${ft}`} x={sx} y={PAD + mapHeight + 16}
        fontSize="9" fill="#8c959f" textAnchor="middle">{ft}ft</SvgText>
    );
  });
  const yLabels = [0, 5, 10, 15].map(ft => {
    const { sy } = toScreen(0, ft);
    return (
      <SvgText key={`yl${ft}`} x={PAD - 4} y={sy + 4}
        fontSize="9" fill="#8c959f" textAnchor="end">{ft}ft</SvgText>
    );
  });

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>18 × 15 ft Map</Text>
        {isSetupMode && (
          <Text style={styles.hint}>Drag B1 / B2 to place beacons</Text>
        )}
      </View>

      <View style={styles.svgWrapper}>
        <Svg width={svgW} height={svgH}>
        {/* Room background */}
        <Rect x={PAD} y={PAD} width={mapWidth} height={mapHeight}
          fill="#f8fafc" rx="4" stroke="#d0d7de" strokeWidth="1.5" />

        {/* Grid */}
        {gridLines}

        {/* Axis labels */}
        {xLabels}
        {yLabels}

        {/* Distance ranging circles from Beacon 1 and Beacon 2 */}
        {beacon1Dist && beacon1Dist > 0 && (
          <Circle
            cx={b1s.sx}
            cy={b1s.sy}
            r={(beacon1Dist / ROOM_WIDTH_FT) * mapWidth}
            stroke="#0ea5e9"
            strokeWidth="1.5"
            strokeDasharray="4,4"
            fill="none"
            opacity={0.35}
          />
        )}
        {beacon2Dist && beacon2Dist > 0 && (
          <Circle
            cx={b2s.sx}
            cy={b2s.sy}
            r={(beacon2Dist / ROOM_WIDTH_FT) * mapWidth}
            stroke="#8b5cf6"
            strokeWidth="1.5"
            strokeDasharray="4,4"
            fill="none"
            opacity={0.35}
          />
        )}

        {/* Trail */}
        {trail && trail.length > 1 && (
          <Polyline points={trailPts} fill="none"
            stroke="#7c3aed" strokeWidth="2.5"
            strokeLinejoin="round" strokeLinecap="round"
            opacity={0.65} />
        )}

        {/* Debug overlays — raw BLE & PDR dots */}
        {showDebugOverlays && bleS && (
          <G>
            <Circle cx={bleS.sx} cy={bleS.sy} r="5" fill="#f59e0b" opacity={0.7} />
            <SvgText x={bleS.sx + 7} y={bleS.sy + 4} fontSize="9" fill="#b45309">BLE</SvgText>
          </G>
        )}
        {showDebugOverlays && pdrS && (
          <G>
            <Circle cx={pdrS.sx} cy={pdrS.sy} r="5" fill="#10b981" opacity={0.7} />
            <SvgText x={pdrS.sx + 7} y={pdrS.sy + 4} fontSize="9" fill="#047857">PDR</SvgText>
          </G>
        )}

        {/* User position marker */}
        <G>
          {/* Pulse ring */}
          <Circle cx={userS.sx} cy={userS.sy} r="18" fill="#1d4ed8" opacity={0.12} />
          <Circle cx={userS.sx} cy={userS.sy} r="11" fill="#1d4ed8" opacity={0.25} />
          {/* Main marker */}
          <Circle cx={userS.sx} cy={userS.sy} r="7.5" fill="#1d4ed8" stroke="#fff" strokeWidth="2" />
          <SvgText x={userS.sx} y={userS.sy + 18} fontSize="10"
            fill="#1e3a8a" fontWeight="bold" textAnchor="middle">YOU</SvgText>
          <SvgText x={userS.sx} y={userS.sy + 30} fontSize="8.5"
            fill="#1d4ed8" fontWeight="600" textAnchor="middle">
            {(userPosition?.fusedX ?? 9).toFixed(1)}, {(userPosition?.fusedY ?? 7.5).toFixed(1)} ft
          </SvgText>
        </G>

        {/* Beacon 1 marker */}
        <G {...(isSetupMode ? pan1.panHandlers : {})}>
          <Circle cx={b1s.sx} cy={b1s.sy} r="14" fill="#0ea5e9" opacity={0.2} />
          <Circle cx={b1s.sx} cy={b1s.sy} r="9.5"  fill="#0ea5e9" stroke="#fff" strokeWidth="1.5" />
          <SvgText x={b1s.sx} y={b1s.sy + 4} fontSize="9"
            fill="#fff" fontWeight="bold" textAnchor="middle">B1</SvgText>
          <SvgText x={b1s.sx} y={b1s.sy + 20} fontSize="8"
            fill="#0369a1" textAnchor="middle">
            {(beacon1?.x ?? 0).toFixed(1)},{(beacon1?.y ?? 0).toFixed(1)}ft
          </SvgText>
        </G>

        {/* Beacon 2 marker */}
        <G {...(isSetupMode ? pan2.panHandlers : {})}>
          <Circle cx={b2s.sx} cy={b2s.sy} r="14" fill="#8b5cf6" opacity={0.2} />
          <Circle cx={b2s.sx} cy={b2s.sy} r="9.5"  fill="#8b5cf6" stroke="#fff" strokeWidth="1.5" />
          <SvgText x={b2s.sx} y={b2s.sy + 4} fontSize="9"
            fill="#fff" fontWeight="bold" textAnchor="middle">B2</SvgText>
          <SvgText x={b2s.sx} y={b2s.sy + 20} fontSize="8"
            fill="#6d28d9" textAnchor="middle">
            {(beacon2?.x ?? 0).toFixed(1)},{(beacon2?.y ?? 0).toFixed(1)}ft
          </SvgText>
        </G>
      </Svg>
      </View>

      {/* Legend */}
      <View style={styles.legend}>
        <LegendDot color="#1d4ed8" label="You (Fused)" />
        <LegendDot color="#0ea5e9" label="Beacon 1" />
        <LegendDot color="#8b5cf6" label="Beacon 2" />
        <LegendDot color="#7c3aed" label="Trail" />
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
    backgroundColor: "#fff",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#d0d7de",
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
  title: { fontWeight: "700", fontSize: 13, color: "#57606a" },
  hint:  { fontSize: 11,  color: "#0969da", fontStyle: "italic" },
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
  legendText: { fontSize: 10, color: "#57606a", fontWeight: "600" },
});
