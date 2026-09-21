/**
 * vesc-pedal-config.js
 * ------------------------------------------------------------------
 * Standalone "App (pedal) config" page — quick direct access for
 * people who already know what they're doing, as opposed to the
 * guided setup wizard. Reads the board's actual current config on
 * open (not a session-only capture), lets you edit control type,
 * pedal voltage range/center, ramp times, traction control, and
 * throttle curve, and writes for real on Save. App-to-Use is read
 * and preserved as-is (untouched) rather than exposed for editing
 * here — that toggle lives in the setup wizard, where it's needed
 * during pedal sync. Uses the same verified APPCONF_OFFSETS and CONTROL_TYPES
 * as the wizard — see vesc-protocol.js and the README for how those
 * were confirmed against real hardware.
 * ------------------------------------------------------------------
 */

import { APPCONF_OFFSETS, CONTROL_TYPES } from './vesc-protocol.js';

export class PedalConfigPage {
  constructor(root, client) {
    this.root = root;
    this.client = client;
    this._stopAdcPolling = null;
    this._latestAdc = null;
    this.onClose = null;
  }

  open() {
    this.root.hidden = false;
    this._render();
  }

  close() {
    this._stopAdc();
    this.root.hidden = true;
    this.root.innerHTML = '';
    if (this.onClose) this.onClose();
  }

  _stopAdc() {
    if (this._stopAdcPolling) { this._stopAdcPolling(); this._stopAdcPolling = null; }
  }

  _render() {
    this.root.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'wizard'; // reuse the same page chrome styling as the wizard

    const head = document.createElement('div');
    head.className = 'wizard__head';
    head.innerHTML = `<span class="wizard__title">App (pedal) config</span>`;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn--secondary btn--small';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', () => this.close());
    head.appendChild(closeBtn);
    wrap.appendChild(head);

    const body = document.createElement('div');
    body.className = 'wizard__body';
    body.innerHTML = `
      <div class="wizard__warning" id="pedalConfigWarning">
        <span class="wizard__warning-badge">IMPORTANT: PLEASE READ</span>
        <p class="wizard__text" style="margin:0 0 10px;">This VESC's pedal input directly drives
        the motor, the same control loop used when actually riding. If a motor is connected,
        pressing the pedal here <strong>can spin it for real</strong>, not just show a number on
        screen.</p>
        <p class="wizard__text" style="margin:0;"><strong>VEHICLE MUST BE LIFTED WITH THE DRIVE
        WHEELS OFF THE GROUND AND CLEAR OF OBSTACLES.</strong></p>
      </div>

      <p class="wizard__text wizard__text--note" id="pedalConfigStatus">Reading current config…</p>

      <div class="wizard__live">
        <span class="wizard__live-label">Live pedal voltage</span>
        <span class="wizard__live-value"><span id="pcAdcVoltage">–</span><span class="readout__unit">V</span></span>
      </div>

      <h3 class="wizard__heading" style="font-size:1rem;">Control type / ADC mapping</h3>
      <div class="wizard__options" id="pcControlOptions" style="margin-bottom:22px;"></div>

      <div class="wizard__capture-row">
        <div class="wizard__capture">
          <span class="wizard__capture-label">Min (idle)</span>
          <input type="number" step="0.01" class="motor-target__input wizard__num-input" id="pcMinInput" />
        </div>
        <div class="wizard__capture">
          <span class="wizard__capture-label">Max (full throttle)</span>
          <input type="number" step="0.01" class="motor-target__input wizard__num-input" id="pcMaxInput" />
        </div>
      </div>
      <div class="wizard__capture" style="margin-bottom:14px;">
        <span class="wizard__capture-label">Center</span>
        <input type="number" step="0.01" class="motor-target__input wizard__num-input" id="pcCenterInput" />
        <div class="wizard__capture-row" style="margin:10px 0 0;">
          <button class="btn btn--secondary" id="pcCaptureCenter">Capture from pedal</button>
        </div>
      </div>

      <p class="wizard__text">- If you are configuring for Power Wheels style braking
      and shifter (Current Reverse Switch Brake Center), the center voltage determines where
      braking begins and forward torque begins. Do NOT set it at the same value as your idle
      voltage. We recommend keeping this value between 1V and 1.8V, with the lower voltage
      giving a less touchy, smoother pedal feel.</p>

      <p class="wizard__text">- If you are configuring for use of a second pedal for
      motor braking, the center voltage controls when regenerative braking begins. We
      recommend keeping this value between 1V and 1.5V to prevent regen braking from
      activating while low throttle cruising is underway.</p>

      <p class="wizard__text wizard__text--note" style="margin-bottom:22px;">Recommended
      settings for ADC2 and center braking: 0.87V min, 1.1V center, 2.5V max.</p>

      <h3 class="wizard__heading" style="font-size:1rem;">Ramp time</h3>
      <div class="wizard__capture-row">
        <div class="wizard__capture">
          <span class="wizard__capture-label">Ramp time (positive)</span>
          <input type="number" step="0.01" class="motor-target__input wizard__num-input" id="pcRampPos" />
        </div>
        <div class="wizard__capture">
          <span class="wizard__capture-label">Ramp time (negative)</span>
          <input type="number" step="0.01" class="motor-target__input wizard__num-input" id="pcRampNeg" />
        </div>
      </div>

      <p class="wizard__text wizard__text--note" style="margin-top:10px;">Higher in value
      gives a softer launch; closer to 0 gets you more instant torque when the pedal is
      pressed.</p>
      <p class="wizard__text wizard__text--note" style="margin-top:10px;"><strong>Positive Ramp
      Time</strong> (also referred to as Pedal Delay) delays the response of power to the
      motors, in relation to pedal movement. For snappy torque, 0.0s to 0.1s is recommended.
      For a softer feel, 0.2s to 0.5s is recommended.</p>
      <p class="wizard__text wizard__text--note" style="margin-bottom:22px;"><strong>Negative
      Ramp Time</strong> is the amount of delay between releasing the pedal and regen braking,
      or center braking, becoming active. Recommend keeping this at the default value unless
      braking is coming on too quickly after releasing the pedal.</p>

      <h3 class="wizard__heading" style="font-size:1rem;">Traction control</h3>
      <div class="wizard__capture-row" style="grid-template-columns: auto auto; margin-bottom:10px;">
        <button class="btn btn--secondary" id="pcTcOn">On</button>
        <button class="btn btn--secondary" id="pcTcOff">Off</button>
      </div>
      <p class="wizard__text wizard__text--note" style="margin-bottom:22px;">When set to off,
      a motor that loses traction can run at higher and higher speed than the motor that still
      has traction. When turned on, both motors are electronically synced within a set
      tolerance to give an electronic locker feel &mdash; perfect for drifting, racing, climbing
      hills, etc.</p>

      <h3 class="wizard__heading" style="font-size:1rem;">Killswitch mode</h3>
      <div class="wizard__capture-row" style="grid-template-columns: auto auto auto; margin-bottom:10px;">
        <button class="btn btn--secondary" id="pcKillOff">Off</button>
        <button class="btn btn--secondary" id="pcKillLow">PPM Low</button>
        <button class="btn btn--secondary" id="pcKillHigh">PPM High</button>
      </div>
      <p class="wizard__text wizard__text--note" style="margin-bottom:22px;">Two configurations
      are available to shut off motor function using an external switch wired to the PPM
      signal pin. "Low" kills the motor when the switch pulls that pin low; "High" kills it
      when the switch pulls it high &mdash; match whichever one fits how your switch is wired.
      Off (the default) disables the killswitch entirely.</p>

      <h3 class="wizard__heading" style="font-size:1rem;">Throttle curve</h3>
      <p class="wizard__text wizard__text--note" style="margin-bottom:10px;">Move the slider
      positive or negative depending on how aggressive you want throttle sensitivity to be.
      Moving the bar positive reduces the amount of pedal input required to achieve full power
      (looking at you, drag racers). Going negative gives a soft, lazy pedal, perfect for kids
      who like to stab at the pedal like it owes them money. The three settings, "Poly,"
      "Expo," and "Natural," are three flavors of intensity for both negative and positive
      settings, with Expo being the most aggressive.</p>
      <div class="wizard__live" style="align-items:center;">
        <svg viewBox="0 0 200 200" width="200" height="200" id="pcCurveSvg">
          <line x1="0" y1="200" x2="200" y2="200" style="stroke:var(--ink); opacity:0.15;" />
          <line x1="0" y1="0" x2="0" y2="200" style="stroke:var(--ink); opacity:0.15;" />
          <path id="pcCurvePath" d="" fill="none" stroke-width="3" style="stroke:var(--green);" />
          <circle id="pcCurveDot" cx="0" cy="200" r="6" style="fill:var(--amber);" />
        </svg>
        <p class="wizard__text wizard__text--note" id="pcPedalReadout" style="margin:10px 0 0;">
          Pedal: 0% &rarr; Output: 0%
        </p>
        <div style="width:100%; margin-top:14px;">
          <span class="wizard__capture-label">Exponent: <span id="pcExpValue">0.00</span></span>
          <input type="range" id="pcExpSlider" min="-0.9" max="2" step="0.05" value="0" style="width:100%;" />
        </div>
        <div class="wizard__capture-row" style="margin-top:14px;">
          <button class="btn btn--secondary" id="pcModeExpo">Expo</button>
          <button class="btn btn--secondary" id="pcModeNatural">Natural</button>
          <button class="btn btn--secondary" id="pcModePoly">Poly</button>
        </div>
      </div>
    `;
    wrap.appendChild(body);

    const footer = document.createElement('div');
    footer.className = 'wizard__footer';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn--primary';
    saveBtn.textContent = 'Save';
    saveBtn.disabled = true;
    footer.appendChild(saveBtn);
    wrap.appendChild(footer);

    this.root.appendChild(wrap);

    this._controlType = null;
    this._min = null;
    this._max = null;
    this._center = null;
    this._rampPos = 0.3; // default until a real read overwrites it
    this._rampNeg = null;
    this._tc = 0;
    this._killSwMode = 0; // 0 = Off, default
    this._throttleExp = 0;
    this._throttleExpMode = 0;

    const statusEl = body.querySelector('#pedalConfigStatus');
    const minInput = body.querySelector('#pcMinInput');
    const maxInput = body.querySelector('#pcMaxInput');
    const centerInput = body.querySelector('#pcCenterInput');
    const optionsEl = body.querySelector('#pcControlOptions');
    const voltageEl = body.querySelector('#pcAdcVoltage');
    const rampPosInput = body.querySelector('#pcRampPos');
    const rampNegInput = body.querySelector('#pcRampNeg');
    const tcOnBtn = body.querySelector('#pcTcOn');
    const tcOffBtn = body.querySelector('#pcTcOff');
    const killOffBtn = body.querySelector('#pcKillOff');
    const killLowBtn = body.querySelector('#pcKillLow');
    const killHighBtn = body.querySelector('#pcKillHigh');
    const expSlider = body.querySelector('#pcExpSlider');
    const expValueEl = body.querySelector('#pcExpValue');
    const curvePath = body.querySelector('#pcCurvePath');
    const curveDot = body.querySelector('#pcCurveDot');
    const pedalReadout = body.querySelector('#pcPedalReadout');
    const modeExpoBtn = body.querySelector('#pcModeExpo');
    const modeNaturalBtn = body.querySelector('#pcModeNatural');
    const modePolyBtn = body.querySelector('#pcModePoly');
    const modeButtons = [modeExpoBtn, modeNaturalBtn, modePolyBtn];

    CONTROL_TYPES.forEach((opt) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'wizard__option';
      card.innerHTML = `
        <span class="wizard__option-label">${opt.label}</span>
        <span class="wizard__option-desc">${opt.desc}</span>
      `;
      card.addEventListener('click', () => {
        this._controlType = opt.value;
        optionsEl.querySelectorAll('.wizard__option').forEach((c) => { c.dataset.active = String(c === card); });
      });
      optionsEl.appendChild(card);
    });

    minInput.addEventListener('input', () => { this._min = parseFloat(minInput.value); });
    maxInput.addEventListener('input', () => { this._max = parseFloat(maxInput.value); });
    centerInput.addEventListener('input', () => { this._center = parseFloat(centerInput.value); });

    body.querySelector('#pcCaptureCenter').addEventListener('click', () => {
      if (!this._latestAdc) return;
      this._center = this._latestAdc.voltage;
      centerInput.value = this._center.toFixed(2);
    });

    rampPosInput.value = this._rampPos.toFixed(2); // seed the 0.3 default before any read completes
    rampPosInput.addEventListener('input', () => { this._rampPos = parseFloat(rampPosInput.value); });
    rampNegInput.addEventListener('input', () => { this._rampNeg = parseFloat(rampNegInput.value); });

    const setTc = (val) => {
      this._tc = val;
      tcOnBtn.dataset.active = String(val === 1);
      tcOffBtn.dataset.active = String(val === 0);
    };
    tcOnBtn.addEventListener('click', () => setTc(1));
    tcOffBtn.addEventListener('click', () => setTc(0));
    setTc(0); // default off, until a real read says otherwise

    const setKillSwMode = (val) => {
      this._killSwMode = val;
      killOffBtn.dataset.active = String(val === 0);
      killLowBtn.dataset.active = String(val === 1);
      killHighBtn.dataset.active = String(val === 2);
    };
    killOffBtn.addEventListener('click', () => setKillSwMode(0));
    killLowBtn.addEventListener('click', () => setKillSwMode(1));
    killHighBtn.addEventListener('click', () => setKillSwMode(2));
    setKillSwMode(0); // default off, until a real read says otherwise

    const drawCurve = () => {
      // power convention matches VESC Tool: negative exponent = softer,
      // more gradual power come-on; positive = tighter/faster, power
      // arrives sooner in the pedal throw.
      const power = 1 - this._throttleExp;
      const points = [];
      for (let i = 0; i <= 20; i++) {
        const x = i / 20;
        const y = Math.pow(x, Math.max(0.1, power));
        points.push(`${(x * 200).toFixed(1)},${(200 - y * 200).toFixed(1)}`);
      }
      curvePath.setAttribute('d', 'M' + points.join(' L'));
      updatePedalMarker();
    };

    // Maps the real, live pedal voltage through the current curve and
    // animates the pedal graphic + curve dot to match — so the curve
    // isn't an abstract shape, it's showing what THIS pedal, right now,
    // actually does.
    const updatePedalMarker = () => {
      let pedalPct = 0;
      if (this._latestAdc && this._min != null && this._max != null && this._max !== this._min) {
        pedalPct = (this._latestAdc.voltage - this._min) / (this._max - this._min);
        pedalPct = Math.max(0, Math.min(1, pedalPct));
      }
      const power = 1 - this._throttleExp;
      const outputPct = Math.pow(pedalPct, Math.max(0.1, power));

      curveDot.setAttribute('cx', (pedalPct * 200).toFixed(1));
      curveDot.setAttribute('cy', (200 - outputPct * 200).toFixed(1));

      pedalReadout.textContent =
        `Pedal: ${Math.round(pedalPct * 100)}% \u2192 Output: ${Math.round(outputPct * 100)}%`;
    };

    expSlider.addEventListener('input', () => {
      this._throttleExp = parseFloat(expSlider.value);
      expValueEl.textContent = this._throttleExp.toFixed(2);
      drawCurve();
    });

    const setMode = (mode) => {
      this._throttleExpMode = mode;
      modeButtons.forEach((b, i) => { b.dataset.active = String(i === mode); });
    };
    modeExpoBtn.addEventListener('click', () => setMode(0));
    modeNaturalBtn.addEventListener('click', () => setMode(1));
    modePolyBtn.addEventListener('click', () => setMode(2));
    setMode(0);
    drawCurve();

    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      statusEl.textContent = 'Saving…';
      statusEl.classList.remove('wizard__text--warn');
      try {
        await this.client.writeAppConf([
          { offset: APPCONF_OFFSETS.adcCtrlType, type: 'u8', value: this._controlType },
          { offset: APPCONF_OFFSETS.adcVoltageStart, type: 'i16', value: this._min, scale: 1000 },
          { offset: APPCONF_OFFSETS.adcVoltageEnd, type: 'i16', value: this._max, scale: 1000 },
          { offset: APPCONF_OFFSETS.adcVoltageCenter, type: 'i16', value: this._center, scale: 1000 },
          { offset: APPCONF_OFFSETS.rampTimePos, type: 'f32', value: this._rampPos },
          { offset: APPCONF_OFFSETS.rampTimeNeg, type: 'f32', value: this._rampNeg },
          { offset: APPCONF_OFFSETS.tc, type: 'u8', value: this._tc },
          { offset: APPCONF_OFFSETS.killSwMode, type: 'u8', value: this._killSwMode },
          { offset: APPCONF_OFFSETS.throttleExp, type: 'f32', value: this._throttleExp },
          { offset: APPCONF_OFFSETS.throttleExpMode, type: 'u8', value: this._throttleExpMode },
        ]);
        statusEl.textContent = 'Saved.';
      } catch (err) {
        statusEl.textContent = `Save failed: ${err.message}. Nothing was changed.`;
        statusEl.classList.add('wizard__text--warn');
      } finally {
        saveBtn.disabled = false;
      }
    });

    // Read the board's actual current config, then start live ADC polling.
    this.client.requestAppConf().catch(() => {});
    const prevOnAppConfRaw = this.client.onAppConfRaw;
    const onAppConfRaw = (raw) => {
      const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      const ctrlType = raw[APPCONF_OFFSETS.adcCtrlType];
      const min = view.getInt16(APPCONF_OFFSETS.adcVoltageStart) / 1000;
      const max = view.getInt16(APPCONF_OFFSETS.adcVoltageEnd) / 1000;
      const center = view.getInt16(APPCONF_OFFSETS.adcVoltageCenter) / 1000;
      const rampPos = view.getFloat32(APPCONF_OFFSETS.rampTimePos);
      const rampNeg = view.getFloat32(APPCONF_OFFSETS.rampTimeNeg);
      const tc = raw[APPCONF_OFFSETS.tc];
      const killSwMode = raw[APPCONF_OFFSETS.killSwMode];
      const throttleExp = view.getFloat32(APPCONF_OFFSETS.throttleExp);
      const throttleExpMode = raw[APPCONF_OFFSETS.throttleExpMode];

      this._controlType = ctrlType;
      optionsEl.querySelectorAll('.wizard__option').forEach((c, i) => {
        c.dataset.active = String(CONTROL_TYPES[i].value === ctrlType);
      });
      this._min = min; minInput.value = min.toFixed(2);
      this._max = max; maxInput.value = max.toFixed(2);
      this._center = center; centerInput.value = center.toFixed(2);
      this._rampPos = rampPos; rampPosInput.value = rampPos.toFixed(2);
      this._rampNeg = rampNeg; rampNegInput.value = rampNeg.toFixed(2);
      setTc(tc ? 1 : 0);
      // Firmware has 11 possible kill-switch modes; this page only
      // offers 3 (Off/PPM Low/PPM High). Preserve whatever was
      // actually read even if it's one of the other 8 (ADC2/ADC3/
      // SWDIO/SWCLK variants) — coercing an unrecognized value to
      // "Off" here would silently disable a killswitch mode set some
      // other way (e.g. official VESC Tool) the moment Save is hit,
      // without the person ever touching this section.
      this._killSwMode = killSwMode;
      killOffBtn.dataset.active = String(killSwMode === 0);
      killLowBtn.dataset.active = String(killSwMode === 1);
      killHighBtn.dataset.active = String(killSwMode === 2);
      this._throttleExp = throttleExp;
      expSlider.value = throttleExp;
      expValueEl.textContent = throttleExp.toFixed(2);
      setMode(throttleExpMode <= 2 ? throttleExpMode : 0);
      drawCurve();

      statusEl.textContent = killSwMode > 2
        ? `Loaded current config from the board. Note: killswitch is set to a mode this ` +
          `page doesn't offer a button for (raw value ${killSwMode}) — it will be left as-is ` +
          `unless you click one of the buttons above.`
        : 'Loaded current config from the board.';
      saveBtn.disabled = false;
      this.client.onAppConfRaw = prevOnAppConfRaw;
    };
    this.client.onAppConfRaw = onAppConfRaw;

    this.client.onDecodedAdc = (adc) => {
      this._latestAdc = adc;
      voltageEl.textContent = adc.voltage.toFixed(3);
      updatePedalMarker();
    };
    this._stopAdcPolling = this.client.startAdcPolling(100);
  }
}
