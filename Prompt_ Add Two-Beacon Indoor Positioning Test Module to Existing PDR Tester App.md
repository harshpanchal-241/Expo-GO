Update my **existing PDR Tester application** by adding a **new, completely separate indoor positioning test section**. Do not remove, rewrite, or break any existing PDR, BLE, calibration, graph, navigation, permission, or testing functionality.

The new module is only for testing **2 BLE signal sources inside an 18 ft × 15 ft indoor area**.

# Main Goal

Create a new section called:

**2-Beacon Position Test**

The user should be able to:

1. Scan nearby Bluetooth Low Energy devices.
2. See all detected BLE devices.
3. Manually select exactly **2 devices** as Beacon 1 and Beacon 2.
4. Place both selected beacons anywhere on an **18 ft × 15 ft virtual map** using drag-and-drop.
5. Save their coordinates.
6. Start positioning mode.
7. Continuously read RSSI only from the two selected devices.
8. Filter RSSI.
9. Estimate rough distance.
10. Apply height correction if enabled.
11. Calculate confidence / weight for each beacon.
12. Estimate the user's position.
13. Combine BLE position with the existing PDR system.
14. Use Adaptive Kalman fusion.
15. Keep the estimated position inside the 18 × 15 ft map.
16. Show the user's live movement on the map.

---

# VERY IMPORTANT — Preserve Existing Application

This feature must be implemented as a **new isolated module/screen/section**.

Do NOT:

- rewrite existing PDR logic
- change existing step detection unless absolutely necessary
- change existing BLE test screens
- remove existing calibration tools
- change existing navigation
- break existing permissions
- change current UI architecture unnecessarily
- change existing storage structure unless required
- introduce heavy dependencies if current libraries can handle the task

Reuse existing:

- BLE scanner
- permissions
- PDR step detection
- heading calculation
- movement logic
- Kalman implementation if available
- existing sensor services

The existing app must continue working exactly as before.

---

# SECTION 1 — New Screen

Add a new menu/card/button:

**2-Beacon Position Test**

When opened, show four stages:

```text
1. Select Beacons
2. Place Beacons
3. Calibrate
4. Start Position Test
```

The user should move through these stages without affecting the rest of the app.

---

# SECTION 2 — BLE Device Scanner

Use the existing BLE scanner if already implemented.

Scan all nearby Bluetooth devices and display them in a list.

Each detected device card should show:

```text
Device Name
MAC / Device ID
RSSI
Last Seen
Connection / Advertising status if available
```

Example:

```text
Galaxy Buds
ID: XX:XX:XX:12:34
RSSI: -61 dBm
Last seen: 80 ms ago
```

There may be many nearby Bluetooth devices.

The positioning system must **NOT automatically use all of them**.

The user must manually choose exactly two.

Provide buttons:

```text
Set as Beacon 1
Set as Beacon 2
```

After selection:

```text
Beacon 1
Galaxy Buds Left
ID: ABC123

Beacon 2
Other BLE Device
ID: XYZ456
```

Highlight the selected devices.

Ignore every other BLE device during the positioning calculations.

Continue scanning if necessary, but only process RSSI values from the selected IDs.

Add:

```text
Change Beacon 1
Change Beacon 2
Clear Selection
```

Persist the selected device IDs locally so accidental navigation between screens does not immediately lose them.

---

# SECTION 3 — 18 ft × 15 ft Coordinate System

Create a virtual indoor map with real-world dimensions:

```text
Width  = 18 ft
Height = 15 ft
```

Internal coordinates should remain in **real feet**, not screen pixels.

Use:

```text
X = 0 → 18 ft
Y = 0 → 15 ft
```

Example:

```text
(0,15) ---------------------- (18,15)
   |                              |
   |                              |
   |                              |
   |                              |
   |                              |
(0,0) ------------------------ (18,0)
```

The map must automatically scale to different phone screen sizes.

Do NOT use screen pixels as the actual location representation.

Use a coordinate conversion layer.

---

# SECTION 4 — Feet to Screen Conversion

Create conversion functions.

If map display size is:

```text
mapPixelWidth
mapPixelHeight
```

Then convert real feet to screen coordinates:

```text
screenX = (realX / 18) * mapPixelWidth

screenY = mapPixelHeight - ((realY / 15) * mapPixelHeight)
```

The Y inversion is needed because most screen coordinate systems start from the top-left.

Reverse conversion:

```text
realX = (screenX / mapPixelWidth) * 18

realY = ((mapPixelHeight - screenY) / mapPixelHeight) * 15
```

Keep all positioning calculations in:

```text
feet
```

Only convert to pixels for rendering.

This prevents calculations from changing when screen size changes.

---

# SECTION 5 — Responsive Map

The map should fit comfortably inside the phone screen.

Maintain the real-world aspect ratio:

```text
18 : 15
```

The map can scale to available width.

Example:

```text
available width = 360 px

map width = 340 px

map height =
340 × (15 / 18)

≈ 283 px
```

Do not distort the room shape.

Use padding around the map.

Show labels:

```text
0 ft
5 ft
10 ft
15 ft
18 ft
```

where useful.

A light coordinate grid is optional but recommended.

For example:

```text
1 ft grid
or
3 ft grid
```

Keep it visually simple.

---

# SECTION 6 — Drag-and-Drop Beacon Placement

After choosing the two BLE devices, show both beacons on the map.

Default positions:

```text
Beacon 1 = (0,15)
Beacon 2 = (18,15)
```

But these MUST be draggable.

The user should be able to press and drag:

```text
B1
B2
```

to any valid point inside the room.

While dragging, display coordinates live:

```text
B1
X: 2.4 ft
Y: 14.2 ft
```

When released:

```text
Save Beacon Position
```

or save automatically.

Coordinates should snap/clamp so:

```text
0 <= X <= 18
0 <= Y <= 15
```

Do not allow a beacon marker outside the room.

Persist:

```text
Beacon 1 device ID
Beacon 1 X
Beacon 1 Y

Beacon 2 device ID
Beacon 2 X
Beacon 2 Y
```

Add:

```text
Reset Layout
```

which returns:

```text
B1 = (0,15)
B2 = (18,15)
```

---

# SECTION 7 — Optional Beacon Height

Because the final real system will use ceiling-mounted beacons, add a simple optional setting:

```text
Use Height Correction: ON / OFF
```

If ON, allow:

```text
Beacon 1 Height
Beacon 2 Height
Estimated Phone Height
```

Use feet or meters internally, but remain consistent.

Example:

```text
Beacon height = 9 ft
Phone height = 3.5 ft

verticalDifference = 5.5 ft
```

BLE estimated distance is treated as slant distance.

Calculate horizontal distance:

```text
horizontalDistance =
sqrt(max(slantDistance² - verticalDifference², 0))
```

If:

```text
slantDistance < verticalDifference
```

then the reading is physically inconsistent.

Do:

```text
horizontalDistance = 0
heightValidity = low confidence
```

Do not crash or return NaN.

For earbud testing, height correction can remain OFF initially.

---

# SECTION 8 — RSSI Data Pipeline

For the two selected BLE devices only:

```text
BLE Advertisement
       ↓
Raw RSSI
       ↓
Small sample buffer
       ↓
Outlier rejection
       ↓
Median Filter
       ↓
One-Euro Filter / lightweight EMA
       ↓
Filtered RSSI
```

Do not use heavy moving averages that add noticeable latency.

Recommended small buffer:

```text
3–5 RSSI samples
```

Keep the system responsive.

Reuse the existing RSSI filtering module if the app already has one.

---

# SECTION 9 — RSSI to Distance

Use a configurable path-loss model.

```text
distance =
10 ^ ((RSSI_at_1m - filteredRSSI) / (10 × n))
```

Where:

```text
RSSI_at_1m = calibration value
n          = environment path-loss exponent
```

Do NOT hardcode these permanently.

Create calibration values per selected beacon:

```text
Beacon 1 RSSI@1m
Beacon 2 RSSI@1m
Path Loss n
```

Initial defaults can be provided, but make them editable.

Clearly label the output as:

**Estimated Distance**

not exact distance.

---

# SECTION 10 — Calibration Mode

Before positioning, add a small calibration section.

For each beacon:

```text
Stand approximately 1 ft / 1 m from beacon
Collect RSSI samples
Calculate median RSSI
Save calibration
```

Allow manual override.

Store:

```text
B1 calibration RSSI
B2 calibration RSSI
```

Also show live:

```text
Raw RSSI
Filtered RSSI
Estimated Distance
```

This is important because earbuds or different devices may transmit differently.

---

# SECTION 11 — Weighting Engine

Each beacon should get a confidence value:

```text
0.0 → 1.0
```

Use a simple weighting model.

Factors:

```text
RSSI Strength
RSSI Stability
Freshness
Distance Reliability
Motion Consistency
Height Validity
```

For the first implementation, something like:

```text
weight =
0.30 * stabilityScore +
0.20 * strengthScore +
0.15 * freshnessScore +
0.15 * distanceScore +
0.15 * motionConsistency +
0.05 * heightValidity
```

If height correction is OFF:

redistribute or ignore the height factor.

Do not treat these coefficients as final scientific constants.

Keep them configurable in code.

---

# SECTION 12 — RSSI Stability Score

Maintain recent RSSI history.

Calculate:

```text
standard deviation / variance
```

Logic:

```text
low variation
→ high stability score

high variation
→ low stability score
```

Example:

```text
[-61,-62,-61,-63,-62]
→ high confidence

[-61,-76,-65,-82,-59]
→ low confidence
```

---

# SECTION 13 — RSSI Strength Score

Example initial ranges:

```text
>-60 dBm
very high confidence

-60 to -70
good

-70 to -80
medium

-80 to -88
low

<-88
very low
```

Do not hard reject solely based on RSSI unless extremely weak.

A strong signal does not automatically mean accurate distance.

---

# SECTION 14 — Packet Freshness

Track:

```text
currentTime - lastSeenTime
```

Example:

```text
<200 ms
high confidence

200–500 ms
good

500–1000 ms
reduced confidence

>2 sec
almost ignore
```

---

# SECTION 15 — Two-Beacon Position Calculation

Known:

```text
Beacon 1 coordinate = (x1,y1)
Beacon 2 coordinate = (x2,y2)

Distance B1 = d1
Distance B2 = d2
```

Each beacon defines a circle.

Find the possible circle intersection points.

There may be:

```text
0 intersections
1 intersection
2 intersections
```

Never assume perfect circles because RSSI distances fluctuate.

---

# SECTION 16 — Robust Position Solver

Do NOT rely only on exact geometric circle intersection.

Instead use a **weighted least-error position solver** inside the room.

Find:

```text
(x,y)
```

that minimizes:

```text
E(x,y) =
w1 * (distance((x,y), B1) - d1)²
+
w2 * (distance((x,y), B2) - d2)²
```

Subject to:

```text
0 <= x <= 18
0 <= y <= 15
```

Because the room is small, this can be solved efficiently.

Options:

```text
coarse-to-fine grid search
or
small numerical optimizer
```

Prefer something lightweight and stable for mobile.

Do NOT introduce a heavy optimization library just for this.

---

# SECTION 17 — Room Constraint

The BLE location must always remain:

```text
0 <= X <= 18
0 <= Y <= 15
```

If BLE calculation produces:

```text
(-2,8)
(20,11)
```

project/clamp it back into the valid room.

If two geometric solutions exist and only one is inside the room:

```text
choose valid solution
```

If both are valid, use:

```text
previous position
PDR direction
motion continuity
```

to choose the most likely location.

---

# SECTION 18 — Initial Position

When the user presses:

**Start Position Test**

Do not instantly trust one packet.

Collect a very short initial window:

```text
~0.5–1 second
```

or enough for a few packets from both devices.

Calculate:

```text
initial filtered RSSI
initial estimated distances
initial weights
initial BLE position
```

Then initialize:

```text
currentPosition = BLEPosition
```

If only one selected beacon is available, show:

```text
Waiting for both selected beacons...
```

Do not use unrelated Bluetooth devices.

---

# SECTION 19 — Integrate Existing PDR

Reuse the existing PDR system.

PDR provides:

```text
step detection
step length
heading
relative movement
```

Convert each detected PDR movement into room coordinates.

If step distance is available in meters:

```text
feet = meters × 3.28084
```

Example:

```text
stepLength = 2.3 ft
heading = 90°
```

Then:

```text
dx = stepLength × sin(heading)
dy = stepLength × cos(heading)
```

Adjust the heading convention to match the existing implementation.

Do not rewrite working PDR code.

Create an adapter that feeds PDR output into this new module.

---

# SECTION 20 — PDR Position Prediction

Suppose current fused position is:

```text
(8.2, 5.1)
```

User takes a step:

```text
dx = +0.8 ft
dy = +1.9 ft
```

PDR prediction:

```text
(9.0, 7.0)
```

This becomes:

```text
PDR predicted position
```

BLE becomes:

```text
measurement / correction
```

---

# SECTION 21 — Adaptive Kalman Fusion

Use:

```text
PDR = prediction
BLE = measurement
```

BLE confidence from weighting engine controls measurement noise.

Concept:

```text
High BLE confidence
→ small R
→ trust BLE more

Low BLE confidence
→ large R
→ trust PDR more
```

Use the existing Kalman implementation if available.

Otherwise implement lightweight 2D Kalman logic.

For X and Y either:

```text
two independent 1D filters
```

or:

```text
single 2D state
```

Do not make it unnecessarily complex.

---

# SECTION 22 — Motion Consistency

Compare BLE estimate with expected PDR movement.

Example:

```text
Previous = (8,6)
PDR predicts = (8.5,7)

BLE says = (8.7,7.2)
→ consistent
→ increase BLE confidence
```

But:

```text
BLE says = (16,2)
within 200 ms
→ unrealistic jump
→ lower weight strongly
```

---

# SECTION 23 — Movement Constraint

Prevent impossible movement.

Track:

```text
time difference
distance moved
estimated speed
```

If user apparently moves too far in too little time:

```text
reject
or
strongly down-weight
```

Do not allow the marker to teleport because of one bad RSSI packet.

---

# SECTION 24 — UI Map

Show a top-down 18 × 15 ft map.

Display:

```text
B1 marker
B2 marker
User marker
Optional PDR position
Optional raw BLE position
Final fused position
```

Default visualization:

```text
B1 = blue marker
B2 = blue marker
Final user = prominent location marker
```

Keep the screen clean.

Optionally provide debug toggles:

```text
Show Raw BLE Position
Show PDR Position
Show Final Position
Show Trail
Show Coordinates
Show RSSI
Show Distances
Show Weights
```

---

# SECTION 25 — Live User Movement Trail

Show the recent movement path.

Example:

```text
• → • → • → • → USER
```

Keep only a reasonable number of previous points:

```text
50–100
```

or time-based history.

Add:

```text
Clear Trail
```

---

# SECTION 26 — Live Debug Panel

Below the map, display:

```text
Beacon 1
RSSI:
Filtered RSSI:
Distance:
Weight:
Position:

Beacon 2
RSSI:
Filtered RSSI:
Distance:
Weight:
Position:
```

Then:

```text
BLE Position:
PDR Position:
Fused Position:

X:
Y:

Position Confidence:
```

Also show:

```text
Position Error
```

only when ground truth is manually entered.

---

# SECTION 27 — Ground Truth Testing

Add optional:

**Set Ground Truth**

The user can:

```text
tap a known location on the map
or
enter X and Y manually
```

Example:

```text
Ground truth:
X = 9 ft
Y = 7.5 ft
```

Calculate error:

```text
error =
sqrt(
(estimatedX - actualX)² +
(estimatedY - actualY)²
)
```

Display:

```text
Current error: 1.8 ft
```

This is important for tuning.

---

# SECTION 28 — Testing Points

Optionally show predefined test points:

```text
(3,3)
(9,3)
(15,3)

(3,7.5)
(9,7.5)
(15,7.5)

(3,12)
(9,12)
(15,12)
```

User can select:

```text
I am standing here
```

Then record positioning error.

---

# SECTION 29 — Position Update Rate

Do not rerender the whole application for every BLE packet.

Separate:

```text
BLE sampling rate
calculation rate
UI render rate
```

Suggested:

```text
BLE packets:
as received

position calculation:
~5–10 Hz

UI:
10–20 FPS if current app supports it
```

Use throttling/state refs where appropriate to avoid unnecessary React re-renders.

Preserve the low-latency behavior of the existing app.

---

# SECTION 30 — Earbud Testing Limitation

The current test uses earbuds instead of real BLE beacons.

Make the app compatible with them if they appear in BLE scans.

However, understand:

```text
earbuds may:
- stop advertising
- change advertisement rate
- randomize IDs
- advertise differently when connected
- change TX behavior
- produce inconsistent RSSI
```

Do not assume earbud RSSI behaves like Minew E5/MBM02.

The module should remain generic so later the selected device IDs can simply be replaced with real beacon UUID/Major/Minor values.

---

# SECTION 31 — Selected Device Persistence

Store locally:

```text
selectedBeacon1Id
selectedBeacon2Id

Beacon1X
Beacon1Y
Beacon2X
Beacon2Y

Beacon1Calibration
Beacon2Calibration

Height settings
```

Reload them when returning to the screen.

Provide:

```text
Reset Test Configuration
```

---

# SECTION 32 — State Machine

Use clear states:

```text
IDLE
↓
SCANNING
↓
BEACONS_SELECTED
↓
PLACEMENT_CONFIGURED
↓
CALIBRATED
↓
POSITIONING
↓
PAUSED
↓
STOPPED
```

This prevents BLE scanning/calculation logic from becoming messy.

---

# SECTION 33 — Start / Stop Controls

Buttons:

```text
Scan Devices
Stop Scan

Start Position Test
Pause
Resume
Stop

Reset Position
Clear Trail
```

Stopping positioning should stop only this module's calculation loop.

Do not stop other app services unless necessary.

---

# SECTION 34 — Architecture

Keep the implementation modular.

Suggested structure:

```text
TwoBeaconPositionScreen

components/
    BeaconScannerPanel
    SelectedBeaconCard
    TestAreaMap
    DraggableBeaconMarker
    UserPositionMarker
    DebugPanel
    CalibrationPanel

services/
    blePositionService
    rssiFilterService
    distanceEstimator
    weightingEngine
    twoBeaconSolver
    pdrAdapter
    adaptiveKalman
    coordinateConverter

hooks/
    useTwoBeaconPositioning
```

Adjust names to the current project architecture rather than forcing this exact structure.

---

# SECTION 35 — Positioning Data Model

Example:

```text
BeaconReading {
    id
    name
    rawRSSI
    filteredRSSI
    timestamp
    estimatedDistance
    correctedDistance
    weight
    x
    y
}
```

Position state:

```text
PositionState {
    bleX
    bleY

    pdrX
    pdrY

    fusedX
    fusedY

    confidence
    timestamp
}
```

---

# SECTION 36 — Full Runtime Flow

Implement this flow:

```text
User opens 2-Beacon Position Test
        ↓
Scan nearby BLE devices
        ↓
User selects Beacon 1 + Beacon 2
        ↓
Show 18 × 15 ft map
        ↓
User drags B1 and B2 to physical locations
        ↓
Save coordinates
        ↓
Optional RSSI calibration
        ↓
Start test
        ↓
Listen ONLY to selected two devices
        ↓
Collect RSSI
        ↓
Outlier rejection
        ↓
Median / One-Euro filtering
        ↓
RSSI → rough distance
        ↓
Optional ceiling-height correction
        ↓
Calculate confidence / weight
        ↓
Weighted two-beacon position solver
        ↓
BLE (x,y)
        ↓
Existing PDR predicts movement
        ↓
Adaptive Kalman combines BLE + PDR
        ↓
Reject impossible jumps
        ↓
Clamp/map-match to 18 × 15 ft room
        ↓
Render live user marker
        ↓
Draw movement trail
        ↓
Repeat continuously
```

---

# SECTION 37 — Fallback Logic

### Both beacons available

```text
Use weighted two-beacon positioning
+
PDR
+
Kalman
```

### Only one selected beacon temporarily available

Do not calculate arbitrary 2D position from one circle.

Use:

```text
PDR as primary tracking
+
single beacon only as weak correction/range constraint
```

Reduce BLE confidence.

### No selected beacon available

Use:

```text
PDR only
```

Increase PDR uncertainty over time.

Display:

```text
BLE signal temporarily unavailable
```

When signals return:

```text
gradually correct
```

Do not snap the marker aggressively.

---

# SECTION 38 — Important Mathematical Constraint

With only two beacons, BLE alone cannot always uniquely determine a 2D location.

Therefore this system MUST use:

```text
previous position
+
PDR movement
+
room boundary
+
motion continuity
```

to resolve ambiguity.

Do not present two-beacon RSSI positioning as exact trilateration.

This is a controlled test of:

```text
BLE rough ranging
+
weights
+
PDR
+
adaptive fusion
```

---

# SECTION 39 — Performance Requirements

The new module should:

```text
feel responsive
avoid visible marker jumping
avoid unnecessary calculation delay
avoid memory leaks
stop BLE listeners correctly
not create duplicate scanner subscriptions
not rerender entire app every packet
```

Use refs/buffers for fast-changing RSSI values where appropriate.

---

# SECTION 40 — Error Handling

Handle:

```text
Bluetooth disabled
Permission denied
Selected device disappears
Invalid RSSI
Distance NaN
Height correction invalid
No circle solution
Bad PDR heading
App background/resume
BLE scanner error
```

Never crash the screen.

Show useful statuses.

---

# SECTION 41 — Final Screen Layout

Recommended:

```text
┌──────────────────────────────┐
│ 2-Beacon Position Test       │
├──────────────────────────────┤
│ B1: Galaxy Buds  RSSI -61    │
│ B2: BLE Device   RSSI -67    │
├──────────────────────────────┤
│                              │
│       18 × 15 ft MAP         │
│                              │
│ B1 ●                    ● B2 │
│                              │
│             👤               │
│                              │
│       movement trail         │
│                              │
├──────────────────────────────┤
│ Position: X 8.4 / Y 6.7 ft   │
│ BLE confidence: 0.76         │
│ PDR confidence: 0.83         │
├──────────────────────────────┤
│ Start | Pause | Reset        │
└──────────────────────────────┘
```

During setup mode, B1 and B2 are draggable.

During positioning mode, lock their positions unless the user presses:

```text
Edit Beacon Placement
```

---

# Final Requirement

Do not simply create a demo UI.

Implement the complete functional flow:

**Bluetooth selection → beacon placement → RSSI collection → filtering → distance → optional height correction → dynamic weighting → two-beacon position estimation → existing PDR movement → Adaptive Kalman fusion → room constraint → live movement visualization.**

Most importantly, make this feature **isolated from the existing app so all current PDR and BLE testing functionality continues to work without regression.**