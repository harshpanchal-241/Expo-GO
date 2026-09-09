# 03. Codebase Critique, Technical Debt & Future Improvement Roadmap

This document provides a critical engineering audit of the current codebase, identifies architectural weaknesses, bottlenecks, and mathematical limitations, and presents an actionable improvement roadmap.

---

## 1. Technical Audit: Current Strengths & Limitations

### 1.1 Architectural Strengths
* **Decoupled High-Frequency Math**: Using mutable `useRef` instances for 30–50 Hz sensor sampling prevented React state churn and ensured steady 60 FPS UI rendering.
* **Modular Math Isolation**: Positioning mathematics (`twoBeaconServices.js`) and BLE filtering (`BleScannerService.js`) are decoupled from UI presentation.
* **Resilient Signal Filtering**: Combining Median filtering, adaptive One-Euro filtering, and asymmetric EMA provides smooth distance estimates under noisy multipath RF conditions.
* **Zero Velocity Energy Gate (ZUPT)**: Accelerometer variance gating successfully eliminates phantom steps when standing still.

---

### 1.2 Technical Debt & Code Quality Issues

#### Issue 1: Severe Platform Fragmentation & Code Duplication
* **Symptoms**: [`App.android.js`](file:///c:/Users/harsh.p/Desktop/Indoor%20Navigation/PDR_ExpoGo/App.android.js) (863 lines) and [`App.ios.js`](file:///c:/Users/harsh.p/Desktop/Indoor%20Navigation/PDR_ExpoGo/App.ios.js) (816 lines) share over 85% identical code.
* **Risk**: High maintenance overhead and feature divergence. In fact, **[`App.ios.js`](file:///c:/Users/harsh.p/Desktop/Indoor%20Navigation/PDR_ExpoGo/App.ios.js) is missing the 2-Beacon positioning tab entirely**, meaning iOS users cannot access the core two-beacon module.
* **Remedy**: Unify into a single `App.js` and extract platform-specific permissions into utility hooks.

#### Issue 2: Monolithic "God Components"
* **Symptoms**:
  * [`components/BleScannerSection.js`](file:///c:/Users/harsh.p/Desktop/Indoor%20Navigation/PDR_ExpoGo/components/BleScannerSection.js): **1,241 lines**
  * [`components/TwoBeaconPositionScreen.js`](file:///c:/Users/harsh.p/Desktop/Indoor%20Navigation/PDR_ExpoGo/components/TwoBeaconPositionScreen.js): **1,095 lines**
  * [`App.android.js`](file:///c:/Users/harsh.p/Desktop/Indoor%20Navigation/PDR_ExpoGo/App.android.js): **863 lines**
* **Risk**: Blends hardware permissions, state machine transitions, math calculation timers, SVG map rendering, and CSS stylesheets into single massive files. Difficult to unit test or maintain.
* **Remedy**: Decompose into atomic subcomponents and dedicated custom hooks.

#### Issue 3: Hardcoded Physical Constants
* **Symptoms**:
  * Room dimensions are hardcoded as `18 ft × 15 ft` in [`services/twoBeaconServices.js`](file:///c:/Users/harsh.p/Desktop/Indoor%20Navigation/PDR_ExpoGo/services/twoBeaconServices.js).
  * Weinberg stride factor is hardcoded to $K = 0.74$.
  * BLE update intervals and variance thresholds are statically defined.
* **Risk**: A user who is 5'2" (157 cm) walks with significantly shorter strides than a user who is 6'3" (190 cm), causing systematic scale distortion in PDR path tracking.
* **Remedy**: Expose room dimension and user height configuration with auto-calibration routines.

---

## 2. Mathematical & Algorithmic Limitations

### 2.1 The Two-Beacon Geometric Ambiguity
* **The Problem**: Two intersecting circles generate **two** discrete intersection points (mirror images across the baseline).
* **Current Handling**: The code checks if one point is outside the room $[0..18, 0..15]$. If both are inside, it chooses the point closest to the previous known coordinate.
* **Failure Mode**: If a user walks near the baseline between the two beacons, the two candidates converge, or small RSSI fluctuations cause the solver to flip across the baseline.
* **Solution**: Upgrade to **3+ beacons (Multilateration)** to achieve unambiguous single-point intersection.

```text
    Beacon 1 (B1) ●────────────────────────● Beacon 2 (B2)
                     \                  /
                      \   Intersection /
                       \    Point 1   /
                        \     ●      /
                         \          /
                          \        /
                           \  ●   /
                            \    /
                         Intersection
                           Point 2 (Mirror Reflection)
```

### 2.2 Indoor Magnetic Distortion & Gyro Drift
* **The Problem**: Magnetometers in modern buildings are distorted by steel rebar, HVAC conduits, and electrical wiring, resulting in local magnetic anomalies of $\pm 20^\circ$ to $\pm 60^\circ$. Meanwhile, pure gyroscopic integration drifts over time.
* **Solution**: Implement an **Extended Complementary Filter** or **Mahony/Madgwick AHRS Filter** that dynamically downweights magnetometer updates when magnetic field norm $\|\vec{B}\|$ departs from the local Earth baseline ($\sim 45-55\text{ }\mu\text{T}$).

### 2.3 Decoupled 2D Kalman Filter
* **The Problem**: [`AdaptiveKalman2D`](file:///c:/Users/harsh.p/Desktop/Indoor%20Navigation/PDR_ExpoGo/services/twoBeaconServices.js#L392) tracks only position $[x, y]^T$, treating X and Y as completely independent scalar systems without tracking velocity $[v_x, v_y]^T$ or heading bias $b_\theta$.
* **Solution**: Upgrade to a full **4-State or 6-State Extended Kalman Filter (EKF)**.

---

## 3. Actionable Engineering Improvement Roadmap

### Phase 1: Code Modernization & Refactoring (Short Term)

```text
Project Structure (After Refactoring)
├── App.js                             <-- Single unified cross-platform entry
├── components/
│   ├── pdr/
│   │   ├── PdrMapView.js              <-- Extracted SVG PDR map
│   │   ├── SensorDashboard.js         <-- Heading, compass & status cards
│   │   └── SavedPathsModal.js         <-- Path history management
│   ├── ble/
│   │   ├── DeviceCard.js              <-- Individual device RSSI card
│   │   └── DistanceChart.js           <-- Live SVG distance chart
│   └── beacon/
│       ├── StageSelector.js           <-- Clean stage wizard bar
│       ├── PlacementCanvas.js         <-- Draggable beacon setup
│       └── CalibrationWizard.js       <-- 1m calibration modal
├── hooks/
│   ├── usePdrTracker.js               <-- Extracted PDR sensor loop & FSM
│   └── useTwoBeaconPositioning.js     <-- Existing positioning hook
└── services/
    ├── MathUtils.js                   <-- Coordinate transforms & vectors
    └── ...
```

1. **Merge `App.android.js` and `App.ios.js`**:
   * Create a single `App.js`.
   * Move the accelerometer/gyro/magnetometer polling loop into a reusable hook `usePdrTracker.js`.
   * Enable the 2-Beacon module for both iOS and Android.
2. **Decompose `BleScannerSection.js` and `TwoBeaconPositionScreen.js`**:
   * Break each screen into focused subcomponents under 200 lines each.
3. **TypeScript Migration**:
   * Introduce TypeScript types for beacon configuration, positioning states, and sensor packets to catch runtime type bugs.

---

### Phase 2: Algorithmic & Sensor Upgrades (Medium Term)

#### A. 4-State Extended Kalman Filter (EKF)
Replace `AdaptiveKalman2D` with a state-space model that tracks velocity:
$$\mathbf{x}_k = \begin{bmatrix} x \\ y \\ v_x \\ v_y \end{bmatrix}_k, \quad \mathbf{F} = \begin{bmatrix} 1 & 0 & \Delta t & 0 \\ 0 & 1 & 0 & \Delta t \\ 0 & 0 & 1 & 0 \\ 0 & 0 & 0 & 1 \end{bmatrix}$$
* **Benefit**: Estimates physical walking inertia, prevents sharp discontinuous corner-cutting, and provides natural trajectory smoothing.

#### B. Dynamic Stride Length Auto-Calibration
* Compare the accumulated PDR step count against displacement measured by BLE when the user walks through high-confidence beacon coverage:
  $$K_{calibrated} = \frac{\Delta D_{BLE}}{\sum \sqrt[4]{A_{max} - A_{min}}}$$
* Automatically personalizes the Weinberg constant to the individual user without requiring manual tape-measure calibration.

#### C. Upgrading to N-Beacon Multilateration ($N \ge 3$)
Generalize the 2-circle solver into a multi-beacon weighted least squares solver:
$$f_i(x, y) = \sqrt{(x - x_i)^2 + (y - y_i)^2} - d_i$$
Minimize the objective function:
$$\arg\min_{x,y} \sum_{i=1}^{N} w_i \cdot \left(\sqrt{(x - x_i)^2 + (y - y_i)^2} - d_i\right)^2$$
* Using Gauss-Newton or Levenberg-Marquardt iteration, 3 or more beacons eliminate the reflection ambiguity and cut 2D positioning error below $1.0\text{ ft}$.

---

### Phase 3: Advanced Indoor Navigation Features (Long Term)

#### A. Map Matching & Wall Constraints (Particle Filter)
* Load architectural room floorplans as polygonal boundaries.
* If a step projection or BLE update crosses a known wall vector, clamp or reflect the position along the corridor boundary.
* A lightweight Particle Filter (100–300 particles) can eliminate impossible trajectories through walls and furniture.

#### B. BLE RSSI Fingerprinting Mode
* In challenging indoor environments where path loss models fail due to metal obstructions, implement **k-Nearest Neighbor (k-NN) Fingerprinting**:
  1. Offline Phase: Record vector $[RSSI_{B1}, RSSI_{B2}, \dots, RSSI_{Bn}]$ at known grid points across the room.
  2. Online Phase: Match live RSSI vectors to the database using Euclidean or Mahalanobis distance.

#### C. Turn-by-Turn Indoor Routing
* Graph representation of indoor corridors (nodes = doorways/junctions, edges = corridors).
* Implement Dijkstra / A* pathfinding to guide users from their current fused $(x, y)$ coordinate to selected destination rooms with dynamic navigation arrows on the map.

---

## 4. Priority Matrix for Future Sprints

| Feature / Refactor | Impact | Complexity | Priority |
| :--- | :---: | :---: | :---: |
| **Unify iOS & Android into single codebase** | High | Low | **P0 (Immediate)** |
| **Enable 2-Beacon Tab on iOS** | High | Low | **P0 (Immediate)** |
| **Break down 1000+ line components** | Medium | Medium | **P1 (Near Term)** |
| **Custom User Height / Stride Calibration** | High | Low | **P1 (Near Term)** |
| **Support for 3+ Beacons (Multilateration)** | Very High | Medium | **P1 (Near Term)** |
| **4-State EKF with Velocity Tracking** | High | Medium | **P2 (Strategic)** |
| **Polygonal Wall Snapping / Particle Filter** | Very High | High | **P3 (Advanced)** |
| **A\* Pathfinding & Turn-by-Turn Guidance** | High | High | **P3 (Advanced)** |
