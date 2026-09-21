# VESC Connect — Milestone 2

Connect + live telemetry, plus the start of the customer setup wizard.
Currently wired to **USB** (Web Serial) — BLE (`vesc-ble.js`) is built
and kept in sync in shape, not wired into `app.js` yet.

## What's here

- `assets/` — OEMods brand logo and mascot artwork. Needs to come along with the rest of the folder same as `css/`/`js/` when copying files around.
- `js/vesc-protocol.js` — packet framing, CRC16, GET_VALUES + GET_DECODED_ADC parsing (shared by both transports). Command IDs verified against current firmware source (`vedderb/bldc/datatypes.h`).
- `js/vesc-usb.js` — Web Serial transport (**active** — what app.js uses right now)
- `js/vesc-ble.js` — Web Bluetooth transport (built, not wired in yet, kept in sync with the USB client's shape/methods)
- `js/vesc-wizard.js` — the "New setup" walkthrough: step framework + working pedal sync step
- `js/app.js` — UI wiring
- `index.html` / `css/style.css` — the dashboard and wizard styling

## Running it locally

Browsers require HTTPS (or `localhost`) for Web Serial. Plain
`file://` won't work.

```
cd vesc-tool
python3 -m http.server 8000
```

Then open `http://localhost:8000` in **Chrome or Edge, on desktop**.
Web Serial is desktop-only — Chrome Android explicitly doesn't
support it, and Safari/Firefox oppose it outright on every platform.
That's expected for this milestone; it's a bench-testing tool right
now, not the customer-facing one.

## Deploying

No build step — push this folder to GitHub Pages or drag it into
Vercel and it just works. Needs HTTPS, which both give you for free.

## Motor targeting (dual-motor boards)

On the connected dashboard: "This VESC" and "Scan for linked VESC." On
single-PCB dual-motor hardware (like your Flipsky 75100 Dual), the
second motor isn't a separate physical device — it's a second thread
on the same MCU, reached by wrapping any command in `COMM_FORWARD_CAN`
with that motor's CAN ID (confirmed from firmware source,
`comm/commands.c`). No second USB connection or CAN wiring needed.

**Scan** sends `COMM_PING_CAN` (command ID 62, confirmed against
firmware source — this is the same command VESC Tool itself uses to
discover CAN devices). What I haven't verified is the exact byte
layout of the reply, so the parser treats each response byte as a
candidate discovered CAN ID and takes the first one found —
best-effort, not blind guessing, and the raw bytes are logged to the
dev console so the parsing can be tightened once we've seen a real
reply from your board. **There is no manual CAN ID entry anywhere in
this app, on any page** — a mistyped or misremembered ID is exactly
the kind of mistake that ends with the wrong motor getting written to,
so every "linked VESC" feature (dashboard, Motor Config's per-side
toggle/Compare/Copy) auto-detects via the same scan, and just says
plainly if it finds nothing rather than falling back to a text field.

Once a target is picked, it affects both the main telemetry poll and
the wizard's pedal sync step — everything reads from the selected
motor until you switch back. The scan itself is reusable: dashboard
uses the callback-based `onPingCanResult`/`requestPingCan()` pair,
while Motor Config uses a separate promise-based `detectLinkedCanId()`
on the client (same underlying command and same "first ID found"
logic) so its own scan can't collide with whatever the dashboard has
`onPingCanResult` wired to mid-scan.

Click "New setup" once connected. The first screen is a hard safety
gate — a red-bordered warning explaining that the motor can actually
move during pedal sync if one's connected, since the pedal drives the
VESC's real ADC control loop. You have to click "I understand —
continue" to get past it; there's no skip. After that:

- **Welcome/safety** — done, informational.
- **Pedal sync** — live-reads the pedal, captures idle/full-press
  voltage. On entering this step, it also does a real write: sets
  `App to Use` to ADC+UART (offset confirmed, see below) so the ADC
  decode thread is actually running — this is what fixes the "pedal
  reads 0" issue we chased earlier. If that write fails for any
  reason, you still see the live voltage and get a clear message
  telling you to set it manually and retry.
- **Control type** — pick from three ADC control modes. Values are
  the real `ADC_CTRL_TYPE_*` enum values from firmware source. The
  choice itself gets written on the next screen, bundled with the
  pedal range.
- **Pedal range & center** — real write. Min/max prefill from pedal
  sync (editable), center defaults to a recommendation based on the
  chosen control type (with a "capture from pedal" option too — since
  these are single-direction, spring-return pedals, idle position is
  the sane default across all three modes; only Reverse Button Brake
  Center actually depends on it functionally). "Save & continue"
  reads a **fresh** copy of APPCONF, patches only the verified fields
  (control type, voltage start/end/center), switches `App to Use`
  back from ADC+UART to plain ADC for normal operation (same manual
  step Scott was doing after every setup — now automatic), and writes
  the whole thing back in one shot — everything else in the config
  passes through untouched. Waits for the firmware's confirmation
  before advancing; shows a clear error and leaves the board unchanged
  if the write fails or times out.
- **Motor detection** — starts with a motor-size pick ("Medium Outrunner —
  6374 and similar" / "Large Outrunner — 7070 and similar"), required before
  "Run full motor detection" is clickable. This isn't a protocol field or a
  firmware default — it just seeds a sane starting "Max Power Loss (W)"
  value for detection sizing (100W medium, 150W large; still editable
  after picking), since a bigger motor's extra copper/thermal mass
  tolerates a hotter detection pass. Then two real options:
  - "Run detection" — resistance/inductance measurement
    (`COMM_DETECT_MOTOR_R_L`, confirmed from firmware source — a
    standstill FOC test-signal measurement, rotor doesn't turn, no
    input parameters needed). Real mΩ/µH readings, but a quick sanity
    check only — not applied to your saved config by itself.
  - "Run full motor detection" — `COMM_DETECT_APPLY_ALL_FOC`, the same
    one-shot command official VESC Tool's own motor setup wizard uses.
    Confirmed from firmware source (`comm/commands.c` +
    `conf_general.c`, current mainline): this runs DC offset
    calibration, R/L + max-current measurement, an openloop
    flux-linkage measurement (motor **does** spin for this one), then
    hall/AS5147-encoder sensor detection (spins again briefly) — and
    on success, firmware applies everything to the live config and
    **writes it to flash itself**, the same trusted internal path
    VESC Tool relies on. This is why it doesn't need a guessed MCCONF
    byte layout: we're not patching bytes ourselves here at all, we're
    asking firmware to do its own verified write. See
    `buildDetectApplyAllFocRequest`/`parseDetectApplyAllFoc` in
    `vesc-protocol.js` for the full source citations and the result
    code meanings (2/1/0 = encoder/hall/sensorless detected and saved,
    negative = various failure modes, all documented inline). Always
    sent direct, never CAN-forwarded — a single-PCB dual-motor board
    (like the Flipsky 75100 Dual) already runs this for both motors
    internally on its own; the request's own `detectCan` flag is a
    separate, real-CAN-bus discovery option (left off by default in
    the wizard).

    On success, a "Detection Result" card renders under the button,
    mirroring VESC Tool's own post-detection popup: VESC ID, motor
    current, R, L, Lq-Ld, flux linkage, temp comp, and sensors. This
    needed a handful of specific MCCONF field offsets (motor current,
    R, L, Lq-Ld diff, flux linkage, temp comp) — computed by walking
    `confgenerator_serialize_mcconf`'s field order in current
    mainline firmware source byte-by-byte (mechanical, not guessed;
    see `MCCONF_MOTOR_OFFSETS` in `vesc-protocol.js` for the full
    reasoning, including confirming `float32_auto` decodes as plain
    IEEE-754 for normal values). Cross-checked once so far, not yet
    against a real capture off your board specifically: computing
    APPCONF's offsets the identical way (walking the same kind of
    firmware source field list) landed `app_to_use` at exactly byte
    33 — matching the value already confirmed against your real
    Flipsky 75100 Dual hardware, to the byte. That's a real signal
    this source matches your firmware closely, not proof for the
    MCCONF fields specifically. Worth a real verification pass before
    fully trusting it (same landmark-matching process as APPCONF) —
    it's read-only display for now, nothing here writes using these
    offsets. "VESC ID" only shows for the local/directly-connected
    motor (reading it for a linked motor would mean temporarily
    reassigning the client's global CAN target, which risks colliding
    with the dashboard's own polling — skipped rather than risking
    that). If a linked VESC's CAN ID is already selected on the
    dashboard when detection runs, a second card renders for it too.
- **Battery/current-limit config** — same status as motor detection.

## Verified end-to-end

Real-hardware confirmation: after running the pedal setup flow, the
control type and voltage mapping were checked in official VESC Tool
and matched what the wizard wrote — and survived a power cycle,
confirming the flash write actually persists (not just RAM).

## APPCONF write verification (how the real writes work)

`writeAppConf()` in `vesc-usb.js` reads a fresh copy of `COMM_GET_APPCONF`,
patches specific byte offsets, and sends the whole blob back via
`COMM_SET_APPCONF`. This is safe without having decoded every field in
the struct, because the firmware deserializes sequentially — anything
we don't touch passes through exactly as read. Confirmed from firmware
source (`comm/commands.c`): `SET_APPCONF` validates the signature,
writes straight to flash via `conf_general_store_app_configuration()`
(not just RAM — no separate commit step needed), and replies with the
bare command byte as confirmation. A malformed blob fails safe: the
firmware logs a warning and changes nothing.

**Offsets, confirmed against a real capture off Scott's Flipsky 75100
Dual on firmware 6.05** (see `APPCONF_OFFSETS` in `vesc-protocol.js`):
verified by cross-checking known firmware defaults (`timeout_msec`=1000,
PPM pulse 1.0/2.0/1.5ms, `app_uart_baudrate`=115200) against a public
reference `confgenerator.c`, then correcting for one extra byte this
firmware build has that the reference source didn't — found by
brute-force scanning nearby offsets until `app_to_use` matched the
board's actual known state (ADC+UART) and the ADC voltage block
decoded to sane volts instead of garbage.

- `appToUse` @ 33 (u8)
- `adcCtrlType` @ 90 (u8)
- `adcVoltageStart`/`End`/`Min`/`Max`/`Center` @ 95/97/99/101/103 (i16, /1000 = volts)
- `adcVoltage2Start`/`End` @ 105/107 (i16, /1000 = volts — second pedal/brake channel, not used yet)
- `throttleExp`/`throttleExpBrake` @ 114/118 (f32, raw IEEE-754, not /1000 scaled)
- `throttleExpMode` @ 122 (u8 — 0=Expo, 1=Natural, 2=Poly)
- `rampTimePos`/`rampTimeNeg` @ 123/127 (f32 raw, seconds)
- `tc` @ 132 (u8 bool — traction control on/off)
- `tcMaxDiff` @ 133 (f32 raw — ERPM mismatch threshold)

The second batch (throttle exponent through tc_max_diff) was the "unresolved
drift" flagged below on the first pass — resolved by re-analyzing the same
278-byte capture already in hand, using Scott's stated default (3000 ERPM
for `tc_max_diff`) as a landmark. Found it was a **5-boolean, not 6-boolean**
stretch on this firmware build (no `voltage2_inverted`) — one field shorter
than the reference source, same kind of version drift as the `app_to_use`
fix. Five independent values confirmed clean once corrected: `tc_max_diff`
exactly 3000.0, `app_uart_baudrate` exactly 115200, ramp times a sane
0.3s/0.1s, `multi_esc` true (correct for a dual-motor board), and
`throttle_exp_mode` landing on a valid enum value (2, not garbage).

**These offsets are specific to this one verified firmware build.**
Re-verify (same capture, cross-check against known defaults, brute-force
any drift) before trusting them against different firmware or hardware.

## Firmware version display

On connect, the dashboard reads `COMM_FW_VERSION` and shows firmware major.minor
plus the hardware name (e.g. "Firmware 6.5 · FSESC75100_DUAL") in a small banner
under the header. Response format confirmed against mainline firmware source
(`comm/commands.c`): major byte, minor byte, then a null-terminated hardware
name string (UUID and a few other fields follow, not currently parsed since
the dashboard doesn't need them).

**Firmware flashing is a distinct, much bigger ask and isn't built.** A botched
flash can brick the board — no USB, no VESC Tool, nothing, short of a hardware
recovery tool. That's a different risk tier than anything else in this app, and
it needs its own scoped effort: sourcing correct firmware binaries per detected
hardware type, and verifying the real erase/write/reboot bootloader protocol
against source before writing any code that touches it — not something to bolt
on opportunistically. Flagged here so it doesn't get lost, not attempted yet.

## Toggle/active-state styling

Every button-based toggle (App to Use, control type, traction control,
throttle curve mode, motor target selection) uses a shared `data-active="true"`
attribute + CSS rule (`.btn[data-active="true"]` in `style.css`) that glows
amber when active — same visual language everywhere, and it doubles as "this
is what's currently saved in the board's config" wherever a control's state
loads from a live read rather than a default.

## RT Data page

"RT Data" on the dashboard button row. Starts streaming immediately on open —
there's no separate "enable RT streaming" step because there isn't one in the
actual protocol: confirmed via research that VESC Tool's own RT Data view is
just fast repeated polling of `COMM_GET_VALUES` (and `COMM_GET_DECODED_ADC`
for pedal data), not a dedicated firmware streaming/subscribe command. So this
page reuses the same `startPolling`/`startAdcPolling` helpers already built
and verified for the dashboard, just faster (10 Hz) and running both at once.

Shows ERPM, duty cycle, motor current, battery current, motor temp, VESC
temp, and pedal position together, live. Pedal position uses the ADC
response's own `level` field — the board's own calibrated decode (using
whatever min/max/center is saved in APPCONF), not something recomputed here.

"Start logging" buffers timestamped samples client-side; "Save log" builds a
CSV in the browser (via Blob + object URL, no server involved) and triggers
a normal file download.

"Fixed a real bug while building this:" the main dashboard's telemetry
relies on `client.onValues`, and this was the first page to also use that
callback. Without saving/restoring the previous handler on open/close, the
dashboard would go stale after closing RT Data (`resumePollingOnClose`
restarts polling, but responses would route to RT Data's now-detached
closure instead of the visible dashboard elements). Fixed by capturing and
restoring the prior `onValues`/`onDecodedAdc` handlers around this page's
open/close, same pattern `vesc-pedal-config.js` already used for
`onAppConfRaw`.

**Added since:** battery voltage in the readout grid; a fault log (real
`mc_fault_code` names from firmware source, not guessed — logs on each
transition to a new nonzero fault, not every poll tick, so it doesn't spam);
a scrolling multi-line chart for motor current / battery current / duty
cycle, with an auto/manual Y-axis toggle and a manual window-length (seconds)
control — auto mode scales each series independently within the visible
window so three different-unit series stay readable overlaid on one chart
(current in amps next to duty in percent would otherwise dwarf each other on
a shared scale); an ERPM speedometer-style arc gauge, auto-scaling its range
to the highest ERPM seen this session; and a voltage "fuel gauge" arc. The
voltage gauge's empty/full points are **user-entered**, not read from
config — the actual low-voltage cutoff lives in MCCONF, which hasn't been
through the verification pass APPCONF got yet (motor config is intentionally
saved for last). Once that's verified, this could pull the real cutoff
automatically instead of asking for it.

## Direct-access config pages (no wizard)

Two buttons on the dashboard next to "New setup," for people who don't need
hand-holding:

- **App (pedal) config** (`js/vesc-pedal-config.js`) — real, full read/edit/save
  in one screen, organized under headed sections: control type/ADC mapping,
  pedal range & center, ramp time, traction control, killswitch mode, and
  throttle curve. Reads the board's *actual current* config on open (not a
  session capture). App-to-Use itself is read and silently preserved, never
  exposed as a toggle here (that lives in the wizard, where it's needed
  during pedal sync). Ramp time (positive) defaults to 0.3s until a real read
  overwrites it; traction control and killswitch both default to Off. A
  throttle curve exponent has a live SVG preview (the preview approximates
  the curve shape — it isn't a byte-exact render of VESC's internal math,
  which hasn't been sourced). Uses the same verified `APPCONF_OFFSETS` as the
  wizard. Carries the same pedal-arms-the-motor warning as the wizard's
  safety step, as a persistent banner rather than a click-through gate.

  **Killswitch mode**, added this session: firmware actually has 11
  `KILL_SW_MODE` values (Disabled + Low/High pairs on PPM/ADC2/ADC3/SWDIO/
  SWCLK), but Scott's kits only ever wire it to the PPM pin, so this page
  only exposes 3: Off, PPM Low, PPM High. If a board is read back with one
  of the other 8 modes set some other way (e.g. official VESC Tool), that
  raw value is preserved and Save leaves it untouched unless one of the 3
  buttons is explicitly clicked — it's never silently coerced to Off just
  because this page doesn't have a button for it. The offset
  (`APPCONF_OFFSETS.killSwMode` @ 32) is a strong cross-check, not a guess:
  reading `confgenerator_serialize_appconf` directly shows `kill_sw_mode` as
  the field immediately before `app_to_use`, and walking that exact order
  byte-by-byte lands `app_to_use` at exactly byte 33 — the same real-hardware-
  verified byte already confirmed for this build. This is also almost
  certainly the explanation for the "one extra byte around offset 32" noted
  below, from the very first APPCONF verification pass against an older
  reference source that predated `kill_sw_mode` being added to firmware.
- **Motor config** (`js/vesc-motor-config.js`) — a real decoded editor now, not
  a hex dump. Toggle at the top switches between "This VESC" and "Linked VESC"
  (one side shown/edited at a time) — no manual CAN ID entry, the linked side
  auto-detects via `detectLinkedCanId()` (see "Motor targeting" above) the
  moment that toggle is clicked, caching the result for the rest of the
  session. A persistent banner reminds that every current/power value is
  per-side, not vehicle-total (e.g. 35A Max Battery Current means 70A
  combined on a dual-motor board). Three actions: **Read config** (pulls the
  active side's live values into the form), **Write to both VESCs** (one
  button, two writes done behind the scenes — direct to this VESC, then
  CAN-forwarded to the linked VESC, auto-detecting it first if needed;
  replaces what used to be a separate "Write" (active side only) and "Copy
  to other VESC" button, since those two together always amounted to
  "push this form to both boards" anyway — deliberately never touches
  resistance/inductance/flux linkage/hall table, since those are per-motor
  physical measurements the wizard's detection step owns, not settings that
  should be pushed across motors), and **Compare sides** (auto-detects the
  linked side if needed, reads both fresh, renders a row-by-row table,
  highlighting mismatches in amber). Fields, with the same
  explanatory notes shown in the UI: Motor Current Max, Absolute Max Current,
  Max Battery Current, Motor Current Max Brake, Battery Current Max Regen,
  battery pack size (a dropdown, same combo-naming/voltage-cutoff logic as
  the wizard's battery step), forward top speed (tire diameter/gear
  ratio/pole count + slider + speedometer, same as the wizard's speed step —
  same flat 0-30mph slider ceiling too), reverse speed limit (ERPM, capped at
  -5000), ERPM limit start (%), Duty Cycle Max (%), and two fixed values
  written behind the scenes on every write (motor/FET temp cutoff at 80°C,
  acceleration temp decrease at 15%). Every value this tool doesn't let you
  edit (Absolute Max Current, the two temp fields above) is shown grayed out
  via a shared `.wizard__capture-value--fixed` CSS class rather than spelled
  out in words — that convention applies anywhere else in the app a
  non-editable value shows up, too, not just here. See
  `MCCONF_OFFSETS`/`parseMcConfConfigFields` in `vesc-protocol.js` for the
  full field list and offsets, mechanically re-derived this session by
  reading `confgenerator_serialize_mcconf` directly rather than spot-checking
  individual fields (see the big comment there). **Same verification caveat
  as the wizard's battery/speed steps applies here, times many more fields**
  — none of this has been checked against a real hardware capture. This page
  is the natural place to eventually do that capture-and-diff pass (Read both
  sides, compare the hex against what VESC Tool shows for the same board).

Only one full-screen page (wizard or either config page) can be open at a
time — opening one closes whatever else was open, so two overlays never stack.

## Known gaps

1. **Flux linkage detection — RESOLVED.** Previously flagged as a
   real pre-launch blocker: the raw single-shot
   `COMM_DETECT_MOTOR_FLUX_LINKAGE` command needs hand-picked
   parameters, and it wasn't confirmed whether official VESC Tool's
   automatic-retry detection logic lived in firmware or in VESC
   Tool's own app code. Answer, confirmed from firmware source: it
   lives entirely in firmware, as `COMM_DETECT_APPLY_ALL_FOC` /
   `conf_general_detect_apply_all_foc[_can]`. That single command runs
   the full measure-and-apply sequence (including flux linkage) and
   saves it to flash on success — nothing to replicate on our side.
   Wired into the wizard's motor step as "Run full motor detection."
   Customers get the real thing, not a "use VESC Tool for this one
   step" workaround.
2. **MCCONF write format still unverified against a real capture —
   the live blocker, and now the biggest one in the app.** The
   wizard's battery/speed steps AND the standalone Motor Config page
   (see below) all write to MCCONF now — current limits, battery
   cutoffs, ERPM limits, ERPM-limit-start, duty cycle max, gearing,
   and two fixed temp-protection fields — using offsets that are only
   *mechanically* derived (this session, by reading
   `confgenerator_serialize_mcconf`'s source directly field-by-field,
   which is a stronger derivation than the original pass and happened
   to land on the exact same byte numbers for every field the
   original pass already covered — a real cross-check, but still not
   a hardware one), not confirmed against a real capture the way
   every APPCONF offset is. Detection's `MCCONF_MOTOR_OFFSETS`
   (currentMax/focMotor*) are read-only display and low-risk if
   slightly off; all of these write offsets are not — writing the
   wrong bytes corrupts real motor config on flash. **Do the same
   capture-and-diff pass used for APPCONF before shipping the
   battery/speed wizard steps or the Motor Config page's writes to an
   actual customer kit.**
3. **BLE not wired in yet.** `vesc-ble.js` mirrors the USB client's
   read/polling shape, but not yet `writeAppConf`/`detectApplyAllFoc`/
   `writeMcConfRaw`/`writeMcConfBothSides` — those need mirroring
   before BLE can run the wizard's real writes, including the new
   battery/speed steps. `app.js` currently imports `VescUsbClient`
   regardless.
4. **BLE-specific gaps carried forward for later:** reconnect-on-drop
   logic, and confirming the device filter matches whatever BLE module
   ships in a given client's kit (Nordic UART service UUID vs. a
   `namePrefix` fallback — both already sketched in `vesc-ble.js`).

## Battery step (wizard)

Asks for pack size as an S-count (5S-20S), labeling 5/10/15/20S with
the M18/DeWalt-20V combo naming ("5S (1x M18 / DeWalt 20V)") since
those are the packs actually stacked in series on these kits; other
S-counts just show plain "13S" rather than a made-up combo name.
Nominal voltage uses 3.6V/cell (this is also what makes "M18" literal:
5 x 3.6V = 18V).

**The voltage cutoffs are NOT the numbers originally specified** (25%
start / 28% end of nominal voltage) — that formula is both dangerously
low for lithium chemistry (25-28% of nominal works out to roughly
0.9-1.0V/cell, which is well past where a cell is damaged, not a safe
cutoff) and backwards (a "cutoff end," the harder limit, needs to be a
*lower* voltage than "cutoff start," not higher). Implemented instead
with standard li-ion values: 3.3V/cell where the VESC starts tapering
current back ("start"), 3.0V/cell where it cuts to zero ("end") — see
`batteryVoltages()` in `vesc-protocol.js`. `l_min_vin`/`l_max_vin` get
set to 2.7V/cell and 4.25V/cell respectively as the absolute
under/over-voltage fault floor/ceiling. Regen cutoff fields
(`l_battery_regen_cut_start/end`) are deliberately left untouched —
out of scope for what was asked, and every byte not explicitly
patched passes through unchanged.

"Apply" writes to both motors on a dual-motor board (see
`writeMcConfBothSides` below) and reports plainly whether it wrote one
side or two.

## Speed step (wizard)

Asks for tire diameter (mm), and pre-fills gear ratio and motor pole
count from a live `COMM_GET_MCCONF` read (rather than asking the
person to guess a mechanical spec blind) — both remain editable in
case the read is wrong or the person needs to override it. A slider
(0-30 mph, flat regardless of battery size — Scott's call: if someone
wants to go faster than that, the "onboarding test" is learning real
VESC Tool) sets the desired top speed; an SVG speedometer graphic and
the computed ERPM both update live as it moves. Reverse speed is set
to mirror forward (same magnitude, negated) — no separate reverse-speed
control was asked for, and a symmetric default is the safer assumption
than silently picking an asymmetric one.

The ERPM/speed conversion is the exact formula sourced from firmware's
own `COMM_SET_MCCONF_TEMP_SETUP` handler in `commands.c`:

```
fact = (motor_poles / 2) * 60 * gear_ratio / (wheel_diameter_m * PI)
erpm = speed_m_per_s * fact
```

(`erpmSpeedFactor`/`erpmToMps`/`mpsToErpm` in `vesc-protocol.js`.)
"Finish setup" writes wheel diameter (converted mm->meters), gear
ratio, pole count, and both ERPM limits, to both motors, same
both-sides pattern as the battery step, then advances to the closing
screen.

## MCCONF writes: writeMcConfRaw / writeMcConfBothSides

Mirrors `writeAppConf`'s read-patch-write-and-await-ack pattern
(`vesc-usb.js`): read a fresh `COMM_GET_MCCONF`, patch only the
specific offsets given (`applyAppConfPatches` — despite the name, it's
blob-agnostic and reused as-is here), write the whole blob back via
`COMM_SET_MCCONF`, wait for firmware's bare-command-byte ack (same
confirmation pattern as `SET_APPCONF`, per `commands.c`).

The important difference from `detectApplyAllFoc`: `SET_MCCONF` is
**not** automatically dual-motor-aware — a direct write only ever
touches the currently-selected motor thread, unlike
`DETECT_APPLY_ALL_FOC`, which firmware fans out to both motors itself
on a single-PCB dual-motor board. So `writeMcConfBothSides()` sends
the write twice: once direct, and — if a linked CAN ID is known
(`client.targetCanId`, set from the dashboard's CAN pairing) — once
more, `COMM_FORWARD_CAN`-wrapped to that ID. It surfaces exactly what
happened (`{ direct, linked }`, `linked` being `null`/`true`/`false`)
rather than reporting a flat success, specifically so a kit doesn't
silently ship with only one motor's battery/speed config actually set.

## Profiles

Three named tune presets, edited on a standalone "Profiles" page
(`vesc-profiles-page.js`) and stored in `localStorage`
(`oemods_vesc_profiles_v1` — per-device, not synced anywhere; data
and apply logic live in `vesc-profiles.js`). A profile covers every
Motor Config and App Config field that's a genuine driving-style
choice: current limits, battery cutoffs, speed/gearing, ramp time,
traction control, killswitch mode, throttle curve.

**Deliberately excluded:** pedal ADC voltage calibration (min/max/
center) and control type. Those describe how one specific pedal is
physically wired and calibrated on this vehicle, not a driving
preference — switching them on a profile pick would be wrong, not
just out of scope, since the pedal hasn't moved just because someone
tapped "Profile 2." This is a real design decision, not an
oversight, and it's worth knowing about if a future request assumes
Profiles cover "everything."

Applying a profile from the home screen (`applyProfile()`) writes
MCCONF via `writeMcConfBothSides` (direct + linked, if any — same
`{direct, linked, linkedError}` result shape as everywhere else) and
APPCONF via `writeAppConf` (direct only, matching how App Config
writes have always worked here). The Profiles page's own "Save" never
blocks on incomplete fields — you can build one profile at a time and
leave the other two half-filled — but the home screen's quick-switch
buttons re-validate (`validateProfile`) before attempting to apply,
so a half-finished profile can be saved but not accidentally pushed to
the board. The Profiles page also has a "Read current VESC into this
profile" convenience button, using the same MCCONF/APPCONF decode
already built for Motor Config / App Config.

## Quick Adjust

Four single-field bottom-sheet panels on the home screen (Speed, Ramp
Time, Motor Current, Battery Current — `vesc-quick-adjust.js`,
`QuickAdjustPanel`) for a fast in-the-driveway tweak without opening
the full Motor Config / App Config pages. Each one reads the live
value on open and writes it back on Save; what's actually read/
written is entirely supplied by the caller (`app.js`) as a small
`{title, unit, min, max, step, readValue, writeValue}` config — the
component itself has no VESC-specific knowledge. Speed reads/writes
`lMaxErpm` via the same ERPM↔mph conversion as the wizard and Motor
Config (and needs pole/gear/wheel data set first — it throws a clear
error if that hasn't been run yet); Ramp Time reads/writes
`rampTimePos`; Motor/Battery Current read/write `lCurrentMax`/
`lInCurrentMax`, both via `writeMcConfBothSides` like everywhere else.

## Home screen dashboard layout

Redesigned as a mobile-friendly "bike dashboard" for parents
monitoring the vehicle in real time: a large speed readout up top
(`#dashboardHero`, computed live from `GET_VALUES`' ERPM field plus
cached pole/gear/wheel data — refreshed after any page close, profile
apply, or Quick Adjust save that could have changed it), the existing
duty-cycle gauge and telemetry tiles below, then the Profiles/Quick
Adjust quick-action buttons, and the full-page-opening buttons (New
setup / App config / Motor config / Profiles / RT Data) last. Grids
collapse to fewer columns under 480px so it stays usable one-handed
on a phone mounted to the vehicle.

## Next milestone

Motor detection is unlocked for real (see Known gaps #1), and the
battery/speed wizard steps are built and wired to real writes (see
above). What's left, in priority order: the capture-and-verify pass
against a real `COMM_GET_MCCONF` dump to confirm the new write offsets
(Known gaps #2 — this is the one that actually matters before a real
customer kit uses the battery/speed steps, Profiles, or Quick Adjust),
then BLE parity (#3/#4).
