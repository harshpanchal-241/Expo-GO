// ============================================================================
// TWO-BEACON INDOOR POSITIONING SERVICES
// All positioning math lives here. Completely isolated from existing PDR/BLE.
// ============================================================================

import { OneEuroFilter } from "./BleScannerService.js";
import { getAppSettings } from "./appSettingsStorage.js";

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
// Multi-stage filtering: Outlier rejection -> Rolling Median -> One-Euro Filter -> Asymmetric EMA
// ============================================================================
const RSSI_BUFFER_SIZE = 7;      // rolling sample buffer for median
const RSSI_MIN = -105;          // reject impossible low
const RSSI_MAX = -15;           // reject impossible high

export class RssiFilterPipeline {
  constructor() {
    this.buffer          = [];
    // Ultra-smooth OneEuroFilter: low minCutoff (0.20) eliminates jitter when stationary, beta (0.05) tracks motion
    this.oneEuro         = new OneEuroFilter(0.20, 0.05);
    this.rawRssi         = null;
    this.filteredRssi    = null;
    this.smoothedDistance= null;
    this.lastSeen        = null;
  }

  addPacket(rawRssi, timestamp = Date.now()) {
    if (typeof rawRssi !== "number" || isNaN(rawRssi)) return false;
    if (rawRssi < RSSI_MIN || rawRssi > RSSI_MAX) return false;  // outlier reject

    this.rawRssi  = rawRssi;
    this.lastSeen = timestamp;

    // Rolling buffer
    this.buffer.push(rawRssi);
    if (this.buffer.length > RSSI_BUFFER_SIZE) this.buffer.shift();

    // 1. Median filter to strip impulse spikes & channel hopping anomalies
    const sorted = [...this.buffer].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    // 2. One-Euro filter on top of median for sub-dBm smooth progression
    const smoothVal = this.oneEuro.filter(median, timestamp);
    
    // 3. Asymmetric EMA blending:
    // When signal weakens (drop in dBm / body blockage), filter more heavily to prevent false jumps.
    // When signal strengthens (approaching), respond more quickly.
    if (this.filteredRssi === null) {
      this.filteredRssi = smoothVal;
    } else {
      const alpha = smoothVal > this.filteredRssi ? 0.35 : 0.20;
      this.filteredRssi = alpha * smoothVal + (1 - alpha) * this.filteredRssi;
    }

    return true;
  }

  getState() {
    return {
      rawRssi:      this.rawRssi,
      // Retain continuous floating point precision for distance calculation, rounded for UI display
      filteredRssi: this.filteredRssi !== null ? Number(this.filteredRssi.toFixed(2)) : null,
      lastSeen:     this.lastSeen,
    };
  }

  reset() {
    this.buffer          = [];
    this.oneEuro         = new OneEuroFilter(0.20, 0.05);
    this.rawRssi         = null;
    this.filteredRssi    = null;
    this.smoothedDistance= null;
    this.lastSeen        = null;
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
// RSSI → DISTANCE  (smooth path-loss model with kinematic limits, returns feet)
// ============================================================================
export function rssiToDistance(filteredRssi, txPower, n, prevDistFt = null) {
  if (filteredRssi === null || filteredRssi === 0 || isNaN(filteredRssi)) return null;
  const settings = getAppSettings();
  const satRssi = settings.nearFieldSaturationRssi ?? -43;

  const ratio    = (txPower - filteredRssi) / (10 * Math.max(1.0, n));
  let meters     = Math.pow(10, ratio);

  // Near-field saturation correction: scale smoothly to 0 when touching beacon antenna
  if (settings.enableNearFieldCurve && filteredRssi >= -50) {
    if (filteredRssi >= satRssi) {
      meters = 0.0;
    } else {
      const span = satRssi - (-50);
      const progress = Math.max(0, Math.min(1, (filteredRssi - (-50)) / span));
      meters = meters * Math.pow(1 - progress, 1.4);
    }
  }

  const rawFeet  = meters * 3.28084;
  if (!isFinite(rawFeet) || rawFeet < 0) return null;

  // If previous distance exists, apply kinematic rate-limiting and smooth blending
  if (prevDistFt !== null && prevDistFt > 0) {
    const diff = rawFeet - prevDistFt;
    const absDiff = Math.abs(diff);

    // Max plausible walking displacement in a 100ms cycle (~0.6 ft per tick = ~6 ft/s)
    const maxChangePerTick = 0.60;
    const clampedFeet = prevDistFt + Math.sign(diff) * Math.min(absDiff, maxChangePerTick);

    // Progressive easing
    const alpha = absDiff > 2.0 ? 0.30 : 0.18;
    return Number((alpha * clampedFeet + (1 - alpha) * prevDistFt).toFixed(2));
  }

  return Number(rawFeet.toFixed(2));
}

// ============================================================================
// HEIGHT CORRECTION  (slant → horizontal distance, in same units)
// ============================================================================
export function applyHeightCorrection(slantDist, beaconHeightFt, phoneHeightFt) {
  if (slantDist === null || isNaN(slantDist)) return { correctedDist: null, heightValidity: 0 };
  const vertDiff = Math.abs(beaconHeightFt - phoneHeightFt);
  const slantSq  = slantDist * slantDist;
  const vertSq   = vertDiff  * vertDiff;

  if (slantDist < vertDiff) {
    // Physically inconsistent reading
    return { correctedDist: 0.1, heightValidity: 0.1 };
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

  // Continuous weighted refinement: if beacon weights differ, shift smoothly toward more confident circle
  if (totalW > 0 && Math.abs(safeW1 - safeW2) > 0.10) {
    const wRatio = safeW1 / totalW;
    const curD1 = Math.hypot(candidateX - b1.x, candidateY - b1.y);
    const curD2 = Math.hypot(candidateX - b2.x, candidateY - b2.y);
    const res1 = d1 - curD1;
    const res2 = d2 - curD2;
    if (curD1 > 0.1 && curD2 > 0.1) {
      const u1x = (candidateX - b1.x) / curD1;
      const u1y = (candidateY - b1.y) / curD1;
      const u2x = (candidateX - b2.x) / curD2;
      const u2y = (candidateY - b2.y) / curD2;
      candidateX += 0.20 * (wRatio * res1 * u1x + (1 - wRatio) * res2 * u2x);
      candidateY += 0.20 * (wRatio * res1 * u1y + (1 - wRatio) * res2 * u2y);
    }
  }

  const clamped = clampToRoom(candidateX, candidateY);
  const curD1 = Math.hypot(clamped.x - b1.x, clamped.y - b1.y);
  const curD2 = Math.hypot(clamped.x - b2.x, clamped.y - b2.y);
  const totalErr = Math.sqrt((safeW1 * (curD1 - d1) ** 2 + safeW2 * (curD2 - d2) ** 2) / Math.max(0.01, totalW));
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
    this.Px = 2.0;
    this.Py = 2.0;
    // Process noise when stationary (ft²/s) — prevents position wander while maintaining responsiveness
    this.Qx = 0.12;
    this.Qy = 0.12;
    // Measurement noise baseline (ft²)
    this.R_base = 4.0;
  }

  /**
   * Time update step (called on calculation interval dt).
   * Slowly maintains uncertainty floor without creating jitter.
   */
  timeUpdate(dtSeconds = 0.1) {
    const dt = Math.max(0.02, Math.min(0.5, dtSeconds));
    this.Px += this.Qx * dt;
    this.Py += this.Qy * dt;
    // Bound covariance
    this.Px = Math.min(this.Px, 6.0);
    this.Py = Math.min(this.Py, 6.0);
  }

  /**
   * PDR step prediction.
   * dx/dy in feet.
   */
  predict(dx, dy) {
    this.x  += dx;
    this.y  += dy;
    // PDR motion increases process uncertainty so filter tracks movement immediately
    this.Px += 1.5;
    this.Py += 1.5;
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
  update(bleX, bleY, confidence = 0.5, isStationary = false) {
    if (bleX === null || bleY === null || isNaN(bleX) || isNaN(bleY)) return;

    // Minimum covariance floor
    this.Px = Math.max(this.Px, 0.30);
    this.Py = Math.max(this.Py, 0.30);

    const conf = Math.max(0.15, Math.min(1.0, confidence));
    let R = this.R_base / conf;

    // When stationary, moderately increase R to smooth micro-fluctuations without freezing
    if (isStationary) {
      R *= 1.8;
    }

    // Kalman gains
    let Kx = this.Px / (this.Px + R);
    let Ky = this.Py / (this.Py + R);

    // Deadband threshold: ignore microscopic noise (< 0.15 ft) when stationary
    const deltaX = bleX - this.x;
    const deltaY = bleY - this.y;
    const deltaDist = Math.hypot(deltaX, deltaY);

    if (deltaDist < 0.15 && isStationary) {
      Kx *= 0.35;
      Ky *= 0.35;
    }

    // Update state estimate smoothly
    this.x += Kx * deltaX;
    this.y += Ky * deltaY;

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

