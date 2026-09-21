/**
 * vesc-wizard.js
 * ------------------------------------------------------------------
 * Customer-facing "New Setup" walkthrough. Renders into a container
 * element, steps through: welcome/safety -> pedal sync -> motor
 * detection -> battery/spec config -> done.
 *
 * Pedal sync is fully wired (COMM_GET_DECODED_ADC, live, read-only,
 * safe with no motor attached). Motor detection is real and does
 * write to the board: resistance/inductance detection (standstill,
 * COMM_DETECT_MOTOR_R_L) and the full "detect + apply all FOC
 * parameters" routine (COMM_DETECT_APPLY_ALL_FOC — same one-shot
 * command official VESC Tool's own motor wizard uses, confirmed
 * against firmware source, see vesc-protocol.js). That command's
 * apply-and-save happens inside firmware itself, so this doesn't
 * need a guessed MCCONF byte layout the way APPCONF writes do.
 *
 * Battery and speed steps ARE real, permanent SET_MCCONF writes, done
 * to both motors on a dual-motor board (see writeMcConfBothSides in
 * vesc-usb.js — SET_MCCONF, unlike DETECT_APPLY_ALL_FOC, only affects
 * one motor thread per write, so this sends it twice). IMPORTANT: the
 * specific MCCONF byte offsets these two steps write to (battery
 * cutoffs, ERPM limits, gear ratio, wheel diameter, pole count) are
 * mechanically derived from firmware source, same method used for the
 * Detection Result card, but have NOT been cross-checked against a
 * real hardware capture the way APPCONF's offsets have. See the
 * MCCONF_OFFSETS comment in vesc-protocol.js before trusting these on
 * a real customer kit.
 * ------------------------------------------------------------------
 */

import {
  APPCONF_OFFSETS, CONTROL_TYPES, parseMcConfMotorSummary,
  MCCONF_OFFSETS, parseMcConfSetupFields, batteryComboLabel, batteryVoltages,
  mpsToErpm, PULLEY_MOTOR_TEETH_OPTIONS, PULLEY_HUB_TEETH_OPTIONS,
  pulleyGearRatio, closestPulleyPair,
} from './vesc-protocol.js';

const STEPS = ['safety', 'welcome', 'resetDefaults', 'pedal', 'controlType', 'pedalRange', 'motor', 'battery', 'speed', 'done'];

// mm/s -> mph, for the speed step's slider/speedometer (Scott's kits and
// customers all think in mph, not the SI units the firmware math wants).
const MPS_TO_MPH = 2.2369362921;

// Motor size picker, shown before detection starts. maxPowerLoss is just
// a starting default for the "Max Power Loss (W)" field below it (used
// to size detection current) — not a firmware default or a protocol
// value, so it's fine to be an engineering judgment call: bigger motors
// have more copper/thermal mass and tolerate a hotter detection pass.
// The person can always override the number after picking a size.
const MOTOR_SIZES = [
  { value: 'medium', label: 'Medium Outrunner', desc: '6374 and similar', maxPowerLoss: 100 },
  { value: 'large', label: 'Large Outrunner', desc: '7070 and similar', maxPowerLoss: 150 },
];

/**
 * ADC control type options. Values are the real ADC_CTRL_TYPE_* enum
 * values from firmware source (datatypes.h) — confirmed, not guessed.
 * Only exposing the three that actually come up for these kits rather
 * than the full firmware list (duty-cycle control, PID position, etc.
 * aren't relevant here and would just add confusing options).
 */
/**
 * Best-practice starting point for the center voltage, not a firmware
 * requirement — center is a tuning choice and the person can always
 * override it. For a single-direction, spring-return pedal (which is
 * what these kits use), idle position is the sane default across both
 * control types; only the REV_BUTTON_BRAKE_CENTER mode actually
 * depends on it functionally.
 */
function recommendedCenterVoltage(controlTypeValue, idleVoltage) {
  return idleVoltage;
}

export class SetupWizard {
  /**
   * @param {HTMLElement} root - container to render into (should be empty/hidden until open())
   * @param {object} client - VescUsbClient or VescBleClient instance (already connected)
   */
  constructor(root, client) {
    this.root = root;
    this.client = client;
    this.stepIndex = 0;
    this.pedalCapture = { idleVoltage: null, fullVoltage: null };
    this.controlType = null; // one of CONTROL_TYPES[].value, set in the controlType step
    this._rangeMin = null;
    this._rangeMax = null;
    this._rangeCenter = null;
    this.motorSize = null; // 'medium' | 'large', picked before detection starts
    this.motorRL = null; // { resistance, inductance } from the motor step, session-only
    this.fullDetectionResult = null; // { code, message, success } from detectApplyAllFoc, session-only
    this.detectionResultCards = null; // rendered HTML of the last detection-result card(s), session-only
    this.batteryS = null; // selected S-count, battery step
    this.batteryWritten = false;
    this.wheelDiameterMm = null; // speed step
    this.motorPulleyTeeth = null; // pulley calculator, speed step
    this.hubPulleyTeeth = null;   // pulley calculator, speed step
    this.gearRatio = null;       // derived from the pulley teeth above (or prefilled from a live MCCONF read as an approximation)
    this.motorPoles = null;      // prefilled from a live MCCONF read, editable
    this.speedLimitMph = null;   // desired top speed, drives the slider/speedometer
    this.speedWritten = false;
    this._stopAdcPolling = null;
    this._latestAdc = null;
    this.onClose = null; // () => void, called when wizard finishes or is cancelled
  }

  open() {
    this.stepIndex = 0;
    this.pedalCapture = { idleVoltage: null, fullVoltage: null };
    this.controlType = null;
    this._rangeMin = null;
    this._rangeMax = null;
    this._rangeCenter = null;
    this.motorSize = null;
    this.motorRL = null;
    this.fullDetectionResult = null;
    this.detectionResultCards = null;
    this.batteryS = null;
    this.batteryWritten = false;
    this.wheelDiameterMm = null;
    this.motorPulleyTeeth = null;
    this.hubPulleyTeeth = null;
    this.gearRatio = null;
    this.motorPoles = null;
    this.speedLimitMph = null;
    this.speedWritten = false;
    this.root.hidden = false;
    this._render();
  }

  close() {
    this._stopAdc();
    this.root.hidden = true;
    this.root.innerHTML = '';
    if (this.onClose) this.onClose();
  }

  _goTo(index) {
    this._stopAdc();
    this.stepIndex = Math.max(0, Math.min(STEPS.length - 1, index));
    this._render();
  }

  _next() { this._goTo(this.stepIndex + 1); }
  _back() { this._goTo(this.stepIndex - 1); }

  _stopAdc() {
    if (this._stopAdcPolling) { this._stopAdcPolling(); this._stopAdcPolling = null; }
  }

  _render() {
    const step = STEPS[this.stepIndex];
    this.root.innerHTML = '';
    this.root.appendChild(this._buildChrome(step));
  }

  _buildChrome(step) {
    const wrap = document.createElement('div');
    wrap.className = 'wizard';

    const head = document.createElement('div');
    head.className = 'wizard__head';
    head.innerHTML = `
      <span class="wizard__title">New setup</span>
      <span class="wizard__progress">${this.stepIndex + 1} of ${STEPS.length}</span>
    `;
    wrap.appendChild(head);

    const body = document.createElement('div');
    body.className = 'wizard__body';
    body.appendChild(this._buildStep(step));
    wrap.appendChild(body);

    return wrap;
  }

  _buildStep(step) {
    switch (step) {
      case 'safety': return this._stepSafety();
      case 'welcome': return this._stepWelcome();
      case 'resetDefaults': return this._stepResetDefaults();
      case 'pedal': return this._stepPedal();
      case 'controlType': return this._stepControlType();
      case 'pedalRange': return this._stepPedalRange();
      case 'motor': return this._stepMotor();
      case 'battery': return this._stepBattery();
      case 'speed': return this._stepSpeed();
      case 'done': return this._stepDone();
      default: return document.createElement('div');
    }
  }

  // ---------------- Step: Safety acknowledgment (gate, must click through) ----------------

  _stepSafety() {
    const el = document.createElement('div');
    el.innerHTML = `
      <div class="wizard__warning">
        <span class="wizard__warning-badge">IMPORTANT: PLEASE READ</span>
        <h2 class="wizard__heading">The motor can move during this setup</h2>
        <p class="wizard__text">This VESC's pedal input directly drives the motor, the same
        control loop used when actually riding. If a motor is connected, pressing the pedal
        during setup <strong>can spin it for real</strong>, not just show a number on screen.</p>
        <p class="wizard__text"><strong>VEHICLE MUST BE LIFTED WITH THE DRIVE WHEELS OFF THE
        GROUND AND CLEAR OF OBSTACLES.</strong></p>
      </div>
    `;
    const footer = document.createElement('div');
    footer.className = 'wizard__footer';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn--secondary';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => this.close());
    footer.appendChild(cancelBtn);

    const ackBtn = document.createElement('button');
    ackBtn.className = 'btn btn--primary';
    ackBtn.textContent = 'I understand, continue';
    ackBtn.addEventListener('click', () => this._next());
    footer.appendChild(ackBtn);

    el.appendChild(footer);
    return el;
  }

  // ---------------- Step: Welcome ----------------

  _stepWelcome() {
    const el = document.createElement('div');
    el.innerHTML = `
      <h2 class="wizard__heading">Let's get your controller set up</h2>
      <p class="wizard__text">This walks through syncing your pedal and configuring your
      motor and battery settings. Takes a few minutes.</p>
    `;
    el.appendChild(this._buildFooter({ back: false, nextLabel: 'Start' }));
    return el;
  }

  // ---------------- Step: Reset to firmware defaults (optional) ----------------
  //
  // Mirrors official VESC Tool's own first-run prompt: before anything
  // else is configured, offer to wipe the board's current motor
  // (MCCONF) and app (APPCONF) config back to firmware's compiled-in
  // defaults. Safe to skip — every later step in this wizard writes
  // its own values regardless — but starting from a known-clean slate
  // avoids exactly the kind of stale/mismatched leftover config (see
  // the battery-cutoff issue that prompted adding this) that a prior
  // setup, a half-finished tune, or another tool can leave behind.
  //
  // Uses COMM_GET_MCCONF_DEFAULT/COMM_GET_APPCONF_DEFAULT + a plain
  // write-back (see resetMcConfToDefaultsBothSides/resetAppConfToDefaults
  // in vesc-usb.js) — firmware splices this board's real ADC
  // calibration into the "default" blob it returns, so this can't
  // clobber hardware calibration the way a guessed byte-patch could.

  _stepResetDefaults() {
    const el = document.createElement('div');
    el.innerHTML = `
      <h2 class="wizard__heading">Reset to firmware defaults?</h2>
      <p class="wizard__text">Before syncing your pedal, you can wipe this VESC's motor and
      app configuration back to firmware's out-of-the-box defaults. This clears out anything
      left over from a previous setup or tune — including this VESC's own hardware calibration,
      which firmware re-applies automatically, so nothing gets lost.</p>
      <p class="wizard__text">Every setting this wizard touches gets written fresh in the
      steps ahead either way, so this is optional — but it's a good habit if this board has
      been configured before, or if something about its current behavior seems off.</p>
      <p class="wizard__text wizard__text--note" id="wizResetDefaultsStatus"></p>
    `;

    const footer = document.createElement('div');
    footer.className = 'wizard__footer';
    const statusEl = el.querySelector('#wizResetDefaultsStatus');

    const backBtn = document.createElement('button');
    backBtn.className = 'btn btn--secondary';
    backBtn.textContent = 'Back';
    backBtn.addEventListener('click', () => this._back());
    footer.appendChild(backBtn);

    const skipBtn = document.createElement('button');
    skipBtn.className = 'btn btn--secondary';
    skipBtn.textContent = 'Skip';
    skipBtn.addEventListener('click', () => this._next());
    footer.appendChild(skipBtn);

    const resetBtn = document.createElement('button');
    resetBtn.className = 'btn btn--primary';
    resetBtn.textContent = 'Reset to defaults';
    resetBtn.addEventListener('click', async () => {
      resetBtn.disabled = true;
      skipBtn.disabled = true;
      backBtn.disabled = true;
      statusEl.classList.remove('wizard__text--warn');
      statusEl.textContent = 'Resetting motor config…';
      try {
        await this.client.resetMcConfToDefaultsBothSides();
        statusEl.textContent = 'Resetting app config…';
        await this.client.resetAppConfToDefaults();
        statusEl.textContent = 'Reset complete.';
        this._next();
      } catch (err) {
        statusEl.classList.add('wizard__text--warn');
        statusEl.textContent = `Reset failed: ${err.message}. You can try again, or skip and continue.`;
        resetBtn.disabled = false;
        skipBtn.disabled = false;
        backBtn.disabled = false;
      }
    });
    footer.appendChild(resetBtn);

    el.appendChild(footer);
    return el;
  }

  // ---------------- Step: Pedal sync ----------------

  _stepPedal() {
    const el = document.createElement('div');
    el.innerHTML = `
      <h2 class="wizard__heading">Sync your pedal</h2>
      <p class="wizard__text">Without touching the pedal, press the "Capture Idle" button.</p>
      <p class="wizard__text">Once that is set, press and hold the pedal at full throttle,
      while pressing the "Capture Full Throttle" button.</p>
      <p class="wizard__text">Once both values have been set, click continue.</p>

      <p class="wizard__text wizard__text--warn">*** Please note: you must be connected to
      the side of the VESC that is associated with the pedal inputs. If you are not on the
      correct side, exit the setup, back to the main screen. On the bottom of the page,
      select "LINKED VESC". You may also power the controller down, and move the USB to the
      other side of the VESC.</p>
      <p class="wizard__text wizard__text--warn">If you are seeing an idle voltage around
      1.4V, this is an indicator that the wrong VESC is selected, or the wiring is
      misconfigured. ***</p>

      <p class="wizard__text wizard__text--note" id="wizAppModeStatus">Preparing pedal
      input…</p>

      <div class="wizard__live">
        <span class="wizard__live-label">Live pedal voltage</span>
        <span class="wizard__live-value"><span id="wizAdcVoltage">–</span><span class="readout__unit">V</span></span>
      </div>

      <div class="wizard__capture-row">
        <div class="wizard__capture">
          <span class="wizard__capture-label">Idle (released)</span>
          <span class="wizard__capture-value" id="wizIdleValue">Not captured</span>
          <button class="btn btn--secondary" id="wizCaptureIdle">Capture Idle</button>
        </div>
        <div class="wizard__capture">
          <span class="wizard__capture-label">Full throttle</span>
          <span class="wizard__capture-value" id="wizFullValue">Not captured</span>
          <button class="btn btn--secondary" id="wizCaptureFull">Capture Full Throttle</button>
        </div>
      </div>
    `;

    const idleValueEl = el.querySelector('#wizIdleValue');
    const fullValueEl = el.querySelector('#wizFullValue');
    const voltageEl = el.querySelector('#wizAdcVoltage');
    const statusEl = el.querySelector('#wizAppModeStatus');

    // Restore any prior capture from this session
    if (this.pedalCapture.idleVoltage != null) {
      idleValueEl.textContent = `${this.pedalCapture.idleVoltage.toFixed(2)} V`;
    }
    if (this.pedalCapture.fullVoltage != null) {
      fullValueEl.textContent = `${this.pedalCapture.fullVoltage.toFixed(2)} V`;
    }

    const canAdvance = () =>
      this.pedalCapture.idleVoltage != null && this.pedalCapture.fullVoltage != null;
    const footer = this._buildFooter({ back: true, nextLabel: 'Continue', nextEnabled: canAdvance });

    const startLivePolling = () => {
      this.client.onDecodedAdc = (adc) => {
        this._latestAdc = adc;
        voltageEl.textContent = adc.voltage.toFixed(3);
      };
      this._stopAdcPolling = this.client.startAdcPolling(100);
    };

    // Real write: same thing official VESC Tool does on entering its
    // input wizard — switch App to Use to ADC+UART so the ADC decode
    // thread is actually running before we try to read anything. This
    // is what fixes the "pedal reads 0" issue from earlier.
    this.client.writeAppConf([
      { offset: APPCONF_OFFSETS.appToUse, type: 'u8', value: 5 }, // 5 = APP_ADC_UART
    ]).then(() => {
      statusEl.textContent = 'Pedal input ready.';
      startLivePolling();
    }).catch((err) => {
      statusEl.textContent = `Couldn't prepare pedal input automatically (${err.message}). ` +
        'If the voltage below stays flat, exit and reconnect, then retry.';
      statusEl.classList.add('wizard__text--warn');
      startLivePolling(); // still let them read/retry manually even if the write failed
    });

    el.querySelector('#wizCaptureIdle').addEventListener('click', () => {
      if (!this._latestAdc) return;
      this.pedalCapture.idleVoltage = this._latestAdc.voltage;
      idleValueEl.textContent = `${this._latestAdc.voltage.toFixed(2)} V`;
      footer.refreshNext();
    });

    el.querySelector('#wizCaptureFull').addEventListener('click', () => {
      if (!this._latestAdc) return;
      this.pedalCapture.fullVoltage = this._latestAdc.voltage;
      fullValueEl.textContent = `${this._latestAdc.voltage.toFixed(2)} V`;
      footer.refreshNext();
    });

    el.appendChild(footer);
    return el;
  }

  // ---------------- Step: Control type ----------------

  _stepControlType() {
    const el = document.createElement('div');
    el.innerHTML = `
      <h2 class="wizard__heading">Choose your control type</h2>
      <p class="wizard__text">This decides how the pedal (and second pedal, if you've got
      one) maps to throttle, reverse, and braking. Pick the one that matches this build.</p>
      <div class="wizard__options" id="wizControlOptions"></div>
    `;

    const optionsEl = el.querySelector('#wizControlOptions');
    let footer; // defined below, referenced by the click handler

    CONTROL_TYPES.forEach((opt) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'wizard__option';
      card.dataset.active = String(this.controlType === opt.value);
      card.innerHTML = `
        <span class="wizard__option-label">${opt.label}</span>
        <span class="wizard__option-desc">${opt.desc}</span>
      `;
      card.addEventListener('click', () => {
        this.controlType = opt.value;
        optionsEl.querySelectorAll('.wizard__option').forEach((c) => {
          c.dataset.active = String(c === card);
        });
        footer.refreshNext();
      });
      optionsEl.appendChild(card);
    });

    const canAdvance = () => this.controlType != null;
    footer = this._buildFooter({ back: true, nextLabel: 'Continue', nextEnabled: canAdvance });

    el.appendChild(this._buildNote(
      'This gets written to the VESC on the next screen, along with your pedal range and center.'
    ));
    el.appendChild(footer);
    return el;
  }

  // ---------------- Step: Pedal range & center (real write) ----------------

  _stepPedalRange() {
    const el = document.createElement('div');

    // Seed min/max from what pedal sync already captured; center defaults
    // to the recommendation for whichever control type was picked.
    if (this._rangeMin == null) this._rangeMin = this.pedalCapture.idleVoltage;
    if (this._rangeMax == null) this._rangeMax = this.pedalCapture.fullVoltage;
    if (this._rangeCenter == null) {
      this._rangeCenter = recommendedCenterVoltage(this.controlType, this.pedalCapture.idleVoltage);
    }

    el.innerHTML = `
      <h2 class="wizard__heading">Set pedal range &amp; center</h2>
      <p class="wizard__text">Fine-tune the min/max from pedal sync if needed, and set the
      center point. This is what actually gets written to the VESC.</p>

      <p class="wizard__text">- If you are configuring for Power Wheels style braking
      and shifter (Current Reverse Switch Brake Center), the center voltage determines where
      braking begins and forward torque begins. Do NOT set it at the same value as your idle
      voltage. We recommend keeping this value between 1V and 1.8V, with the lower voltage
      giving a less touchy, smoother pedal feel.</p>

      <p class="wizard__text">- If you are configuring for use of a second pedal for
      motor braking, the center voltage controls when regenerative braking begins. We
      recommend keeping this value between 1V and 1.5V to prevent regen braking from
      activating while low throttle cruising is underway.</p>

      <p class="wizard__text wizard__text--note">Recommended settings for ADC2 and center
      braking: 0.87V min, 1.1V center, 2.5V max.</p>

      <div class="wizard__live">
        <span class="wizard__live-label">Live pedal voltage</span>
        <span class="wizard__live-value"><span id="wizRangeLiveVoltage">–</span><span class="readout__unit">V</span></span>
      </div>

      <div class="wizard__capture-row">
        <div class="wizard__capture">
          <span class="wizard__capture-label">Min (idle)</span>
          <input type="number" step="0.01" class="motor-target__input wizard__num-input" id="wizMinInput" />
        </div>
        <div class="wizard__capture">
          <span class="wizard__capture-label">Max (full throttle)</span>
          <input type="number" step="0.01" class="motor-target__input wizard__num-input" id="wizMaxInput" />
        </div>
      </div>

      <div class="wizard__capture" style="margin-top:10px;">
        <span class="wizard__capture-label">Center</span>
        <input type="number" step="0.01" class="motor-target__input wizard__num-input" id="wizCenterInput" />
        <div class="wizard__capture-row" style="margin:10px 0 0;">
          <button class="btn btn--secondary" id="wizCaptureCenter">Capture from pedal</button>
          <button class="btn btn--secondary" id="wizUseRecommendedCenter">Use recommended</button>
        </div>
      </div>

      <p class="wizard__text wizard__text--note" id="wizSaveStatus"></p>
    `;

    const minInput = el.querySelector('#wizMinInput');
    const maxInput = el.querySelector('#wizMaxInput');
    const centerInput = el.querySelector('#wizCenterInput');
    const liveVoltageEl = el.querySelector('#wizRangeLiveVoltage');
    const statusEl = el.querySelector('#wizSaveStatus');

    minInput.value = this._rangeMin != null ? this._rangeMin.toFixed(2) : '';
    maxInput.value = this._rangeMax != null ? this._rangeMax.toFixed(2) : '';
    centerInput.value = this._rangeCenter != null ? this._rangeCenter.toFixed(2) : '';

    minInput.addEventListener('input', () => { this._rangeMin = parseFloat(minInput.value); });
    maxInput.addEventListener('input', () => { this._rangeMax = parseFloat(maxInput.value); });
    centerInput.addEventListener('input', () => { this._rangeCenter = parseFloat(centerInput.value); });

    this.client.onDecodedAdc = (adc) => {
      this._latestAdc = adc;
      liveVoltageEl.textContent = adc.voltage.toFixed(3);
    };
    this._stopAdcPolling = this.client.startAdcPolling(100);

    el.querySelector('#wizCaptureCenter').addEventListener('click', () => {
      if (!this._latestAdc) return;
      this._rangeCenter = this._latestAdc.voltage;
      centerInput.value = this._rangeCenter.toFixed(2);
    });

    el.querySelector('#wizUseRecommendedCenter').addEventListener('click', () => {
      this._rangeCenter = recommendedCenterVoltage(this.controlType, this.pedalCapture.idleVoltage);
      centerInput.value = this._rangeCenter.toFixed(2);
    });

    const footer = this._buildFooter({ back: true, nextLabel: 'Save & continue' });
    // Override the default "just go next" behavior — this button does a
    // real write first, and only advances once it's confirmed.
    const nextBtn = footer.querySelector('.btn--primary');
    nextBtn.replaceWith(nextBtn.cloneNode(true)); // strip the default _next() listener
    const saveBtn = footer.querySelector('.btn--primary');
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      statusEl.textContent = 'Writing to VESC…';
      statusEl.classList.remove('wizard__text--warn');
      try {
        await this.client.writeAppConf([
          { offset: APPCONF_OFFSETS.adcCtrlType, type: 'u8', value: this.controlType },
          { offset: APPCONF_OFFSETS.adcVoltageStart, type: 'i16', value: this._rangeMin, scale: 1000 },
          { offset: APPCONF_OFFSETS.adcVoltageEnd, type: 'i16', value: this._rangeMax, scale: 1000 },
          { offset: APPCONF_OFFSETS.adcVoltageCenter, type: 'i16', value: this._rangeCenter, scale: 1000 },
          // Setup's done — switch off UART (ADC+UART was only needed so
          // the wizard could talk to the board while also reading the
          // pedal) and leave it on plain ADC for normal operation. Same
          // manual step Scott was doing after every setup — now automatic.
          { offset: APPCONF_OFFSETS.appToUse, type: 'u8', value: 2 }, // 2 = APP_ADC
        ]);
        statusEl.textContent = 'Saved — switched back to ADC-only for normal operation.';
        this._next();
      } catch (err) {
        statusEl.textContent = `Write failed: ${err.message}. Nothing was changed — try again.`;
        statusEl.classList.add('wizard__text--warn');
        saveBtn.disabled = false;
      }
    });

    el.appendChild(footer);
    return el;
  }

  // ---------------- Step: Motor detection (placeholder) ----------------

  _stepMotor() {
    const el = document.createElement('div');
    el.innerHTML = `
      <h2 class="wizard__heading">Motor detection</h2>

      <p class="wizard__text wizard__text--note" style="margin-bottom:6px;">Motor size</p>
      <div class="wizard__options" id="wizMotorSizeOptions" style="margin-bottom:22px;"></div>

      <p class="wizard__text">This measures your motor's resistance and inductance.
      It's a standstill test — the firmware injects a small test signal to measure the
      windings, the rotor doesn't turn. Safe with the motor connected as-is.</p>

      <div class="wizard__capture-row">
        <div class="wizard__capture">
          <span class="wizard__capture-label">Resistance</span>
          <span class="wizard__capture-value" id="wizResistanceValue">Not measured</span>
        </div>
        <div class="wizard__capture">
          <span class="wizard__capture-label">Inductance</span>
          <span class="wizard__capture-value" id="wizInductanceValue">Not measured</span>
        </div>
      </div>

      <button class="btn btn--secondary" id="wizRunDetection">Run detection</button>
      <p class="wizard__text wizard__text--note" id="wizDetectionStatus"></p>

      <p class="wizard__text wizard__text--note">This standstill reading isn't applied to
      your saved motor config by itself — it's just a quick, safe sanity check. Use "Full
      motor detection" below to actually measure everything and save it for real.</p>

      <div class="wizard__warning" style="margin-top:18px;">
        <span class="wizard__warning-badge">This one spins the motor</span>
        <p class="wizard__text" style="margin:0 0 10px;">Full motor detection measures
        resistance, inductance, and flux linkage, then detects your hall sensors or
        encoder (or confirms sensorless) — all in one step. Unlike the standstill test
        above, the motor <strong>will actually spin</strong> for a few seconds during
        this, both for the flux-linkage measurement and again during sensor detection.
        Make sure the wheels are still lifted and clear. It takes 15&ndash;30 seconds —
        don't disconnect or navigate away while it's running.</p>
        <p class="wizard__text" style="margin:0;">On success, firmware applies AND
        permanently saves the results to your VESC's motor config — this is a real
        write, not a preview, using the same one-shot command official VESC Tool's own
        motor wizard uses.</p>
      </div>

      <p class="wizard__text wizard__text--note" style="margin:14px 0 6px;">Max power
      loss (W) — used to size detection current and, from that, your current limits.
      Picking a motor size above fills in a sane starting point; adjust it if you know
      better for your specific motor.</p>
      <input type="number" step="1" value="100" class="motor-target__input wizard__num-input"
        id="wizMaxPowerLoss" style="margin-bottom:14px;" />

      <button class="btn btn--primary" id="wizRunFullDetection" disabled>Run full motor detection</button>
      <p class="wizard__text wizard__text--note" id="wizFullDetectionStatus"></p>
      <div id="wizDetectionResults"></div>
    `;

    const resistanceEl = el.querySelector('#wizResistanceValue');
    const inductanceEl = el.querySelector('#wizInductanceValue');
    const statusEl = el.querySelector('#wizDetectionStatus');
    const runBtn = el.querySelector('#wizRunDetection');
    const maxPowerLossInput = el.querySelector('#wizMaxPowerLoss');
    const fullStatusEl = el.querySelector('#wizFullDetectionStatus');
    const runFullBtn = el.querySelector('#wizRunFullDetection');
    const motorSizeOptionsEl = el.querySelector('#wizMotorSizeOptions');

    const refreshRunFullEnabled = () => { runFullBtn.disabled = this.motorSize == null; };

    MOTOR_SIZES.forEach((size) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'wizard__option';
      card.dataset.active = String(this.motorSize === size.value);
      card.innerHTML = `
        <span class="wizard__option-label">${size.label}</span>
        <span class="wizard__option-desc">${size.desc}</span>
      `;
      card.addEventListener('click', () => {
        this.motorSize = size.value;
        motorSizeOptionsEl.querySelectorAll('.wizard__option').forEach((c) => {
          c.dataset.active = String(c === card);
        });
        maxPowerLossInput.value = size.maxPowerLoss;
        refreshRunFullEnabled();
      });
      motorSizeOptionsEl.appendChild(card);
    });
    refreshRunFullEnabled(); // starts disabled until a size is picked

    // Restore any prior measurement from this session
    if (this.motorRL) {
      resistanceEl.textContent = `${(this.motorRL.resistance * 1000).toFixed(2)} mΩ`;
      inductanceEl.textContent = `${this.motorRL.inductance.toFixed(2)} µH`;
    }
    if (this.fullDetectionResult) {
      fullStatusEl.textContent = this.fullDetectionResult.message;
      if (!this.fullDetectionResult.success) fullStatusEl.classList.add('wizard__text--warn');
    }

    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true;
      statusEl.textContent = 'Measuring… this takes a few seconds.';
      statusEl.classList.remove('wizard__text--warn');
      try {
        const result = await this.client.detectMotorRL();
        if (result.failed) {
          statusEl.textContent = 'Detection failed — check motor phase connections and try again.';
          statusEl.classList.add('wizard__text--warn');
        } else {
          this.motorRL = result;
          resistanceEl.textContent = `${(result.resistance * 1000).toFixed(2)} mΩ`;
          inductanceEl.textContent = `${result.inductance.toFixed(2)} µH`;
          statusEl.textContent = 'Done.';
        }
      } catch (err) {
        statusEl.textContent = `Detection error: ${err.message}`;
        statusEl.classList.add('wizard__text--warn');
      } finally {
        runBtn.disabled = false;
      }
    });

    const resultsEl = el.querySelector('#wizDetectionResults');
    if (this.detectionResultCards) resultsEl.innerHTML = this.detectionResultCards;

    runFullBtn.addEventListener('click', async () => {
      const maxPowerLoss = parseFloat(maxPowerLossInput.value);
      if (Number.isNaN(maxPowerLoss) || maxPowerLoss <= 0) {
        fullStatusEl.textContent = 'Enter a max power loss (W) greater than 0 first.';
        fullStatusEl.classList.add('wizard__text--warn');
        return;
      }
      runFullBtn.disabled = true;
      runBtn.disabled = true;
      fullStatusEl.classList.remove('wizard__text--warn');
      resultsEl.innerHTML = '';
      this.detectionResultCards = '';
      fullStatusEl.textContent = 'Running… the motor will spin briefly. This can take up to 30 seconds.';
      try {
        const result = await this.client.detectApplyAllFoc({ maxPowerLoss });
        this.fullDetectionResult = result;
        fullStatusEl.textContent = result.message;
        if (!result.success) fullStatusEl.classList.add('wizard__text--warn');

        // Firmware pushes the freshly-applied MCCONF a moment after the
        // ack on success — but we read it ourselves rather than relying
        // on that push arriving while this page has a listener attached.
        if (result.success) {
          fullStatusEl.textContent += ' Reading back the saved values…';
          await new Promise((r) => setTimeout(r, 1200));
          await this._renderDetectionResult(resultsEl, null, 'This VESC');
          if (this.client.targetCanId != null) {
            await this._renderDetectionResult(resultsEl, this.client.targetCanId, 'Linked VESC');
          }
          this.detectionResultCards = resultsEl.innerHTML;
          fullStatusEl.textContent = result.message;
        }
      } catch (err) {
        fullStatusEl.textContent = `Detection error: ${err.message}`;
        fullStatusEl.classList.add('wizard__text--warn');
      } finally {
        runFullBtn.disabled = false;
        runBtn.disabled = false;
      }
    });

    el.appendChild(this._buildFooter({ back: true, nextLabel: 'Continue' }));
    return el;
  }

  /**
   * Read back and render a "Detection Result" card mirroring VESC
   * Tool's own post-detection popup (VESC ID, motor current, R, L,
   * Lq-Ld, flux linkage, temp comp, sensors) — see
   * MCCONF_MOTOR_OFFSETS/parseMcConfMotorSummary in vesc-protocol.js
   * for what's trusted here. Sensors comes from this.fullDetectionResult
   * (the command's own result code), not from re-decoding MCCONF.
   * targetCanId null = the directly-connected board; a number reads
   * the linked motor over COMM_FORWARD_CAN, same as the Motor Config
   * page. Swallows read errors quietly — a failed readback shouldn't
   * make a successful detection look like it failed.
   */
  async _renderDetectionResult(container, targetCanId, label) {
    try {
      const raw = await this.client.requestMcConfRaw(targetCanId);
      const summary = parseMcConfMotorSummary(raw);
      if (!summary) return;

      let controllerId = null;
      if (targetCanId == null) {
        try {
          const appconfRaw = await this.client.readAppConf();
          controllerId = appconfRaw[APPCONF_OFFSETS.controllerId];
        } catch (_) { /* VESC ID is a nice-to-have, not critical */ }
      }

      const sensors = this.fullDetectionResult?.code === 2 ? 'AS5147/SPI encoder'
        : this.fullDetectionResult?.code === 1 ? 'Hall sensors'
        : this.fullDetectionResult?.code === 0 ? 'Sensorless'
        : 'Unknown (sensor detection failed)';

      const rows = [
        controllerId != null ? ['VESC ID', String(controllerId)] : null,
        ['Motor current', `${summary.currentMaxA.toFixed(2)} A`],
        ['Motor R', `${(summary.resistanceOhm * 1000).toFixed(2)} mΩ`],
        ['Motor L', `${(summary.inductanceH * 1e6).toFixed(2)} µH`],
        ['Motor Lq-Ld', `${(summary.ldLqDiffH * 1e6).toFixed(2)} µH`],
        ['Motor Flux Linkage', `${(summary.fluxLinkageWb * 1000).toFixed(2)} mWb`],
        ['Temp Comp', summary.tempComp ? 'True' : 'False'],
        ['Sensors', sensors],
      ].filter(Boolean);

      const card = document.createElement('div');
      card.className = 'wizard__result-card';
      card.innerHTML = `<div class="wizard__result-title">Detection result — ${label}</div>` +
        rows.map(([k, v]) => `<div class="wizard__result-row"><span>${k}</span><span>${v}</span></div>`).join('');
      container.appendChild(card);
    } catch (err) {
      console.warn('[vesc] Could not read back MCCONF for detection result display:', err.message);
    }
  }

  // ---------------- Step: Battery ----------------

  _stepBattery() {
    const el = document.createElement('div');
    el.innerHTML = `
      <h2 class="wizard__heading">Battery</h2>
      <p class="wizard__text">Pick your pack size below. "S" just means how many cells are
      wired in series — it's not a brand or a mystery spec, just a count.</p>
      <div class="wizard__options wizard__options--grid" id="wizBatteryOptions"></div>
      <div id="wizBatteryDetail"></div>
      <p class="wizard__text wizard__text--note">These voltage cutoffs are standard, safe
      lithium values for this pack size, not a rough percentage of pack voltage &mdash;
      3.3V/cell is where the VESC starts pulling power back, 3.0V/cell is where it cuts
      off completely, protecting the pack from being run dead.</p>
      <button class="btn btn--primary" id="wizBatteryApply" disabled>Apply</button>
      <p class="wizard__text wizard__text--note" id="wizBatteryStatus"></p>
    `;

    const optionsEl = el.querySelector('#wizBatteryOptions');
    const detailEl = el.querySelector('#wizBatteryDetail');
    const applyBtn = el.querySelector('#wizBatteryApply');
    const statusEl = el.querySelector('#wizBatteryStatus');

    const renderDetail = () => {
      if (this.batteryS == null) {
        detailEl.innerHTML = '';
        applyBtn.disabled = true;
        return;
      }
      const v = batteryVoltages(this.batteryS);
      detailEl.innerHTML = `
        <div class="wizard__result-card">
          <div class="wizard__result-title">${batteryComboLabel(this.batteryS)}</div>
          <div class="wizard__result-row"><span>Nominal voltage</span><span>${v.nominal.toFixed(1)} V</span></div>
          <div class="wizard__result-row"><span>Cutoff start (power tapers)</span><span>${v.cutStart.toFixed(1)} V</span></div>
          <div class="wizard__result-row"><span>Cutoff end (power off)</span><span>${v.cutEnd.toFixed(1)} V</span></div>
        </div>
      `;
      applyBtn.disabled = false;
    };

    for (let s = 5; s <= 20; s++) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'wizard__option';
      card.dataset.active = String(this.batteryS === s);
      card.innerHTML = `<span class="wizard__option-label">${batteryComboLabel(s)}</span>`;
      card.addEventListener('click', () => {
        this.batteryS = s;
        this.batteryWritten = false;
        optionsEl.querySelectorAll('.wizard__option').forEach((c) => { c.dataset.active = String(c === card); });
        renderDetail();
        statusEl.textContent = '';
        statusEl.classList.remove('wizard__text--warn');
      });
      optionsEl.appendChild(card);
    }
    renderDetail();

    applyBtn.addEventListener('click', async () => {
      if (this.batteryS == null) return;
      applyBtn.disabled = true;
      statusEl.textContent = 'Writing to VESC…';
      statusEl.classList.remove('wizard__text--warn');
      const v = batteryVoltages(this.batteryS);
      try {
        const result = await this.client.writeMcConfBothSides([
          { offset: MCCONF_OFFSETS.lMinVin, type: 'i16', value: v.minVin, scale: 10 },
          { offset: MCCONF_OFFSETS.lMaxVin, type: 'i16', value: v.maxVin, scale: 10 },
          { offset: MCCONF_OFFSETS.lBatteryCutStart, type: 'i16', value: v.cutStart, scale: 10 },
          { offset: MCCONF_OFFSETS.lBatteryCutEnd, type: 'i16', value: v.cutEnd, scale: 10 },
        ]);
        this.batteryWritten = true;
        if (result.linked === null) {
          statusEl.textContent = 'Saved. No linked motor is set up right now, so only this side was written.';
        } else if (result.linked) {
          statusEl.textContent = 'Saved to both motors.';
        } else {
          statusEl.textContent = `Saved to this motor, but the linked motor's write failed ` +
            `(${result.linkedError}). Check its connection and hit Apply again before finishing setup.`;
          statusEl.classList.add('wizard__text--warn');
        }
      } catch (err) {
        statusEl.textContent = `Write failed: ${err.message}. Nothing was changed — try again.`;
        statusEl.classList.add('wizard__text--warn');
      } finally {
        applyBtn.disabled = false;
      }
    });

    el.appendChild(this._buildFooter({ back: true, nextLabel: 'Continue' }));
    return el;
  }

  // ---------------- Step: Speed ----------------

  _stepSpeed() {
    const el = document.createElement('div');
    el.innerHTML = `
      <h2 class="wizard__heading">Speed</h2>
      <p class="wizard__text">Enter your tire diameter and confirm the gearing below — this
      is what lets the VESC know how fast the vehicle is actually going, so the speed limit
      slider means something real.</p>

      <div class="wizard__capture-row">
        <div class="wizard__capture">
          <span class="wizard__capture-label">Tire diameter (mm)</span>
          <input type="number" step="1" class="motor-target__input wizard__num-input" id="wizTireDiameter" />
        </div>
        <div class="wizard__capture">
          <span class="wizard__capture-label">Motor poles</span>
          <input type="number" step="1" class="motor-target__input wizard__num-input" id="wizMotorPoles" />
        </div>
      </div>

      <div class="wizard__capture-row">
        <div class="wizard__capture">
          <span class="wizard__capture-label">Motor pulley (teeth)</span>
          <select class="motor-target__input wizard__num-input" id="wizMotorPulley">
            <option value="">Select…</option>
            ${PULLEY_MOTOR_TEETH_OPTIONS.map((t) => `<option value="${t}">${t}T</option>`).join('')}
          </select>
        </div>
        <div class="wizard__capture">
          <span class="wizard__capture-label">Hub pulley (teeth)</span>
          <select class="motor-target__input wizard__num-input" id="wizHubPulley">
            <option value="">Select…</option>
            ${PULLEY_HUB_TEETH_OPTIONS.map((t) => `<option value="${t}">${t}T</option>`).join('')}
          </select>
        </div>
      </div>
      <p class="wizard__text wizard__text--note">Gear ratio: <span id="wizGearRatioValue">–</span>
      (hub teeth &divide; motor teeth).</p>
      <p class="wizard__text wizard__text--note" id="wizSpeedPrefillStatus">Reading current
      gearing/pole count from the VESC…</p>

      <div id="wizSpeedControls" style="display:none;">
        <div class="wizard__speedo-wrap">
          <svg id="wizSpeedoSvg" class="wizard__speedo" viewBox="0 0 200 120" aria-hidden="true">
            <path d="M 15 105 A 85 85 0 0 1 185 105" fill="none" stroke="var(--card-strong)" stroke-width="14" stroke-linecap="round"></path>
            <path id="wizSpeedoArc" d="M 15 105 A 85 85 0 0 1 185 105" fill="none" stroke="var(--amber)" stroke-width="14" stroke-linecap="round" stroke-dasharray="0 267"></path>
            <line id="wizSpeedoNeedle" x1="100" y1="105" x2="100" y2="30" stroke="var(--red)" stroke-width="3" stroke-linecap="round"></line>
            <circle cx="100" cy="105" r="6" fill="var(--red)"></circle>
          </svg>
          <div class="wizard__speedo-value"><span id="wizSpeedoLabel">0</span> mph top speed</div>
        </div>

        <input type="range" min="1" max="30" step="0.5" value="10" id="wizSpeedSlider" class="wizard__slider" />
        <p class="wizard__text wizard__text--note">This sets the top forward speed the VESC
        will allow (<span id="wizSpeedErpm">–</span> ERPM at the current gearing/tire size).
        Reverse is limited to the same speed, mirrored.</p>
      </div>

      <button class="btn btn--primary" id="wizSpeedApply" disabled>Finish setup</button>
      <p class="wizard__text wizard__text--note" id="wizSpeedStatus"></p>
    `;

    const tireInput = el.querySelector('#wizTireDiameter');
    const motorPulleySelect = el.querySelector('#wizMotorPulley');
    const hubPulleySelect = el.querySelector('#wizHubPulley');
    const gearRatioValueEl = el.querySelector('#wizGearRatioValue');
    const polesInput = el.querySelector('#wizMotorPoles');
    const prefillStatusEl = el.querySelector('#wizSpeedPrefillStatus');
    const controlsEl = el.querySelector('#wizSpeedControls');
    const slider = el.querySelector('#wizSpeedSlider');
    const speedoLabel = el.querySelector('#wizSpeedoLabel');
    const speedoNeedle = el.querySelector('#wizSpeedoNeedle');
    const speedoArc = el.querySelector('#wizSpeedoArc');
    const SPEEDO_ARC_LEN = Math.PI * 85; // matches the SVG path's r=85 semicircle
    const erpmEl = el.querySelector('#wizSpeedErpm');
    const applyBtn = el.querySelector('#wizSpeedApply');
    const statusEl = el.querySelector('#wizSpeedStatus');

    if (this.wheelDiameterMm != null) tireInput.value = this.wheelDiameterMm;
    if (this.motorPulleyTeeth != null) motorPulleySelect.value = String(this.motorPulleyTeeth);
    if (this.hubPulleyTeeth != null) hubPulleySelect.value = String(this.hubPulleyTeeth);
    if (this.motorPoles != null) polesInput.value = this.motorPoles;

    const canCompute = () => {
      const d = parseFloat(tireInput.value);
      const g = this.gearRatio;
      const p = parseFloat(polesInput.value);
      return !Number.isNaN(d) && d > 0 && !Number.isNaN(g) && g > 0 && !Number.isNaN(p) && p > 0;
    };

    const updatePulleyRatio = () => {
      const motorTeeth = parseInt(motorPulleySelect.value, 10);
      const hubTeeth = parseInt(hubPulleySelect.value, 10);
      this.motorPulleyTeeth = Number.isNaN(motorTeeth) ? null : motorTeeth;
      this.hubPulleyTeeth = Number.isNaN(hubTeeth) ? null : hubTeeth;
      this.gearRatio = pulleyGearRatio(this.motorPulleyTeeth, this.hubPulleyTeeth);
      gearRatioValueEl.textContent = this.gearRatio != null ? this.gearRatio.toFixed(2) : '–';
    };

    const updateSpeedo = () => {
      if (!canCompute()) { controlsEl.style.display = 'none'; applyBtn.disabled = true; return; }
      controlsEl.style.display = '';
      applyBtn.disabled = false;
      this.wheelDiameterMm = parseFloat(tireInput.value);
      this.motorPoles = parseFloat(polesInput.value);
      this.speedLimitMph = parseFloat(slider.value);

      const mps = this.speedLimitMph / MPS_TO_MPH;
      const erpm = mpsToErpm(mps, this.motorPoles, this.gearRatio, this.wheelDiameterMm / 1000);
      erpmEl.textContent = Math.round(erpm).toLocaleString();
      speedoLabel.textContent = this.speedLimitMph.toFixed(1);

      // Needle + fill arc sweep 0-30 mph across a 180deg arc (pointing
      // left at 0, right at max).
      const frac = Math.max(0, Math.min(1, this.speedLimitMph / 30));
      speedoArc.setAttribute('stroke-dasharray', `${frac * SPEEDO_ARC_LEN} ${SPEEDO_ARC_LEN}`);
      const angleDeg = 180 * frac; // 0deg = pointing left, 180deg = pointing right
      const rad = (angleDeg * Math.PI) / 180;
      const cx = 100, cy = 105, len = 75;
      const x2 = cx - len * Math.cos(rad);
      const y2 = cy - len * Math.sin(rad);
      speedoNeedle.setAttribute('x1', String(cx));
      speedoNeedle.setAttribute('y1', String(cy));
      speedoNeedle.setAttribute('x2', String(x2));
      speedoNeedle.setAttribute('y2', String(y2));
    };

    [tireInput, polesInput].forEach((input) => {
      input.addEventListener('input', () => { this.speedWritten = false; updateSpeedo(); });
    });
    [motorPulleySelect, hubPulleySelect].forEach((select) => {
      select.addEventListener('change', () => { this.speedWritten = false; updatePulleyRatio(); updateSpeedo(); });
    });
    slider.addEventListener('input', () => { this.speedWritten = false; updateSpeedo(); });

    if (this.speedLimitMph != null) slider.value = String(this.speedLimitMph);
    updatePulleyRatio();

    // Prefill pole count from a live read rather than asking the
    // person to guess a mechanical spec blind — but only if they
    // haven't already typed/edited a value this session. Gear ratio
    // doesn't get a direct prefill anymore since it's derived from the
    // pulley dropdowns above; instead, find the closest matching
    // pulley pair to whatever ratio is already on the board and
    // preselect that, clearly marked as an approximation (there's no
    // exact inverse from a single ratio number back to two teeth
    // counts, and the board may not have even been set up with these
    // pulleys before).
    (async () => {
      try {
        const raw = await this.client.requestMcConfRaw(null);
        const setup = parseMcConfSetupFields(raw);
        if (setup) {
          if (this.motorPulleyTeeth == null && this.hubPulleyTeeth == null && setup.gearRatio > 0) {
            const approx = closestPulleyPair(setup.gearRatio);
            if (approx) {
              motorPulleySelect.value = String(approx.motorTeeth);
              hubPulleySelect.value = String(approx.hubTeeth);
              updatePulleyRatio();
            }
          }
          if (this.motorPoles == null && setup.motorPoles > 0) {
            this.motorPoles = setup.motorPoles;
            polesInput.value = setup.motorPoles;
          }
          prefillStatusEl.textContent = 'Pole count read from the VESC; pulley selection ' +
            'approximated from the current gear ratio — double-check both match your actual ' +
            'build, then adjust if not.';
        } else {
          prefillStatusEl.textContent = 'Could not read current gearing/pole count — enter them manually.';
        }
      } catch (err) {
        prefillStatusEl.textContent = `Could not read current gearing/pole count (${err.message}) — enter them manually.`;
      }
      updateSpeedo();
    })();

    applyBtn.addEventListener('click', async () => {
      if (!canCompute()) return;
      applyBtn.disabled = true;
      statusEl.textContent = 'Writing final config to VESC…';
      statusEl.classList.remove('wizard__text--warn');
      try {
        const mps = this.speedLimitMph / MPS_TO_MPH;
        const maxErpm = mpsToErpm(mps, this.motorPoles, this.gearRatio, this.wheelDiameterMm / 1000);
        const result = await this.client.writeMcConfBothSides([
          { offset: MCCONF_OFFSETS.siWheelDiameter, type: 'f32', value: this.wheelDiameterMm / 1000 },
          { offset: MCCONF_OFFSETS.siGearRatio, type: 'f32', value: this.gearRatio },
          { offset: MCCONF_OFFSETS.siMotorPoles, type: 'u8', value: this.motorPoles },
          { offset: MCCONF_OFFSETS.lMaxErpm, type: 'f32', value: maxErpm },
          { offset: MCCONF_OFFSETS.lMinErpm, type: 'f32', value: -maxErpm },
        ]);
        this.speedWritten = true;
        if (result.linked === null) {
          statusEl.textContent = 'Saved. No linked motor is set up right now, so only this side was written.';
        } else if (result.linked) {
          statusEl.textContent = 'Saved to both motors.';
        } else {
          statusEl.textContent = `Saved to this motor, but the linked motor's write failed ` +
            `(${result.linkedError}). Check its connection and hit Finish setup again.`;
          statusEl.classList.add('wizard__text--warn');
        }
        if (this.speedWritten) this._next();
      } catch (err) {
        statusEl.textContent = `Write failed: ${err.message}. Nothing was changed — try again.`;
        statusEl.classList.add('wizard__text--warn');
      } finally {
        applyBtn.disabled = false;
      }
    });

    el.appendChild(this._buildFooter({ back: true, nextLabel: 'Skip for now' }));
    return el;
  }

  // ---------------- Step: Done ----------------

  _stepDone() {
    const el = document.createElement('div');
    el.innerHTML = `
      <img class="wizard__mascot brand-blend" src="assets/mascot-banana.png" alt="" />
      <h2 class="wizard__heading">Setup complete</h2>
      <p class="wizard__text">Your pedal range, center, and control type are written to
      the VESC. If you ran full motor detection, your motor's resistance, inductance, flux
      linkage, and sensor mode are saved too. ${this.batteryWritten
        ? 'Battery cutoffs are saved.'
        : 'Battery cutoffs were not saved — go back if you meant to set them.'}
      ${this.speedWritten
        ? 'Your speed limit and gearing are saved.'
        : 'Speed limit/gearing were not saved — go back if you meant to set them.'}
      All of these are real, permanent writes, not a preview.</p>
    `;
    const footer = document.createElement('div');
    footer.className = 'wizard__footer';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn--primary';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', () => this.close());
    footer.appendChild(closeBtn);
    el.appendChild(footer);
    return el;
  }

  // ---------------- Small helper ----------------

  _buildNote(text) {
    const p = document.createElement('p');
    p.className = 'wizard__text wizard__text--note';
    p.textContent = text;
    return p;
  }

  // ---------------- Shared footer ----------------

  _buildFooter({ back, nextLabel, nextEnabled }) {
    const footer = document.createElement('div');
    footer.className = 'wizard__footer';

    if (back) {
      const backBtn = document.createElement('button');
      backBtn.className = 'btn btn--secondary';
      backBtn.textContent = 'Back';
      backBtn.addEventListener('click', () => this._back());
      footer.appendChild(backBtn);
    }

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn--secondary';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => this.close());
    footer.appendChild(cancelBtn);

    const nextBtn = document.createElement('button');
    nextBtn.className = 'btn btn--primary';
    nextBtn.textContent = nextLabel;
    nextBtn.addEventListener('click', () => this._next());
    footer.appendChild(nextBtn);

    if (nextEnabled) {
      const refresh = () => { nextBtn.disabled = !nextEnabled(); };
      refresh();
      // Exposed so a step's own controls (capture buttons, option picks —
      // anything outside this footer) can re-check the enabled state
      // right when they change it, instead of guessing when to poll.
      footer.refreshNext = refresh;
    }

    return footer;
  }
}
