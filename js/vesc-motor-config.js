/**
 * vesc-motor-config.js
 * ------------------------------------------------------------------
 * Standalone "Motor config" page. Toggle between "This VESC" and
 * "Linked VESC" to read or view either motor's config individually,
 * with Read, Compare (side-by-side, mismatches highlighted), and a
 * single "Write to both VESCs" button that pushes the form on screen
 * to both controllers — direct write to this VESC, then a
 * CAN-forwarded write to the linked VESC (auto-detected, never a
 * typed-in ID) — done as two writes behind the scenes under one click.
 *
 * Scope: this page only reads/writes/compares the specific MCCONF
 * fields listed below (current limits, battery cutoffs, speed/gearing,
 * duty cycle, and a few fixed-behind-the-scenes safety fields) — NOT
 * a full MCCONF editor. It deliberately never touches per-motor
 * detection results (resistance, inductance, flux linkage, hall
 * table, FOC tuning) — those live on the wizard's motor-detection step
 * and are NOT part of what "Write to both VESCs" writes, specifically
 * so writing doesn't push one motor's physical characteristics onto
 * the other motor.
 *
 * IMPORTANT — read before treating this as safe to ship on a real
 * customer kit: the MCCONF byte offsets this page writes to
 * (MCCONF_OFFSETS in vesc-protocol.js) are mechanically derived from
 * firmware source (walking confgenerator_serialize_mcconf's field
 * order byte-by-byte), not confirmed against a real hardware capture
 * the way every APPCONF offset is. A wrong offset here doesn't just
 * show a wrong number, it corrupts real bytes of a customer's motor
 * config on flash. See the big comment on MCCONF_OFFSETS and the
 * README's "Known gaps" before trusting this on a real kit.
 * ------------------------------------------------------------------
 */

import {
  MCCONF_OFFSETS, parseMcConfConfigFields, batteryComboLabel, batteryVoltages,
  mpsToErpm, erpmToMps,
} from './vesc-protocol.js';

const MPS_TO_MPH = 2.2369362921;

// Fixed, non-editable safety values this page writes behind the
// scenes on every write, per Scott's explicit spec — never exposed as
// form fields, never sourced from a live read.
const ABS_CURRENT_MAX_A = 150;
const TEMP_CUTOFF_C = 80;       // l_temp_fet_start / l_temp_motor_start — where limp mode begins
const TEMP_ACCEL_DEC_FRAC = 0.15; // l_temp_accel_dec

const DEFAULTS = () => ({
  motorCurrentMax: 65,
  maxBatteryCurrent: 35,
  motorCurrentMaxBrake: 45,
  batteryCurrentMaxRegen: -4,
  batteryS: null,
  wheelDiameterMm: null,
  gearRatio: null,
  motorPoles: null,
  speedLimitMph: 10,
  reverseErpm: -2500,
  erpmLimitStartPct: 95,
  dutyCycleMaxPct: 95,
});

export class MotorConfigPage {
  constructor(root, client) {
    this.root = root;
    this.client = client;
    this.onClose = null;
    this.linkedCanId = null; // remembers what was typed in, session-only
    this.activeSide = 'this'; // 'this' | 'linked'
    // Per-side form state — switching sides does NOT carry values over;
    // each side keeps its own (starting from DEFAULTS until read/edited).
    this.sideForms = { this: DEFAULTS(), linked: DEFAULTS() };
    this.sideReadAt = { this: null, linked: null }; // has this side ever been read this session?
  }

  open() {
    this.root.hidden = false;
    this._render();
  }

  close() {
    this.root.hidden = true;
    this.root.innerHTML = '';
    if (this.onClose) this.onClose();
  }

  _targetCanId(side) {
    return side === 'linked' ? this.linkedCanId : null;
  }

  /**
   * Get the linked VESC's CAN ID, auto-detecting via COMM_PING_CAN if
   * it isn't already cached this session — no manual CAN ID entry
   * anywhere in this app, since a person mistyping or misremembering
   * an ID is exactly the kind of mistake that ends with the wrong
   * motor getting written to. Caches the result on this.linkedCanId
   * so repeated actions (Read, then Write, then Compare) don't rescan
   * every time. Returns null if the scan finds nothing.
   */
  async _ensureLinkedCanId(statusEl) {
    if (this.linkedCanId != null) return this.linkedCanId;
    statusEl.textContent = 'Looking for a linked VESC on the CAN bus…';
    statusEl.classList.remove('wizard__text--warn');
    try {
      const id = await this.client.detectLinkedCanId();
      if (id == null) {
        statusEl.textContent = 'No linked VESC found on the CAN bus. Check the CAN wiring between the two controllers.';
        statusEl.classList.add('wizard__text--warn');
        return null;
      }
      this.linkedCanId = id;
      statusEl.textContent = `Found linked VESC (CAN ID ${id}).`;
      return id;
    } catch (err) {
      statusEl.textContent = `CAN scan failed: ${err.message}`;
      statusEl.classList.add('wizard__text--warn');
      return null;
    }
  }

  // ---------------- Render ----------------

  _render() {
    this.root.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'wizard';
    wrap.style.maxWidth = '760px';

    const head = document.createElement('div');
    head.className = 'wizard__head';
    head.innerHTML = `<span class="wizard__title">Motor config</span>`;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn--secondary btn--small';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', () => this.close());
    head.appendChild(closeBtn);
    wrap.appendChild(head);

    const body = document.createElement('div');
    body.className = 'wizard__body';
    body.innerHTML = `
      <div class="wizard__warning" style="margin-bottom:18px;">
        <span class="wizard__warning-badge">Per-side values</span>
        <p class="wizard__text" style="margin:0;">Every current/power value on this page is
        for <strong>this one motor</strong>, not the vehicle total. Example: Max Battery
        Current of 35A means your battery must supply at least 70A combined on a dual-motor
        board &mdash; 35A per side, not 35A total.</p>
      </div>

      <div class="motor-config__toggle" id="mcSideToggle">
        <button type="button" class="btn" id="mcSideThis">This VESC</button>
        <button type="button" class="btn" id="mcSideLinked">Linked VESC</button>
      </div>

      <div class="motor-config__actions" id="mcActions">
        <button class="btn btn--secondary" id="mcRead">Read config</button>
        <button class="btn btn--secondary" id="mcCompare">Compare sides</button>
        <button class="btn btn--primary" id="mcWrite">Write to both VESCs</button>
      </div>
      <p class="wizard__text wizard__text--note">Write always pushes what's shown below to
      <strong>both</strong> controllers &mdash; this VESC directly, and the linked VESC over CAN
      (auto-detected, no ID to enter). It's two writes done behind the scenes; you only press
      one button.</p>
      <p class="wizard__text wizard__text--note" id="mcStatus"></p>

      <div id="mcCompareResults"></div>
      <div id="mcForm"></div>
    `;
    wrap.appendChild(body);
    this.root.appendChild(wrap);

    const sideThisBtn = body.querySelector('#mcSideThis');
    const sideLinkedBtn = body.querySelector('#mcSideLinked');
    const statusEl = body.querySelector('#mcStatus');
    const formEl = body.querySelector('#mcForm');
    const compareEl = body.querySelector('#mcCompareResults');

    const refreshToggle = () => {
      sideThisBtn.dataset.active = String(this.activeSide === 'this');
      sideLinkedBtn.dataset.active = String(this.activeSide === 'linked');
    };
    refreshToggle();

    sideThisBtn.addEventListener('click', () => {
      this.activeSide = 'this';
      refreshToggle();
      statusEl.textContent = '';
      statusEl.classList.remove('wizard__text--warn');
      this._renderForm(formEl, statusEl);
    });
    sideLinkedBtn.addEventListener('click', async () => {
      this.activeSide = 'linked';
      refreshToggle();
      statusEl.textContent = '';
      statusEl.classList.remove('wizard__text--warn');
      this._renderForm(formEl, statusEl);
      // Auto-detect as soon as this side is picked, rather than waiting
      // for Read/Write/Copy to discover there's no ID yet — gives an
      // early, clear "nothing found" instead of a confusing failure
      // three clicks later.
      await this._ensureLinkedCanId(statusEl);
    });

    body.querySelector('#mcRead').addEventListener('click', () => this._doRead(formEl, statusEl));
    body.querySelector('#mcWrite').addEventListener('click', () => this._doWrite(statusEl));
    body.querySelector('#mcCompare').addEventListener('click', () => this._doCompare(compareEl, statusEl));

    this._renderForm(formEl, statusEl);
  }

  // ---------------- Form (per active side) ----------------

  _renderForm(formEl, statusEl) {
    const f = this.sideForms[this.activeSide];
    const wasRead = this.sideReadAt[this.activeSide] != null;

    formEl.innerHTML = `
      <p class="wizard__text wizard__text--note">${wasRead
        ? 'Showing values read from the VESC — edit and Write to change them.'
        : 'Showing recommended defaults — hit "Read config" to pull this VESC\'s actual current settings instead.'}</p>

      <h3 class="wizard__heading" style="font-size:1rem;">Current limits</h3>

      <div class="wizard__capture">
        <span class="wizard__capture-label">Motor Current Max (A)</span>
        <input type="number" step="1" class="motor-target__input wizard__num-input" id="mcMotorCurrentMax" />
        <p class="wizard__text wizard__text--note">Also known as Phase Amps. This is the
        current that gives you low-end torque. This value cannot exceed 2x your battery's
        output current. Safe max limits are 80A for 6374 motors, and 90A for 7070 motors.</p>
      </div>

      <div class="wizard__capture">
        <span class="wizard__capture-label">Absolute Max Current</span>
        <span class="wizard__capture-value wizard__capture-value--fixed">${ABS_CURRENT_MAX_A} A</span>
        <p class="wizard__text wizard__text--note">Hard safety ceiling, written behind the
        scenes on every write.</p>
      </div>

      <div class="wizard__capture">
        <span class="wizard__capture-label">Max Battery Current (A)</span>
        <input type="number" step="1" class="motor-target__input wizard__num-input" id="mcMaxBatteryCurrent" />
        <p class="wizard__text wizard__text--note">Max continuous output your battery is
        rated for. Cannot be less than half of Motor Current Max above. This is per side,
        same as everything else on this page &mdash; a dual-motor board needs your battery to
        supply at least 2x whatever you set here.</p>
      </div>

      <div class="wizard__capture">
        <span class="wizard__capture-label">Motor Current Max Brake (A)</span>
        <input type="number" step="1" class="motor-target__input wizard__num-input" id="mcMotorCurrentMaxBrake" />
        <p class="wizard__text wizard__text--note">Max braking force allowed by the motor.</p>
      </div>

      <div class="wizard__capture">
        <span class="wizard__capture-label">Battery Current Max Regen (A)</span>
        <input type="number" step="1" class="motor-target__input wizard__num-input" id="mcBatteryCurrentMaxRegen" />
        <p class="wizard__text wizard__text--note">Max regenerative braking current allowed.
        Typically 0 to -5 is safe if your battery's regen capacity is unknown. This value also
        controls braking force for standard Power Wheels-style (foot-off-pedal) braking &mdash;
        recommend -3 to -5 for this style: -5 is aggressive braking, -3 is softer. Regen
        braking is NOT linear &mdash; the faster the motor spins, the more "bite" the brakes
        will have at that higher speed.</p>
      </div>

      <h3 class="wizard__heading" style="font-size:1rem;">Battery</h3>
      <div class="wizard__capture">
        <span class="wizard__capture-label">Pack size</span>
        <select class="motor-target__input wizard__num-input" id="mcBatteryS">
          <option value="">Select a pack size…</option>
          ${Array.from({ length: 16 }, (_, i) => i + 5).map((s) =>
            `<option value="${s}">${batteryComboLabel(s)}</option>`).join('')}
        </select>
        <div id="mcBatteryDetail"></div>
      </div>

      <h3 class="wizard__heading" style="font-size:1rem;">Speed</h3>

      <div class="wizard__capture-row">
        <div class="wizard__capture">
          <span class="wizard__capture-label">Tire diameter (mm)</span>
          <input type="number" step="1" class="motor-target__input wizard__num-input" id="mcTireDiameter" />
        </div>
        <div class="wizard__capture">
          <span class="wizard__capture-label">Gear ratio</span>
          <input type="number" step="0.01" class="motor-target__input wizard__num-input" id="mcGearRatio" />
        </div>
        <div class="wizard__capture">
          <span class="wizard__capture-label">Motor poles</span>
          <input type="number" step="1" class="motor-target__input wizard__num-input" id="mcMotorPoles" />
        </div>
      </div>

      <div class="wizard__speedo-wrap">
        <svg id="mcSpeedoSvg" class="wizard__speedo" viewBox="0 0 200 120" aria-hidden="true">
          <path d="M 15 105 A 85 85 0 0 1 185 105" fill="none" stroke="var(--card-strong)" stroke-width="14" stroke-linecap="round"></path>
          <path id="mcSpeedoArc" d="M 15 105 A 85 85 0 0 1 185 105" fill="none" stroke="var(--amber)" stroke-width="14" stroke-linecap="round" stroke-dasharray="0 267"></path>
          <line id="mcSpeedoNeedle" x1="100" y1="105" x2="100" y2="30" stroke="var(--red)" stroke-width="3" stroke-linecap="round"></line>
          <circle cx="100" cy="105" r="6" fill="var(--red)"></circle>
        </svg>
        <div class="wizard__speedo-value"><span id="mcSpeedoLabel">0</span> mph top speed</div>
      </div>
      <input type="range" min="1" max="30" step="0.5" id="mcSpeedSlider" class="wizard__slider" />
      <p class="wizard__text wizard__text--note">Forward top speed limit (<span id="mcSpeedErpm">–</span> ERPM at the current gearing/tire size).</p>

      <div class="wizard__capture">
        <span class="wizard__capture-label">Reverse speed limit (ERPM)</span>
        <input type="number" step="100" min="-5000" max="0" class="motor-target__input wizard__num-input" id="mcReverseErpm" />
        <p class="wizard__text wizard__text--note">Reverse top speed limit, in ERPM. Capped
        at -5000 to keep reverse slow and controllable.</p>
      </div>

      <div class="wizard__capture">
        <span class="wizard__capture-label">ERPM limit start (%)</span>
        <input type="number" step="1" min="50" max="99" class="motor-target__input wizard__num-input" id="mcErpmStart" />
        <p class="wizard__text wizard__text--note">ERPM limit is when the speed cap begins to
        gradually apply, until max is reached. Example: 80% provides a slow regression of
        speed until it hits 100%. 99% is more abrupt as you hit the ceiling.</p>
      </div>

      <h3 class="wizard__heading" style="font-size:1rem;">Duty cycle</h3>
      <div class="wizard__capture">
        <span class="wizard__capture-label">Duty Cycle Max (%)</span>
        <input type="number" step="1" min="0" max="100" class="motor-target__input wizard__num-input" id="mcDutyMax" />
        <p class="wizard__text wizard__text--note">100% is full available speed allowed by
        battery voltage.</p>
      </div>

      <h3 class="wizard__heading" style="font-size:1rem;">Temperature protection</h3>
      <div class="wizard__capture">
        <span class="wizard__capture-label">Motor / MOSFET temp cutoff</span>
        <span class="wizard__capture-value wizard__capture-value--fixed">${TEMP_CUTOFF_C}&deg;C</span>
        <p class="wizard__text wizard__text--note">Max allowed temperature for VESC and motor
        before going into reduced-power "Limp Mode."</p>
      </div>
      <div class="wizard__capture">
        <span class="wizard__capture-label">Acceleration temp decrease</span>
        <span class="wizard__capture-value wizard__capture-value--fixed">${Math.round(TEMP_ACCEL_DEC_FRAC * 100)}%</span>
        <p class="wizard__text wizard__text--note">Temperature protection cutoff is lowered by
        15% during hard acceleration, for extra protection from thermal damage.</p>
      </div>
    `;

    // ---- wire fields to state ----
    const motorCurrentMaxInput = formEl.querySelector('#mcMotorCurrentMax');
    const maxBatteryCurrentInput = formEl.querySelector('#mcMaxBatteryCurrent');
    const motorCurrentMaxBrakeInput = formEl.querySelector('#mcMotorCurrentMaxBrake');
    const batteryCurrentMaxRegenInput = formEl.querySelector('#mcBatteryCurrentMaxRegen');
    const batterySSelect = formEl.querySelector('#mcBatteryS');
    const batteryDetailEl = formEl.querySelector('#mcBatteryDetail');
    const tireInput = formEl.querySelector('#mcTireDiameter');
    const gearInput = formEl.querySelector('#mcGearRatio');
    const polesInput = formEl.querySelector('#mcMotorPoles');
    const slider = formEl.querySelector('#mcSpeedSlider');
    const speedoLabel = formEl.querySelector('#mcSpeedoLabel');
    const speedoNeedle = formEl.querySelector('#mcSpeedoNeedle');
    const speedoArc = formEl.querySelector('#mcSpeedoArc');
    const speedErpmEl = formEl.querySelector('#mcSpeedErpm');
    const reverseErpmInput = formEl.querySelector('#mcReverseErpm');
    const erpmStartInput = formEl.querySelector('#mcErpmStart');
    const dutyMaxInput = formEl.querySelector('#mcDutyMax');
    const SPEEDO_ARC_LEN = Math.PI * 85;

    motorCurrentMaxInput.value = f.motorCurrentMax;
    maxBatteryCurrentInput.value = f.maxBatteryCurrent;
    motorCurrentMaxBrakeInput.value = f.motorCurrentMaxBrake;
    batteryCurrentMaxRegenInput.value = f.batteryCurrentMaxRegen;
    batterySSelect.value = f.batteryS != null ? String(f.batteryS) : '';
    if (f.wheelDiameterMm != null) tireInput.value = f.wheelDiameterMm;
    if (f.gearRatio != null) gearInput.value = f.gearRatio;
    if (f.motorPoles != null) polesInput.value = f.motorPoles;
    reverseErpmInput.value = f.reverseErpm;
    erpmStartInput.value = f.erpmLimitStartPct;
    dutyMaxInput.value = f.dutyCycleMaxPct;
    slider.value = String(f.speedLimitMph);

    motorCurrentMaxInput.addEventListener('input', () => { f.motorCurrentMax = parseFloat(motorCurrentMaxInput.value); });
    maxBatteryCurrentInput.addEventListener('input', () => { f.maxBatteryCurrent = parseFloat(maxBatteryCurrentInput.value); });
    motorCurrentMaxBrakeInput.addEventListener('input', () => { f.motorCurrentMaxBrake = parseFloat(motorCurrentMaxBrakeInput.value); });
    batteryCurrentMaxRegenInput.addEventListener('input', () => { f.batteryCurrentMaxRegen = parseFloat(batteryCurrentMaxRegenInput.value); });
    reverseErpmInput.addEventListener('input', () => { f.reverseErpm = parseFloat(reverseErpmInput.value); });
    erpmStartInput.addEventListener('input', () => { f.erpmLimitStartPct = parseFloat(erpmStartInput.value); });
    dutyMaxInput.addEventListener('input', () => { f.dutyCycleMaxPct = parseFloat(dutyMaxInput.value); });

    const renderBatteryDetail = () => {
      if (f.batteryS == null) { batteryDetailEl.innerHTML = ''; return; }
      const v = batteryVoltages(f.batteryS);
      batteryDetailEl.innerHTML = `
        <div class="wizard__result-card" style="margin-top:10px;">
          <div class="wizard__result-row"><span>Nominal voltage</span><span>${v.nominal.toFixed(1)} V</span></div>
          <div class="wizard__result-row"><span>Cutoff start</span><span>${v.cutStart.toFixed(1)} V</span></div>
          <div class="wizard__result-row"><span>Cutoff end</span><span>${v.cutEnd.toFixed(1)} V</span></div>
        </div>
      `;
    };
    batterySSelect.addEventListener('change', () => {
      const v = parseInt(batterySSelect.value, 10);
      f.batteryS = Number.isNaN(v) ? null : v;
      renderBatteryDetail();
    });
    renderBatteryDetail();

    const updateSpeedo = () => {
      const d = parseFloat(tireInput.value);
      const g = parseFloat(gearInput.value);
      const p = parseFloat(polesInput.value);
      f.wheelDiameterMm = Number.isNaN(d) ? null : d;
      f.gearRatio = Number.isNaN(g) ? null : g;
      f.motorPoles = Number.isNaN(p) ? null : p;
      f.speedLimitMph = parseFloat(slider.value);

      if (!f.wheelDiameterMm || !f.gearRatio || !f.motorPoles) {
        speedErpmEl.textContent = '–';
        speedoLabel.textContent = f.speedLimitMph.toFixed(1);
        speedoArc.setAttribute('stroke-dasharray', '0 267');
        return;
      }
      const mps = f.speedLimitMph / MPS_TO_MPH;
      const erpm = mpsToErpm(mps, f.motorPoles, f.gearRatio, f.wheelDiameterMm / 1000);
      speedErpmEl.textContent = Math.round(erpm).toLocaleString();
      speedoLabel.textContent = f.speedLimitMph.toFixed(1);

      const frac = Math.max(0, Math.min(1, f.speedLimitMph / 30));
      speedoArc.setAttribute('stroke-dasharray', `${frac * SPEEDO_ARC_LEN} ${SPEEDO_ARC_LEN}`);
      const angleDeg = 180 * frac;
      const rad = (angleDeg * Math.PI) / 180;
      const cx = 100, cy = 105, len = 75;
      speedoNeedle.setAttribute('x1', String(cx));
      speedoNeedle.setAttribute('y1', String(cy));
      speedoNeedle.setAttribute('x2', String(cx - len * Math.cos(rad)));
      speedoNeedle.setAttribute('y2', String(cy - len * Math.sin(rad)));
    };
    [tireInput, gearInput, polesInput, slider].forEach((el) => el.addEventListener('input', updateSpeedo));
    updateSpeedo();
  }

  // ---------------- Validate current side's form before writing ----------------

  _validate(side) {
    const f = this.sideForms[side];
    const errors = [];
    if (Number.isNaN(f.motorCurrentMax) || f.motorCurrentMax <= 0) errors.push('Enter a Motor Current Max.');
    if (Number.isNaN(f.maxBatteryCurrent) || f.maxBatteryCurrent <= 0) errors.push('Enter a Max Battery Current.');
    if (!errors.length && f.maxBatteryCurrent < f.motorCurrentMax / 2) {
      errors.push('Max Battery Current cannot be less than half of Motor Current Max.');
    }
    if (Number.isNaN(f.motorCurrentMaxBrake) || f.motorCurrentMaxBrake <= 0) errors.push('Enter a Motor Current Max Brake.');
    if (Number.isNaN(f.batteryCurrentMaxRegen) || f.batteryCurrentMaxRegen > 0) errors.push('Battery Current Max Regen must be zero or negative.');
    if (f.batteryS == null) errors.push('Select a battery pack size.');
    if (!f.wheelDiameterMm || f.wheelDiameterMm <= 0) errors.push('Enter a tire diameter.');
    if (!f.gearRatio || f.gearRatio <= 0) errors.push('Enter a gear ratio.');
    if (!f.motorPoles || f.motorPoles <= 0) errors.push('Enter a motor pole count.');
    if (Number.isNaN(f.reverseErpm) || f.reverseErpm > 0 || f.reverseErpm < -5000) {
      errors.push('Reverse speed limit must be between -5000 and 0 ERPM.');
    }
    if (Number.isNaN(f.erpmLimitStartPct) || f.erpmLimitStartPct < 50 || f.erpmLimitStartPct > 99) {
      errors.push('ERPM limit start must be between 50% and 99%.');
    }
    if (Number.isNaN(f.dutyCycleMaxPct) || f.dutyCycleMaxPct <= 0 || f.dutyCycleMaxPct > 100) {
      errors.push('Duty Cycle Max must be between 0% and 100%.');
    }
    return errors;
  }

  _buildPatches(side) {
    const f = this.sideForms[side];
    const v = batteryVoltages(f.batteryS);
    const mps = f.speedLimitMph / MPS_TO_MPH;
    const maxErpm = mpsToErpm(mps, f.motorPoles, f.gearRatio, f.wheelDiameterMm / 1000);
    return [
      { offset: MCCONF_OFFSETS.lCurrentMax, type: 'f32', value: f.motorCurrentMax },
      { offset: MCCONF_OFFSETS.lCurrentMin, type: 'f32', value: -Math.abs(f.motorCurrentMaxBrake) },
      { offset: MCCONF_OFFSETS.lInCurrentMax, type: 'f32', value: f.maxBatteryCurrent },
      { offset: MCCONF_OFFSETS.lInCurrentMin, type: 'f32', value: f.batteryCurrentMaxRegen },
      { offset: MCCONF_OFFSETS.lAbsCurrentMax, type: 'f32', value: ABS_CURRENT_MAX_A },
      { offset: MCCONF_OFFSETS.lMinVin, type: 'i16', value: v.minVin, scale: 10 },
      { offset: MCCONF_OFFSETS.lMaxVin, type: 'i16', value: v.maxVin, scale: 10 },
      { offset: MCCONF_OFFSETS.lBatteryCutStart, type: 'i16', value: v.cutStart, scale: 10 },
      { offset: MCCONF_OFFSETS.lBatteryCutEnd, type: 'i16', value: v.cutEnd, scale: 10 },
      { offset: MCCONF_OFFSETS.lMaxErpm, type: 'f32', value: maxErpm },
      { offset: MCCONF_OFFSETS.lMinErpm, type: 'f32', value: f.reverseErpm },
      { offset: MCCONF_OFFSETS.lErpmStart, type: 'i16', value: f.erpmLimitStartPct / 100, scale: 10000 },
      { offset: MCCONF_OFFSETS.lMaxDuty, type: 'i16', value: f.dutyCycleMaxPct / 100, scale: 10000 },
      { offset: MCCONF_OFFSETS.lTempFetStart, type: 'u8', value: TEMP_CUTOFF_C },
      { offset: MCCONF_OFFSETS.lTempMotorStart, type: 'u8', value: TEMP_CUTOFF_C },
      { offset: MCCONF_OFFSETS.lTempAccelDec, type: 'i16', value: TEMP_ACCEL_DEC_FRAC, scale: 10000 },
      { offset: MCCONF_OFFSETS.siWheelDiameter, type: 'f32', value: f.wheelDiameterMm / 1000 },
      { offset: MCCONF_OFFSETS.siGearRatio, type: 'f32', value: f.gearRatio },
      { offset: MCCONF_OFFSETS.siMotorPoles, type: 'u8', value: f.motorPoles },
    ];
  }

  // ---------------- Actions ----------------

  async _doRead(formEl, statusEl) {
    const side = this.activeSide;
    if (side === 'linked' && (await this._ensureLinkedCanId(statusEl)) == null) return;
    const targetCanId = this._targetCanId(side);
    statusEl.textContent = 'Reading…';
    statusEl.classList.remove('wizard__text--warn');
    try {
      const raw = await this.client.requestMcConfRaw(targetCanId);
      const c = parseMcConfConfigFields(raw);
      if (!c) throw new Error('Payload too short to decode');
      const f = this.sideForms[side];
      f.motorCurrentMax = Math.round(c.currentMax * 10) / 10;
      f.maxBatteryCurrent = Math.round(c.inCurrentMax * 10) / 10;
      f.motorCurrentMaxBrake = Math.round(Math.abs(c.currentMin) * 10) / 10;
      f.batteryCurrentMaxRegen = Math.round(c.inCurrentMin * 10) / 10;
      f.wheelDiameterMm = Math.round(c.wheelDiameterM * 1000);
      f.gearRatio = Math.round(c.gearRatio * 100) / 100;
      f.motorPoles = c.motorPoles;
      f.reverseErpm = Math.round(Math.max(-5000, Math.min(0, c.minErpm)));
      f.erpmLimitStartPct = Math.round(c.erpmStart * 1000) / 10;
      f.dutyCycleMaxPct = Math.round(c.maxDuty * 1000) / 10;
      if (f.wheelDiameterMm && f.gearRatio && f.motorPoles) {
        f.speedLimitMph = Math.round(erpmToMps(c.maxErpm, f.motorPoles, f.gearRatio, c.wheelDiameterM) * MPS_TO_MPH * 10) / 10;
      }
      // Battery S-count isn't stored on the board as an S-count, only as
      // raw voltages — back it out from the read nominal-ish cutoffs
      // rather than guessing, using our own 3.3V/cell cutStart landmark
      // (round to the nearest whole S, clamp to the picker's 5-20 range).
      const impliedS = Math.round(c.batteryCutStart / 3.3);
      f.batteryS = Math.max(5, Math.min(20, impliedS)) || null;

      this.sideReadAt[side] = Date.now();
      statusEl.textContent = `Read complete (${side === 'this' ? 'this VESC' : `linked VESC id ${targetCanId}`}).`;
      this._renderForm(formEl, statusEl);
    } catch (err) {
      statusEl.textContent = `Read failed: ${err.message}`;
      statusEl.classList.add('wizard__text--warn');
    }
  }

  /**
   * "Write to both VESCs" — one button, two writes done behind the
   * scenes: whatever's shown in the currently-active side's form gets
   * written direct (this VESC) AND forwarded over CAN to the linked
   * VESC (auto-detected via _ensureLinkedCanId — never a typed-in ID).
   * This replaces the old split between "Write" (active side only)
   * and "Copy to other VESC" (the other side only) — those two
   * together always amounted to "push this form to both boards"
   * anyway, so there's no longer a reason to make it two clicks.
   *
   * The direct write is the one that must succeed — if the physically
   * connected board rejects the config, nothing else should look like
   * it worked. The linked write is attempted after, and its failure is
   * reported without pretending the whole action failed, since the
   * direct side genuinely did get the new config.
   */
  async _doWrite(statusEl) {
    const side = this.activeSide;
    const errors = this._validate(side);
    if (errors.length) {
      statusEl.textContent = errors.join(' ');
      statusEl.classList.add('wizard__text--warn');
      return;
    }
    if ((await this._ensureLinkedCanId(statusEl)) == null) return;
    const patches = this._buildPatches(side);

    statusEl.textContent = 'Writing to this VESC…';
    statusEl.classList.remove('wizard__text--warn');
    try {
      await this.client.writeMcConfRaw(patches, null);
    } catch (err) {
      statusEl.textContent = `Write failed: ${err.message}. Nothing was changed — try again.`;
      statusEl.classList.add('wizard__text--warn');
      return;
    }

    statusEl.textContent = 'Writing to linked VESC…';
    try {
      await this.client.writeMcConfRaw(patches, this.linkedCanId);
    } catch (err) {
      statusEl.textContent = `Wrote to this VESC, but the linked VESC failed: ${err.message}. Only this VESC changed — try again to retry the linked side.`;
      statusEl.classList.add('wizard__text--warn');
      return;
    }

    // Both boards now hold the same config — mirror it into both
    // sides' own form state so switching the toggle shows what's
    // actually on the board rather than stale values.
    const written = { ...this.sideForms[side] };
    this.sideForms.this = { ...written };
    this.sideForms.linked = { ...written };
    this.sideReadAt.this = Date.now();
    this.sideReadAt.linked = Date.now();
    statusEl.textContent = 'Saved to both VESCs.';
  }

  async _doCompare(compareEl, statusEl) {
    if ((await this._ensureLinkedCanId(statusEl)) == null) return;
    statusEl.textContent = 'Reading both sides…';
    statusEl.classList.remove('wizard__text--warn');
    compareEl.innerHTML = '';
    try {
      const [thisRaw, linkedRaw] = await Promise.all([
        this.client.requestMcConfRaw(null),
        this.client.requestMcConfRaw(this.linkedCanId),
      ]);
      const a = parseMcConfConfigFields(thisRaw);
      const b = parseMcConfConfigFields(linkedRaw);
      if (!a || !b) throw new Error('Payload too short to decode on one or both sides');

      const rows = [
        ['Motor Current Max (A)', a.currentMax.toFixed(1), b.currentMax.toFixed(1)],
        ['Motor Current Max Brake (A)', Math.abs(a.currentMin).toFixed(1), Math.abs(b.currentMin).toFixed(1)],
        ['Max Battery Current (A)', a.inCurrentMax.toFixed(1), b.inCurrentMax.toFixed(1)],
        ['Battery Current Max Regen (A)', a.inCurrentMin.toFixed(1), b.inCurrentMin.toFixed(1)],
        ['Absolute Max Current (A)', a.absCurrentMax.toFixed(1), b.absCurrentMax.toFixed(1)],
        ['Battery cutoff start (V)', a.batteryCutStart.toFixed(1), b.batteryCutStart.toFixed(1)],
        ['Battery cutoff end (V)', a.batteryCutEnd.toFixed(1), b.batteryCutEnd.toFixed(1)],
        ['Forward ERPM max', Math.round(a.maxErpm).toString(), Math.round(b.maxErpm).toString()],
        ['Reverse ERPM min', Math.round(a.minErpm).toString(), Math.round(b.minErpm).toString()],
        ['ERPM limit start (%)', (a.erpmStart * 100).toFixed(1), (b.erpmStart * 100).toFixed(1)],
        ['Duty Cycle Max (%)', (a.maxDuty * 100).toFixed(1), (b.maxDuty * 100).toFixed(1)],
        ['Tire diameter (mm)', Math.round(a.wheelDiameterM * 1000).toString(), Math.round(b.wheelDiameterM * 1000).toString()],
        ['Gear ratio', a.gearRatio.toFixed(2), b.gearRatio.toFixed(2)],
        ['Motor poles', a.motorPoles.toString(), b.motorPoles.toString()],
      ];

      compareEl.innerHTML = `
        <div class="wizard__result-card" style="border-left-color: var(--amber);">
          <div class="wizard__result-title">This VESC vs Linked VESC</div>
          <div class="motor-config__compare-row motor-config__compare-row--head">
            <span></span><span>This</span><span>Linked</span>
          </div>
          ${rows.map(([label, av, bv]) => {
            const mismatch = av !== bv;
            return `<div class="motor-config__compare-row${mismatch ? ' motor-config__compare-row--mismatch' : ''}">
              <span>${label}</span><span>${av}</span><span>${bv}</span>
            </div>`;
          }).join('')}
        </div>
      `;
      statusEl.textContent = 'Compared both sides — mismatches highlighted.';
    } catch (err) {
      statusEl.textContent = `Compare failed: ${err.message}`;
      statusEl.classList.add('wizard__text--warn');
    }
  }
}
