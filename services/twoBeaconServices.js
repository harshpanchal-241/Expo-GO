// ============================================================================
// TWO-BEACON INDOOR POSITIONING SERVICES
// All positioning math lives here. Completely isolated from existing PDR/BLE.
// ============================================================================

import { OneEuroFilter } from "./BleScannerService.js";

// ============================================================================
// ROOM CONSTANTS
// ============================================================================
export const ROOM_WIDTH_FT  = 18;  // X: 0 → 18 ft
export const ROOM_HEIGHT_FT = 15;  // Y: 0 → 15 ft

// ============================================================================
// COORDINATE CONVERTER  (feet ↔ screen pixels)
// ============================================================================
export function feetToScreen(realX, realY, mapPixelWidth, mapPixelHeight) {
  return {
    sx: (realX / ROOM_WIDTH_FT)  * mapPixelWidth,
    sy: mapPixelHeight - (realY / ROOM_HEIGHT_FT) * mapPixelHeight,
  };
}

export function screenToFeet(sx, sy, mapPixelWidth, mapPixelHeight) {
  return {
    realX: (sx / mapPixelWidth)  * ROOM_WIDTH_FT,
    realY: ((mapPixelHeight - sy) / mapPixelHeight) * ROOM_HEIGHT_FT,
  };
}

export function clampToRoom(x, y) {
  return {
    x: Math.max(0, Math.min(ROOM_WIDTH_FT,  x)),
    y: Math.max(0, Math.min(ROOM_HEIGHT_FT, y)),
  };
}

// ============================================================================
// RSSI FILTER PIPELINE (per-beacon)
// ============================================================================
const RSSI_BUFFER_SIZE = 5;      // rolling sample buffer
const RSSI_MIN = -115;           // reject impossible low
const RSSI_MAX = -10;            // reject impossible high

export class RssiFilterPipeline {
  constructor() {
    this.buffer       = [];
    this.oneEuro      = new OneEuroFilter(1.0, 0.3);  // smooth for positioning
    this.rawRssi      = null;
    this.filteredRssi = null;
    this.lastSeen     = null;
  }

  addPacket(rawRssi, timestamp = Date.now()) {
    if (typeof rawRssi !== "number" || isNaN(rawRssi)) return false;
    if (rawRssi < RSSI_MIN || rawRssi > RSSI_MAX) return false;  // outlier reject

    this.rawRssi  = rawRssi;
    this.lastSeen = timestamp;

    // Rolling buffer
    this.buffer.push(rawRssi);
    if (this.buffer.length > RSSI_BUFFER_SIZE) this.buffer.shift();

    // Median
    const sorted = [...this.buffer].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    // One-Euro on top of median
    this.filteredRssi = this.oneEuro.filter(median, timestamp);
    return true;
  }

  getState() {
    return {
      rawRssi:      this.rawRssi,
      filteredRssi: this.filteredRssi !== null ? Math.round(this.filteredRssi) : null,
      lastSeen:     this.lastSeen,
    };
  }

  reset() {
    this.buffer       = [];
    this.oneEuro      = new OneEuroFilter(1.0, 0.3);
    this.rawRssi      = null;
    this.filteredRssi = null;
    this.lastSeen     = null;
  }

  // Collect calibration samples for N ms, return median RSSI
  async collectCalibration(durationMs = 3000, onProgress) {
    return new Promise(resolve => {
      const samples = [];
      const start   = Date.now();
      const interval = setInterval(() => {
        if (this.rawRssi !== null) samples.push(this.rawRssi);
        const elapsed = Date.now() - start;
        if (onProgress) onProgress(elapsed / durationMs);
        if (elapsed >= durationMs) {
          clearInterval(interval);
          if (samples.length === 0) { resolve(null); return; }
          const sorted = [...samples].sort((a, b) => a - b);
          resolve(sorted[Math.floor(sorted.length / 2)]);
        }
      }, 100);
    });
  }
}

// ============================================================================
// RSSI → DISTANCE  (path-loss model, returns meters then converted to feet)
// ============================================================================
export function rssiToDistance(filteredRssi, txPower, n) {
  if (filteredRssi === null || filteredRssi === 0) return null;
  const ratio    = (txPower - filteredRssi) / (10 * n);
  const meters   = Math.pow(10, ratio);
  const feet     = meters * 3.28084;
  return isFinite(feet) && feet >= 0 ? feet : null;
}

// ============================================================================
// HEIGHT CORRECTION  (slant → horizontal distance, in same units)
// ============================================================================
export function applyHeightCorrection(slantDist, beaconHeightFt, phoneHeightFt) {
  if (slantDist === null) return { correctedDist: null, heightValidity: 0 };
  const vertDiff = Math.abs(beaconHeightFt - phoneHeightFt);
  const slantSq  = slantDist * slantDist;
  const vertSq   = vertDiff  * vertDiff;

  if (slantDist < vertDiff) {
    // Physically inconsistent reading
    return { correctedDist: 0, heightValidity: 0.1 };
  }
  const horizontal = Math.sqrt(Math.max(0, slantSq - vertSq));
  const validity   = Math.min(1, slantDist / Math.max(1, vertDiff + 1));
  return { correctedDist: horizontal, heightValidity: validity };
}

// ============================================================================
// RSSI STABILITY SCORE  (based on std-dev of recent raw RSSI values)
// ============================================================================
function stabilityScore(rssiBuffer) {
  if (!rssiBuffer || rssiBuffer.length < 2) return 0.5;
  const mean = rssiBuffer.reduce((s, v) => s + v, 0) / rssiBuffer.length;
  const variance = rssiBuffer.reduce((s, v) => s + (v - mean) ** 2, 0) / rssiBuffer.length;
  const stdDev = Math.sqrt(variance);
  // stdDev < 2 → excellent, > 10 → very noisy
  return Math.max(0, Math.min(1, 1 - (stdDev / 10)));
}

// ============================================================================
// WEIGHTING ENGINE
// ============================================================================
const WEIGHT_COEFFICIENTS = {
  stability:         0.30,
  strength:          0.20,
  freshness:         0.15,
  distance:          0.15,
  motionConsistency: 0.15,
  heightValidity:    0.05,
};

export function computeWeight({
  rssiBuffer,          // recent raw RSSI history array
  filteredRssi,        // latest filtered RSSI (dBm)
  lastSeenMs,          // ms since last packet
  distanceFt,          // estimated horizontal distance in ft
  prevDistanceFt,      // previous distance estimate
  prevPosition,        // { x, y }
  blePosition,         // { x, y } — raw BLE estimate
  heightValidity = 1,  // 0..1 from height correction
  heightCorrectionOn = false,
}) {
  // 1. Stability
  const stab = stabilityScore(rssiBuffer);

  // 2. Strength
  let strength;
  if      (filteredRssi > -60)  strength = 1.0;
  else if (filteredRssi > -70)  strength = 0.75;
  else if (filteredRssi > -80)  strength = 0.45;
  else if (filteredRssi > -88)  strength = 0.20;
  else                          strength = 0.05;

  // 3. Freshness
  let fresh;
  if      (lastSeenMs < 200)    fresh = 1.0;
  else if (lastSeenMs < 500)    fresh = 0.75;
  else if (lastSeenMs < 1000)   fresh = 0.40;
  else if (lastSeenMs < 2000)   fresh = 0.15;
  else                          fresh = 0.0;

  // 4. Distance reliability (penalise very large estimates)
  let distScore;
  if      (distanceFt === null) distScore = 0;
  else if (distanceFt < 5)      distScore = 1.0;
  else if (distanceFt < 10)     distScore = 0.75;
  else if (distanceFt < 18)     distScore = 0.45;
  else                          distScore = 0.15;

  // 5. Motion consistency
  let motionScore = 0.5;  // default neutral
  if (prevPosition && blePosition) {
    const jumpDist = Math.hypot(
      blePosition.x - prevPosition.x,
      blePosition.y - prevPosition.y,
    );
    // If position jumps > 5 ft in < 1 update cycle → likely noise
    if      (jumpDist < 1)   motionScore = 1.0;
    else if (jumpDist < 2.5) motionScore = 0.75;
    else if (jumpDist < 5)   motionScore = 0.45;
    else                     motionScore = 0.1;
  }

  // 6. Height validity (only matters when height correction is ON)
  const hv = heightCorrectionOn ? heightValidity : 1.0;

  const c = WEIGHT_COEFFICIENTS;
  let weight =
    c.stability         * stab        +
    c.strength          * strength    +
    c.freshness         * fresh       +
    c.distance          * distScore   +
    c.motionConsistency * motionScore +
    c.heightValidity    * hv;

  if (!heightCorrectionOn) {
    // Redistribute height coefficient to stability when not used
    weight += c.heightValidity * stab;
    weight = Math.min(1, weight);
  }

  return Math.max(0, Math.min(1, weight));
}

// ============================================================================
// TWO-BEACON POSITION SOLVER  (coarse-to-fine grid search)
// ============================================================================
export function solveTwoBeaconPosition(b1, b2, d1, d2, w1, w2, prevX = 9, prevY = 7.5) {
  // b1/b2 = { x, y }  in feet
  // d1/d2 = estimated distances to B1/B2 in feet
  // w1/w2 = weights 0..1

  if (d1 === null && d2 === null) return { x: prevX, y: prevY, confidence: 0 };

  const safeW1 = d1 !== null ? w1 : 0;
  const safeW2 = d2 !== null ? w2 : 0;
  const totalW = safeW1 + safeW2;

  if (totalW === 0) return { x: prevX, y: prevY, confidence: 0 };

  // If only one beacon available — constrain along its circle, biased to prev
  if (d1 === null || safeW1 < 0.05) return _oneBeaconEstimate(b2, d2, prevX, prevY);
  if (d2 === null || safeW2 < 0.05) return _oneBeaconEstimate(b1, d1, prevX, prevY);

  // Coarse pass: 18×15 grid at 0.5 ft resolution
  const coarseStep = 0.5;
  let bestX = prevX, bestY = prevY, bestErr = Infinity;

  for (let x = 0; x <= ROOM_WIDTH_FT; x += coarseStep) {
    for (let y = 0; y <= ROOM_HEIGHT_FT; y += coarseStep) {
      const distToB1 = Math.hypot(x - b1.x, y - b1.y);
      const distToB2 = Math.hypot(x - b2.x, y - b2.y);
      const err =
        safeW1 * (distToB1 - d1) ** 2 +
        safeW2 * (distToB2 - d2) ** 2;
      if (err < bestErr) { bestErr = err; bestX = x; bestY = y; }
    }
  }

  // Fine pass: 1 ft region around coarse best at 0.05 ft resolution
  const fineStep = 0.05;
  const fineRange = 1.0;
  for (let x = bestX - fineRange; x <= bestX + fineRange; x += fineStep) {
    for (let y = bestY - fineRange; y <= bestY + fineRange; y += fineStep) {
      const cx = Math.max(0, Math.min(ROOM_WIDTH_FT,  x));
      const cy = Math.max(0, Math.min(ROOM_HEIGHT_FT, y));
      const distToB1 = Math.hypot(cx - b1.x, cy - b1.y);
      const distToB2 = Math.hypot(cx - b2.x, cy - b2.y);
      const err =
        safeW1 * (distToB1 - d1) ** 2 +
        safeW2 * (distToB2 - d2) ** 2;
      if (err < bestErr) { bestErr = err; bestX = cx; bestY = cy; }
    }
  }

  const clamped  = clampToRoom(bestX, bestY);
  const totalErr = Math.sqrt(bestErr / (safeW1 + safeW2));
  const confidence = Math.max(0, Math.min(1, 1 - totalErr / 10));

  return { x: clamped.x, y: clamped.y, confidence };
}

function _oneBeaconEstimate(beacon, dist, prevX, prevY) {
  // Use bearing from beacon toward previous position, at dist
  const angle = Math.atan2(prevY - beacon.y, prevX - beacon.x);
  const ex    = beacon.x + dist * Math.cos(angle);
  const ey    = beacon.y + dist * Math.sin(angle);
  const clamped = clampToRoom(ex, ey);
  return { x: clamped.x, y: clamped.y, confidence: 0.3 };
}

// ============================================================================
// ADAPTIVE KALMAN FILTER 2D  (X, Y independent 1D filters)
// ============================================================================
export class AdaptiveKalman2D {
  constructor() {
    this.reset();
  }

  reset(initX = 9, initY = 7.5) {
    // State estimate
    this.x  = initX;
    this.y  = initY;
    // Error covariance
    this.Px = 10;
    this.Py = 10;
    // Process noise (PDR uncertainty grows with each step)
    this.Qx = 0.1;
    this.Qy = 0.1;
    // Measurement noise (BLE) — adapted by confidence
    this.R_base = 2.0;
  }

  /**
   * PDR prediction step.
   * dx/dy in feet.
   */
  predict(dx, dy) {
    this.x  += dx;
    this.y  += dy;
    this.Px += this.Qx;
    this.Py += this.Qy;
    // Clamp to room
    const c = clampToRoom(this.x, this.y);
    this.x = c.x; this.y = c.y;
  }

  /**
   * BLE measurement update.
   * bleX/bleY in feet.
   * confidence 0..1 (high = trust BLE more = lower R)
   */
  update(bleX, bleY, confidence) {
    if (bleX === null || bleY === null || isNaN(bleX) || isNaN(bleY)) return;

    const clampedConf = Math.max(0.01, Math.min(1, confidence));
    // Adaptive R: high confidence → small R → believe BLE
    const R = this.R_base / clampedConf;

    // Kalman gain
    const Kx = this.Px / (this.Px + R);
    const Ky = this.Py / (this.Py + R);

    // Update estimate
    this.x += Kx * (bleX - this.x);
    this.y += Ky * (bleY - this.y);

    // Update covariance
    this.Px = (1 - Kx) * this.Px;
    this.Py = (1 - Ky) * this.Py;

    // Clamp
    const c = clampToRoom(this.x, this.y);
    this.x = c.x; this.y = c.y;
  }

  getPosition() {
    return { x: this.x, y: this.y };
  }
}

// ============================================================================
// MOVEMENT SANITY CHECK  (prevent teleport)
// ============================================================================
export function isSaneMovement(prevX, prevY, newX, newY, dtMs) {
  if (dtMs <= 0) return false;
  const distFt    = Math.hypot(newX - prevX, newY - prevY);
  const speedFtS  = distFt / (dtMs / 1000);
  // Normal human walking max ~10 ft/s
  return speedFtS <= 10;
}
