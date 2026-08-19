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
// TWO-BEACON POSITION SOLVER
// Fast analytical circle intersection + weighted least-squares refinement
// ============================================================================
export function solveTwoBeaconPosition(b1, b2, d1, d2, w1, w2, prevX = 9, prevY = 7.5) {
  // b1/b2 = { x, y } in feet
  // d1/d2 = estimated distances to B1/B2 in feet
  // w1/w2 = weights 0..1

  if ((d1 === null || isNaN(d1)) && (d2 === null || isNaN(d2))) {
    return { x: prevX, y: prevY, confidence: 0 };
  }

  const safeW1 = (d1 !== null && !isNaN(d1)) ? Math.max(0, w1) : 0;
  const safeW2 = (d2 !== null && !isNaN(d2)) ? Math.max(0, w2) : 0;
  const totalW = safeW1 + safeW2;

  if (totalW === 0) return { x: prevX, y: prevY, confidence: 0 };

  // If only one beacon available — constrain along its circle, biased to prev position
  if (d1 === null || isNaN(d1) || safeW1 < 0.05) return _oneBeaconEstimate(b2, d2, prevX, prevY);
  if (d2 === null || isNaN(d2) || safeW2 < 0.05) return _oneBeaconEstimate(b1, d1, prevX, prevY);

  // Both beacons available — analytical 2-circle intersection
  const dx = b2.x - b1.x;
  const dy = b2.y - b1.y;
  const D = Math.hypot(dx, dy);

  let candidateX = prevX;
  let candidateY = prevY;

  if (D > 0.1) {
    const ux = dx / D;
    const uy = dy / D;

    // Baseline projection distance from B1
    let a = (d1 * d1 - d2 * d2 + D * D) / (2 * D);
    // Clamp 'a' to reasonable bounds between beacons
    if (d1 + d2 < D) {
      // Circles too small to touch — take proportional point along baseline
      a = (d1 / (d1 + d2)) * D;
    } else if (Math.abs(d1 - d2) > D) {
      // One circle inside another
      a = d1 < d2 ? d1 : D - d2;
    }

    const hSq = d1 * d1 - a * a;
    const p0x = b1.x + a * ux;
    const p0y = b1.y + a * uy;

    if (hSq > 0) {
      const h = Math.sqrt(hSq);
      // Two possible intersection points (perpendicular to baseline)
      const p1x = p0x - h * uy;
      const p1y = p0y + h * ux;
      const p2x = p0x + h * uy;
      const p2y = p0y - h * ux;

      // Pick the point inside the room [0..18, 0..15] or closest to previous / room center
      const p1In = p1x >= -0.5 && p1x <= ROOM_WIDTH_FT + 0.5 && p1y >= -0.5 && p1y <= ROOM_HEIGHT_FT + 0.5;
      const p2In = p2x >= -0.5 && p2x <= ROOM_WIDTH_FT + 0.5 && p2y >= -0.5 && p2y <= ROOM_HEIGHT_FT + 0.5;

      if (p1In && !p2In) {
        candidateX = p1x; candidateY = p1y;
      } else if (p2In && !p1In) {
        candidateX = p2x; candidateY = p2y;
      } else {
        // Both in or both out — choose closest to previous position
        const dist1 = Math.hypot(p1x - prevX, p1y - prevY);
        const dist2 = Math.hypot(p2x - prevX, p2y - prevY);
        if (dist1 <= dist2) {
          candidateX = p1x; candidateY = p1y;
        } else {
          candidateX = p2x; candidateY = p2y;
        }
      }
    } else {
      // Midpoint on baseline
      candidateX = p0x;
      candidateY = p0y;
    }
  }

  // Fine-tune around candidate with localized least-squares search
  let bestX = candidateX;
  let bestY = candidateY;
  let bestErr = Infinity;
  const searchRange = 2.0; // 2 ft around analytical solution
  const step = 0.2;        // 0.2 ft precision

  for (let x = Math.max(0, candidateX - searchRange); x <= Math.min(ROOM_WIDTH_FT, candidateX + searchRange); x += step) {
    for (let y = Math.max(0, candidateY - searchRange); y <= Math.min(ROOM_HEIGHT_FT, candidateY + searchRange); y += step) {
      const dist1 = Math.hypot(x - b1.x, y - b1.y);
      const dist2 = Math.hypot(x - b2.x, y - b2.y);
      const err = safeW1 * (dist1 - d1) ** 2 + safeW2 * (dist2 - d2) ** 2;
      if (err < bestErr) {
        bestErr = err;
        bestX = x;
        bestY = y;
      }
    }
  }

  const clamped = clampToRoom(bestX, bestY);
  const totalErr = isFinite(bestErr) ? Math.sqrt(bestErr / (safeW1 + safeW2)) : 5;
  const confidence = Math.max(0.2, Math.min(1.0, 1 - totalErr / 12));

  return { x: clamped.x, y: clamped.y, confidence };
}

function _oneBeaconEstimate(beacon, dist, prevX, prevY) {
  if (!dist || dist <= 0) return { x: prevX, y: prevY, confidence: 0.2 };
  // Use bearing from beacon toward previous position, at distance
  let angle = Math.atan2(prevY - beacon.y, prevX - beacon.x);
  if (isNaN(angle)) angle = 0;
  const ex = beacon.x + dist * Math.cos(angle);
  const ey = beacon.y + dist * Math.sin(angle);
  const clamped = clampToRoom(ex, ey);
  return { x: clamped.x, y: clamped.y, confidence: 0.35 };
}

// ============================================================================
// ADAPTIVE KALMAN FILTER 2D
// Smooth, fast-converging 2D filter with anti-freeze process noise updates
// ============================================================================
export class AdaptiveKalman2D {
  constructor() {
    this.reset();
  }

  reset(initX = 9, initY = 7.5) {
    // State estimate (coordinates in feet)
    this.x  = initX;
    this.y  = initY;
    // Error covariance
    this.Px = 4.0;
    this.Py = 4.0;
    // Process noise rate (ft²/s) — uncertainty grows smoothly over time
    this.Qx = 0.8;
    this.Qy = 0.8;
    // Measurement noise baseline (ft²)
    this.R_base = 1.2;
  }

  /**
   * Time update step (called on calculation interval dt).
   * Ensures uncertainty grows when no steps/measurements are received so filter never freezes.
   */
  timeUpdate(dtSeconds = 0.1) {
    const dt = Math.max(0.02, Math.min(0.5, dtSeconds));
    this.Px += this.Qx * dt;
    this.Py += this.Qy * dt;
    // Bound covariance
    this.Px = Math.min(this.Px, 15.0);
    this.Py = Math.min(this.Py, 15.0);
  }

  /**
   * PDR step prediction.
   * dx/dy in feet.
   */
  predict(dx, dy) {
    this.x  += dx;
    this.y  += dy;
    this.Px += 1.0;
    this.Py += 1.0;
    // Clamp to room bounds
    const c = clampToRoom(this.x, this.y);
    this.x = c.x;
    this.y = c.y;
  }

  /**
   * BLE measurement update.
   * bleX/bleY in feet.
   * confidence 0..1
   */
  update(bleX, bleY, confidence = 0.5) {
    if (bleX === null || bleY === null || isNaN(bleX) || isNaN(bleY)) return;

    // Ensure error covariance never drops to zero
    this.Px = Math.max(this.Px, 0.4);
    this.Py = Math.max(this.Py, 0.4);

    const conf = Math.max(0.1, Math.min(1.0, confidence));
    // Measurement noise: higher confidence = smaller R = trust BLE more
    const R = this.R_base / conf;

    // Kalman gains
    const Kx = this.Px / (this.Px + R);
    const Ky = this.Py / (this.Py + R);

    // Update state estimate
    this.x += Kx * (bleX - this.x);
    this.y += Ky * (bleY - this.y);

    // Update error covariance
    this.Px = (1 - Kx) * this.Px;
    this.Py = (1 - Ky) * this.Py;

    // Clamp inside room boundaries
    const c = clampToRoom(this.x, this.y);
    this.x = c.x;
    this.y = c.y;
  }

  getPosition() {
    return { x: this.x, y: this.y };
  }
}

// ============================================================================
// MOVEMENT SANITY CHECK
// ============================================================================
export function isSaneMovement(prevX, prevY, newX, newY, dtMs) {
  if (dtMs <= 0) return true;
  const distFt = Math.hypot(newX - prevX, newY - prevY);
  // In an 18x15 ft room, allow up to 25 ft/s to permit natural movement and fast convergence
  const speedFtS = distFt / Math.max(0.05, dtMs / 1000);
  return speedFtS <= 25;
}

