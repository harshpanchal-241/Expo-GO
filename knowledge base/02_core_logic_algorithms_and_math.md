# 02. Core Logic, Scientific Algorithms & Mathematical Models

This document explains the physics, mathematical principles, signal processing pipelines, and state machines powering this indoor navigation system. It details **why** each technique was chosen and how it is implemented in the codebase.

---

## 1. Executive Summary of Core Techniques

The application solves GPS-denied indoor positioning by coupling two distinct systems:
1. **Kinematic Inertial Tracking (Pedestrian Dead Reckoning - PDR)**: High-frequency relative displacement and heading using the device's accelerometer, gyroscope, and magnetometer.
2. **Radio-Frequency Trilateration (Bluetooth Low Energy - BLE)**: Absolute coordinate anchoring using received signal strength indicators (RSSI) from two fixed beacons.
3. **Stochastic Sensor Fusion (Adaptive Kalman Filter)**: Merging the smooth, drift-prone PDR trajectory with the noisy, drift-free BLE measurements.

---

## 2. Pedestrian Dead Reckoning (PDR) Deep Dive

### 2.1 Physics of the Step Cycle & Acceleration
When a person walks holding a smartphone, the vertical and forward acceleration follows a distinct periodic oscillation:
* **Heel Strike (Impact Peak)**: Generates a sharp positive acceleration spike ($+0.2\text{g}$ to $+0.8\text{g}$).
* **Swing Phase (Trough/Valley)**: As the leg swings forward, the phone experiences a downward acceleration swing ($-0.15\text{g}$ to $-0.5\text{g}$).
* **Stance Phase**: Foot is flat on the ground; dynamic acceleration drops near zero.

```text
Acceleration (g)
  ^
  |        [HEEL STRIKE: Peak]
+0.3 |           /\
     |          /  \
 0.0 |---------/----\----------------/-- Zero Dynamic Baseline
     |               \  [SWING]     /
-0.2 |                \   \/       /
     +-----------------\----------/--------> Time (ms)
                        [Valley]
```

### 2.2 Dynamic Gravity Baseline & Low-Pass Filtering
Raw accelerometer data contains the Earth's gravitational acceleration ($\sim 1.0\text{g}$) mixed with dynamic human motion. To extract only human movement:
1. **Low-Pass Filter on Raw Magnitude**:
   $$\|a\|_{raw} = \sqrt{x^2 + y^2 + z^2}$$
   $$a_{filtered}(t) = 0.70 \cdot a_{filtered}(t - 1) + 0.30 \cdot \|a\|_{raw}$$
2. **Dynamic Gravity Tracker**:
   $$g_{est}(t) = 0.98 \cdot g_{est}(t - 1) + 0.02 \cdot a_{filtered}(t)$$
   $$a_{dynamic}(t) = a_{filtered}(t) - g_{est}(t)$$
*Code Location*: [`App.android.js:231-237`](file:///c:/Users/harsh.p/Desktop/Indoor%20Navigation/PDR_ExpoGo/App.android.js#L231-L237).

### 2.3 Stationary Energy Gate (ZUPT: Zero Velocity Update)
A major challenge in mobile PDR is false step triggers while the user is standing still, tapping the screen, or gently shifting weight.
* The system computes the **variance** over a rolling 16-sample buffer ($\sim 480\text{ms}$ at 30ms sampling rate):
  $$\sigma^2 = \frac{1}{N} \sum_{i=1}^{N} (a_{dynamic}[i] - \bar{a})^2$$
* **Zero Velocity Threshold**: If $\sigma^2 < 0.012\text{ g}^2$, the user is confirmed stationary. The step detector immediately halts, preventing phantom steps.
* *Code Location*: [`App.android.js:239-254`](file:///c:/Users/harsh.p/Desktop/Indoor%20Navigation/PDR_ExpoGo/App.android.js#L239-L254).

### 2.4 Peak-Valley Finite State Machine (FSM)
Rather than simple threshold crossing, the app implements a 3-state temporal finite state machine:
```text
  [IDLE]
    │  Trigger: dynamicAccel > +0.20g
    ▼
[ARMED_PEAK]
    │  Records highest peak value (peakVal)
    │  Trigger: dynamicAccel crosses downward < +0.04g
    ▼
[ARMED_VALLEY]
    │  Records lowest valley value (valleyVal)
    │  Trigger: dynamicAccel rebounds upward > -0.16g
    ▼
[VALIDATION CHECKS]:
  1. Bounce Amplitude: (peakVal - valleyVal) >= 0.32g
  2. Step Cadence: 280ms <= dt <= 1400ms (0.7 to 3.5 steps/sec)
  3. Peak-to-Valley Duration: 50ms <= dt_pv <= 450ms
    │
    ├─► All Passed: TRIGGER CONFIRMED STEP! -> Return to [IDLE]
    └─► Timeout (> 400ms): Discard False Trigger -> Return to [IDLE]
```
*Code Location*: [`App.android.js:261-312`](file:///c:/Users/harsh.p/Desktop/Indoor%20Navigation/PDR_ExpoGo/App.android.js#L261-L312).

### 2.5 Weinberg Dynamic Step Length Model
Human stride length is not constant; faster, more energetic walking produces longer steps. The app uses the **Weinberg Model**, derived from biomechanical inverted-pendulum dynamics:
$$SL = K_{weinberg} \cdot \sqrt[4]{A_{max} - A_{min}}$$
Where:
* $A_{max} - A_{min} = \text{peakVal} - \text{valleyVal}$ (the vertical bounce amplitude in $g$).
* $K_{weinberg} = 0.74$ (calibrated empirical coefficient).
* The calculated stride is clamped between $0.50\text{ m}$ (short shuffle) and $1.05\text{ m}$ (brisk stride).
* *Code Location*: [`App.android.js:300-304`](file:///c:/Users/harsh.p/Desktop/Indoor%20Navigation/PDR_ExpoGo/App.android.js#L300-L304).

### 2.6 Heading Estimation & Orientation Integration
The system integrates heading using a multi-layered priority:
1. **DeviceMotion Rotation Rate (Gyroscope Fusion)**: If available via OS sensor fusion, the yaw angle $\alpha$ provides high-frequency relative heading immune to immediate magnetic anomalies.
2. **Magnetometer Compass Fallback**: If rotation is unavailable, heading is computed via arctangent of magnetic axes:
   $$\theta_{mag} = \text{atan2}(-x, y) \cdot \frac{180}{\pi}$$
3. **Relative Heading Zeroing**: The user can press **"Set Heading Forward"**, which locks the current phone orientation as $0^\circ$ (Forward).
4. **Circular Low-Pass Smoothing**: Heading differences wrap around $\pm 180^\circ$ using circular difference math:
   $$\Delta\theta = ((\theta_{rel} - \theta_{smoothed} + 180) \bmod 360) - 180$$
   $$\theta_{smoothed} = \theta_{smoothed} + 0.25 \cdot \Delta\theta$$
*Code Location*: [`App.android.js:170-220`](file:///c:/Users/harsh.p/Desktop/Indoor%20Navigation/PDR_ExpoGo/App.android.js#L170-L220).

### 2.7 Coordinate Projection & Loop Closure
* **Navigation Frame**:
  * Heading $0^\circ \implies$ North ($+Y$)
  * Heading $+90^\circ \implies$ East ($+X$)
  * Heading $180^\circ \implies$ South ($-Y$)
  * Heading $-90^\circ \implies$ West ($-X$)
  $$x_{new} = x_{old} + SL \cdot \sin(\theta)$$
  $$y_{new} = y_{old} + SL \cdot \cos(\theta)$$
* **Loop Closure Drift Correction**: When a user returns to their starting point in a closed circuit, cumulative sensor drift causes $(x_{end}, y_{end}) \neq (0, 0)$. Loop closure linearly distributes this drift error across all $N$ recorded waypoints:
  $$x_i^{corrected} = x_i - \frac{x_{end}}{N} \cdot i, \quad y_i^{corrected} = y_i - \frac{y_{end}}{N} \cdot i$$
*Code Location*: [`App.android.js:374-395`](file:///c:/Users/harsh.p/Desktop/Indoor%20Navigation/PDR_ExpoGo/App.android.js#L374-L395).

---

## 3. BLE Distance Estimation & Multi-Stage Signal Processing Pipeline

Raw RSSI (Received Signal Strength Indicator) is notoriously noisy due to:
* **Multi-path fading**: RF signals bouncing off walls, floors, and metal furniture.
* **Channel hopping**: BLE broadcasts across advertising channels 37 (2402 MHz), 38 (2426 MHz), and 39 (2480 MHz), which have different attenuation characteristics.
* **Human Body Shadowing**: A human body between the phone and beacon absorbs $2.4\text{ GHz}$ signals, causing sudden drops of $6-12\text{ dBm}$.

To convert raw RSSI into reliable distance, the system employs a **5-stage processing pipeline** in `RssiFilterPipeline`:

```text
[Raw BLE Packet]
       │
       ▼
1. Outlier Gating [-105 dBm <= RSSI <= -15 dBm]
       │
       ▼
2. Rolling Median Filter (Window = 7)
   --> Eliminates single-packet spikes & channel-hopping offsets
       │
       ▼
3. Adaptive One-Euro Filter (Casiez et al.)
   --> Eliminates stationary jitter while maintaining zero-lag motion tracking
       │
       ▼
4. Asymmetric EMA (alpha = 0.35 approaching vs 0.20 weakening)
   --> Damps artificial body-blockage signal dips
       │
       ▼
5. Log-Distance Path Loss Model + 3D Height Pythagorean Correction
       │
       ▼
6. Kinematic Rate Limiter (Max 0.60 ft per 100ms cycle)
       │
       ▼
[Smooth Physical Distance (ft)]
```

### 3.1 Adaptive One-Euro Filter Formulation
The One-Euro filter dynamically scales its cutoff frequency $f_c$ based on the signal's rate of change (derivative $\dot{x}$):
$$f_c = f_{c,min} + \beta \cdot |\dot{x}|$$
$$\alpha = \frac{1}{1 + \frac{\tau}{\Delta t}}, \quad \tau = \frac{1}{2\pi f_c}$$
* **When stationary**: $\dot{x} \approx 0 \implies f_c = 0.20\text{ Hz}$. Low cutoff strongly suppresses numeric fluctuation.
* **When walking**: $\dot{x}$ increases $\implies f_c$ rises proportionally, tracking the real distance without phase lag.
* *Code Location*: [`services/BleScannerService.js:126-171`](file:///c:/Users/harsh.p/Desktop/Indoor%20Navigation/PDR_ExpoGo/services/BleScannerService.js#L126-L171) & [`services/twoBeaconServices.js:46-86`](file:///c:/Users/harsh.p/Desktop/Indoor%20Navigation/PDR_ExpoGo/services/twoBeaconServices.js#L46-L86).

### 3.2 Asymmetric EMA Blending
When a user turns their back to a beacon, their body shadows the signal, causing an abrupt RSSI drop. However, when walking towards a beacon, signal strength increases reliably. The filter applies asymmetric weights:
$$\alpha = \begin{cases} 0.35 & \text{if } RSSI_{new} > RSSI_{old} \quad \text{(Signal strengthening / approaching)} \\ 0.20 & \text{if } RSSI_{new} \le RSSI_{old} \quad \text{(Signal weakening / potential occlusion)} \end{cases}$$

### 3.3 Log-Distance Path Loss Model
Distance in meters is derived using the standard radio propagation model:
$$RSSI = TxPower - 10 \cdot n \cdot \log_{10}(d)$$
Solving for distance $d$:
$$d_{meters} = 10^{\frac{TxPower - RSSI}{10 \cdot n}}$$
$$d_{feet} = d_{meters} \cdot 3.28084$$
Where:
* $TxPower$: Calibrated signal strength at exactly 1 meter (typically $-59\text{ dBm}$).
* $n$: Path loss exponent ($n = 2.0$ for free space, $2.2-2.8$ for indoor environments with walls).

### 3.4 3D Height Correction (Slant to Horizontal Distance)
Beacons are typically mounted high on walls or ceilings ($h_{beacon} \approx 9\text{ ft}$), while the phone is carried at hand height ($h_{phone} \approx 3.5\text{ ft}$). The measured distance is the 3D slant hypotenuse ($d_{slant}$).
Using Pythagorean decomposition:
$$d_{horizontal} = \sqrt{\max(0, d_{slant}^2 - (h_{beacon} - h_{phone})^2)}$$
*Code Location*: [`services/twoBeaconServices.js:156-169`](file:///c:/Users/harsh.p/Desktop/Indoor%20Navigation/PDR_ExpoGo/services/twoBeaconServices.js#L156-L169).

---

## 4. Two-Beacon Analytical Geometric Solver

### 4.1 The 2-Circle Intersection Problem
Positioning with two beacons corresponds to finding the intersection of two circles with centers $B_1(x_1, y_1)$ and $B_2(x_2, y_2)$ and radii $d_1, d_2$.

```text
               Baseline Distance D
    B1 (x1, y1) ●────────────────────────● B2 (x2, y2)
         \         |         a          /
          \        |                   /
        d1 \       | h               / d2
            \      |                /
             \     |               /
              \    |              /
                   ▼
               P1 (x, y)  <--- Candidate 1
                  and
               P2 (x, y)  <--- Candidate 2 (Mirror Reflection)
```

1. **Distance between beacons**:
   $$D = \sqrt{(x_2 - x_1)^2 + (y_2 - y_1)^2}$$
2. **Unit vector along baseline**:
   $$u_x = \frac{x_2 - x_1}{D}, \quad u_y = \frac{y_2 - y_1}{D}$$
3. **Projection distance $a$ from $B_1$ along baseline**:
   $$a = \frac{d_1^2 - d_2^2 + D^2}{2D}$$
4. **Perpendicular distance $h$ to the intersection points**:
   $$h = \sqrt{d_1^2 - a^2}$$
5. **Orthogonal Intersection Candidates**:
   $$P_0 = (x_1 + a \cdot u_x, \; y_1 + a \cdot u_y)$$
   $$P_1 = (P_{0x} - h \cdot u_y, \; P_{0y} + h \cdot u_x)$$
   $$P_2 = (P_{0x} + h \cdot u_y, \; P_{0y} - h \cdot u_x)$$

### 4.2 Candidate Disambiguation (The Reflection Problem)
Because two circles intersect at two symmetric points ($P_1$ and $P_2$), a geometric ambiguity exists. The solver resolves this via:
1. **Room Boundary Containment**: Tests if $P_1$ or $P_2$ falls inside the room bounds $[0..18\text{ ft}, 0..15\text{ ft}]$. If only one candidate is inside the physical room, it is immediately selected.
2. **Temporal Kinematic Proximity**: If both points fall inside (or both outside), the candidate closest to the previously known position is chosen:
   $$\text{Candidate} = \arg\min_{i \in \{1,2\}} \|P_i - P_{previous}\|$$
*Code Location*: [`services/twoBeaconServices.js:299-348`](file:///c:/Users/harsh.p/Desktop/Indoor%20Navigation/PDR_ExpoGo/services/twoBeaconServices.js#L299-L348).

### 4.3 6-Metric Multi-Factor Weighting Engine
Not all RSSI readings are equally trustworthy. The algorithm scores each beacon's reliability using 6 weighted metrics ($w \in [0, 1]$):

| Metric | Formula / Criterion | Weight ($\alpha$) | Rationale |
| :--- | :--- | :--- | :--- |
| **Stability** | $1 - (\sigma_{rssi} / 10)$ | 0.30 | Low sample variance indicates clean line-of-sight signal. |
| **Strength** | Step-function based on filtered dBm | 0.20 | Signals $>-60\text{ dBm}$ have far higher signal-to-noise ratio than $<-85\text{ dBm}$. |
| **Freshness** | Decay based on packet age ($<200\text{ms} \implies 1.0$) | 0.15 | Penalizes dropped or delayed BLE advertisement packets. |
| **Distance** | Decay for large estimates ($<5\text{ ft} \implies 1.0$) | 0.15 | Log-path loss error grows exponentially with distance. |
| **Motion Consistency** | Jump penalty if $\Delta pos > 2.5\text{ ft}$ in one cycle | 0.15 | Discards non-physical teleports caused by multipath bursts. |
| **Height Validity** | Ratio of slant distance to elevation difference | 0.05 | Flags physically impossible readings where $d_{slant} < \Delta h$. |

*Code Location*: [`services/twoBeaconServices.js:195-266`](file:///c:/Users/harsh.p/Desktop/Indoor%20Navigation/PDR_ExpoGo/services/twoBeaconServices.js#L195-L266).

---

## 5. Sensor Fusion Engine: Adaptive 2D Kalman Filter

To eliminate PDR drift while smoothing noisy BLE jumps, an **Adaptive Kalman Filter** combines both data sources:

```text
                  +--------------------------------+
                  |  State: x = [x, y]^T           |
                  |  Covariance: P = diag(Px, Py)  |
                  +--------------------------------+
                                  │
    PDR Step Detected             │ Time Update (dt)
    (dx, dy from Weinberg)        │ (Px += Q*dt)
            │                     │
            ▼                     ▼
      [ PREDICT ] ────────────────┘
      x = x + dx
      Px = Px + 1.5
            │
            ▼
    BLE Trilateration Update (bleX, bleY)
            │
            ▼
      [ MEASUREMENT UPDATE ]
      K = P / (P + R / confidence)
      x = x + K * (z_ble - x)
      P = (1 - K) * P
            │
            ▼
      [ DISPLAY SMOOTHER ]
      EMA blend at 20 FPS
            │
            ▼
    Smooth User Map Coordinate (fusedX, fusedY)
```

### 5.1 State Vector & Covariances
* **State Vector**: $\mathbf{x} = [x, y]^T$ (coordinates in feet).
* **Error Covariance**: $\mathbf{P} = \begin{bmatrix} P_x & 0 \\ 0 & P_y \end{bmatrix}$, initialized to $2.0\text{ ft}^2$.
* **Process Noise ($Q$)**: $0.12\text{ ft}^2/\text{s}$ at rest; jumps by $+1.5\text{ ft}^2$ on each PDR step to grant immediate responsiveness to user footsteps.
* **Measurement Noise ($R$)**: Inversely proportional to the 6-factor BLE confidence score:
  $$R = \frac{R_{base}}{confidence}, \quad R_{base} = 4.0\text{ ft}^2$$

### 5.2 Anti-Freeze Covariance Floor & Stationary Lock
Standard Kalman filters can suffer from **covariance freeze**: after many updates at rest, $\mathbf{P}$ approaches zero, causing the filter to completely ignore subsequent movements.
* The algorithm enforces a strict uncertainty floor:
  $$P_x \ge 0.30\text{ ft}^2, \quad P_y \ge 0.30\text{ ft}^2$$
* When stationary, if the BLE delta is microscopic ($< 0.15\text{ ft}$), the Kalman gain is dampened by $65\%$ ($K \leftarrow 0.35 \cdot K$) to eliminate numeric jitter on the screen.
* *Code Location*: [`services/twoBeaconServices.js:392-491`](file:///c:/Users/harsh.p/Desktop/Indoor%20Navigation/PDR_ExpoGo/services/twoBeaconServices.js#L392-L491).

---

## 6. Architectural Rationale: Why the Codebase is Built This Way

1. **High-Frequency Decoupling from React State**:
   * Hardware sensors fire at 30–50 Hz (every 20–33ms). Triggering React `useState` at this frequency causes massive frame drops and UI freezing.
   * *Solution*: Sensor and BLE processing live entirely in mutable `useRef` instances. State sync is throttled to an independent 20 FPS (50ms) UI timer.
2. **Strict Module Isolation**:
   * The 2-Beacon module was built without modifying the existing standalone PDR or BLE Scanner tab logic. Communication occurs exclusively through an optional `pdrStepCallbackRef`.
3. **Graceful Native vs. Expo Go Degradation**:
   * `react-native-ble-plx` requires native modules unavailable in default Expo Go. The codebase checks `isBleSupported()` before initializing native code, preventing crashes when running in vanilla Expo Go.
