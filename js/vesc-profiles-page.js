/**
 * vesc-profiles-page.js
 * ------------------------------------------------------------------
 * Standalone "Profiles" page — edit the 3 saved tune presets (see
 * vesc-profiles.js for what's in a profile and why pedal calibration/
 * control type are deliberately excluded). Pure data editing against
 * localStorage; the only thing this page talks to the VESC for is the
 * optional "Read current VESC into this profile" convenience button.
 * Applying a profile for real happens from the home screen's 3 quick
 * buttons (see app.js), not from here.
 * ------------------------------------------------------------------
 */

import { PROFILE_FIELDS, loadProfiles, saveProfiles, validateProfile } from './vesc-profiles.js';
import { APPCONF_OFFSETS, MCCONF_OFFSETS, parseMcConfConfigFields, batteryComboLabel, erpmToMps } from './vesc-protocol.js';

const MPS_TO_MPH = 2.2369362921;

export class ProfilesPage {
  constructor(root, client) {
    this.root = root;
    this.client = client;
    this.onClose = null;
    this.onProfilesChanged = null; // () => void — tell the home screen to refresh button labels
    this.profiles = loadProfiles();
    this.activeTab = 0;
  }

  open() {
    this.profiles = loadProfiles(); // pick up anything saved elsewhere/earlier
    this.root.hidden = false;
    this._render();
  }

  close() {
    this.root.hidden = true;
    this.root.innerHTML = '';
    if (this.onClose) this.onClose();
  }

  _render() {
    this.root.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'wizard';
    wrap.style.maxWidth = '640px';

    const head = document.createElement('div');
    head.className = 'wizard__head';
    head.innerHTML = `<span class="wizard__title">Profiles</span>`;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn--secondary btn--small';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', () => this.close());
    head.appendChild(closeBtn);
    wrap.appendChild(head);

    const body = document.createElement('div');
    body.className = 'wizard__body';
    body.innerHTML = `
      <p class="wizard__text wizard__text--note">Saved on this device only. These cover
      tuning &mdash; current limits, battery cutoffs, speed/gearing, ramp time, traction
      control, killswitch, throttle curve. Pedal voltage calibration and control type aren't
      part of a profile: those describe how this vehicle's actual pedal is wired, not a
      driving preference, so switching profiles never touches them.</p>

      <div class="motor-config__toggle" id="pfTabs"></div>
      <div id="pfForm"></div>
      <div class="motor-config__actions">
        <button class="btn btn--secondary" id="pfReadCurrent">Read current VESC into this profile</button>
        <button class="btn btn--primary" id="pfSave">Save profiles</button>
      </div>
      <p class="wizard__text wizard__text--note" id="pfStatus"></p>
    `;
    wrap.appendChild(body);
    this.root.appendChild(wrap);

    const tabsEl = body.querySelector('#pfTabs');
    const formEl = body.querySelector('#pfForm');
    const statusEl = body.querySelector('#pfStatus');

    this.profiles.forEach((p, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn';
      btn.textContent = p.name || `Profile ${i + 1}`;
      btn.dataset.active = String(this.activeTab === i);
      btn.addEventListener('click', () => {
        this.activeTab = i;
        this._render();
      });
      tabsEl.appendChild(btn);
    });

    this._renderForm(formEl);

    body.querySelector('#pfReadCurrent').addEventListener('click', () => this._doReadCurrent(statusEl));
    body.querySelector('#pfSave').addEventListener('click', () => this._doSave(statusEl));
  }

  _renderForm(formEl) {
    const p = this.profiles[this.activeTab];
    formEl.innerHTML = '';

    const nameRow = document.createElement('div');
    nameRow.className = 'wizard__capture';
    nameRow.innerHTML = `<span class="wizard__capture-label">Profile name</span>`;
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.maxLength = 24;
    nameInput.className = 'motor-target__input wizard__num-input';
    nameInput.value = p.name || '';
    nameInput.addEventListener('input', () => { p.name = nameInput.value; });
    nameRow.appendChild(nameInput);
    formEl.appendChild(nameRow);

    let lastGroup = null;
    for (const field of PROFILE_FIELDS) {
      if (field.group !== lastGroup) {
        lastGroup = field.group;
        const h = document.createElement('h3');
        h.className = 'wizard__heading';
        h.style.fontSize = '1rem';
        h.textContent = field.group === 'mcconf' ? 'Motor / battery / speed' : 'App / pedal tuning';
        formEl.appendChild(h);
      }
      formEl.appendChild(this._buildFieldRow(field, p));
    }
  }

  _buildFieldRow(field, p) {
    const row = document.createElement('div');
    row.className = 'wizard__capture';
    const label = document.createElement('span');
    label.className = 'wizard__capture-label';
    label.textContent = field.label;
    row.appendChild(label);

    if (field.type === 'select') {
      const select = document.createElement('select');
      select.className = 'motor-target__input wizard__num-input';
      for (const [value, text] of field.options) {
        const opt = document.createElement('option');
        opt.value = String(value);
        opt.textContent = text;
        select.appendChild(opt);
      }
      select.value = String(p[field.key] ?? field.options[0][0]);
      select.addEventListener('change', () => { p[field.key] = parseInt(select.value, 10); });
      row.appendChild(select);
    } else if (field.type === 'battery') {
      const select = document.createElement('select');
      select.className = 'motor-target__input wizard__num-input';
      select.innerHTML = `<option value="">Select a pack size…</option>` +
        Array.from({ length: 16 }, (_, i) => i + 5)
          .map((s) => `<option value="${s}">${batteryComboLabel(s)}</option>`).join('');
      select.value = p[field.key] != null ? String(p[field.key]) : '';
      select.addEventListener('change', () => {
        const v = parseInt(select.value, 10);
        p[field.key] = Number.isNaN(v) ? null : v;
      });
      row.appendChild(select);
    } else {
      const input = document.createElement('input');
      input.type = 'number';
      if (field.min != null) input.min = field.min;
      if (field.max != null) input.max = field.max;
      input.step = field.step ?? 1;
      input.className = 'motor-target__input wizard__num-input';
      if (p[field.key] != null) input.value = p[field.key];
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        p[field.key] = Number.isNaN(v) ? null : v;
      });
      row.appendChild(input);
    }
    return row;
  }

  async _doReadCurrent(statusEl) {
    statusEl.textContent = 'Reading current VESC config…';
    statusEl.classList.remove('wizard__text--warn');
    try {
      const [mcRaw, apRaw] = await Promise.all([
        this.client.requestMcConfRaw(null),
        this.client.readAppConf(),
      ]);
      const c = parseMcConfConfigFields(mcRaw);
      if (!c) throw new Error('MCCONF payload too short to decode');
      const view = new DataView(apRaw.buffer, apRaw.byteOffset, apRaw.byteLength);

      const p = this.profiles[this.activeTab];
      p.motorCurrentMax = Math.round(c.currentMax * 10) / 10;
      p.maxBatteryCurrent = Math.round(c.inCurrentMax * 10) / 10;
      p.motorCurrentMaxBrake = Math.round(Math.abs(c.currentMin) * 10) / 10;
      p.batteryCurrentMaxRegen = Math.round(c.inCurrentMin * 10) / 10;
      p.wheelDiameterMm = Math.round(c.wheelDiameterM * 1000);
      p.gearRatio = Math.round(c.gearRatio * 100) / 100;
      p.motorPoles = c.motorPoles;
      p.reverseErpm = Math.round(Math.max(-5000, Math.min(0, c.minErpm)));
      p.erpmLimitStartPct = Math.round(c.erpmStart * 1000) / 10;
      p.dutyCycleMaxPct = Math.round(c.maxDuty * 1000) / 10;
      if (p.wheelDiameterMm && p.gearRatio && p.motorPoles) {
        p.speedLimitMph = Math.round(erpmToMps(c.maxErpm, p.motorPoles, p.gearRatio, c.wheelDiameterM) * MPS_TO_MPH * 10) / 10;
      }
      const impliedS = Math.round(c.batteryCutStart / 3.3);
      p.batteryS = Math.max(5, Math.min(20, impliedS)) || null;

      p.rampPos = Math.round(view.getFloat32(APPCONF_OFFSETS.rampTimePos) * 100) / 100;
      p.rampNeg = Math.round(view.getFloat32(APPCONF_OFFSETS.rampTimeNeg) * 100) / 100;
      p.tc = apRaw[APPCONF_OFFSETS.tc] ? 1 : 0;
      const killSwMode = apRaw[APPCONF_OFFSETS.killSwMode];
      p.killSwMode = killSwMode <= 2 ? killSwMode : 0;
      p.throttleExp = Math.round(view.getFloat32(APPCONF_OFFSETS.throttleExp) * 100) / 100;
      const throttleExpMode = apRaw[APPCONF_OFFSETS.throttleExpMode];
      p.throttleExpMode = throttleExpMode <= 2 ? throttleExpMode : 0;

      this._render();
      statusEl.textContent = 'Loaded current VESC values into this profile — hit Save to keep them.';
    } catch (err) {
      statusEl.textContent = `Read failed: ${err.message}`;
      statusEl.classList.add('wizard__text--warn');
    }
  }

  _doSave(statusEl) {
    // Saving is never blocked by incomplete fields — a profile only
    // needs to be fully filled out at the moment someone tries to
    // Apply it (the home screen's quick buttons re-validate then).
    // Blocking Save itself would make it impossible to work on one
    // profile at a time while leaving the other two untouched.
    const ok = saveProfiles(this.profiles);
    if (!ok) {
      statusEl.textContent = 'Could not save — your browser may be blocking local storage (private browsing?).';
      statusEl.classList.add('wizard__text--warn');
      return;
    }
    const incomplete = this.profiles
      .map((p, i) => ({ p, i, errors: validateProfile(p) }))
      .filter((x) => x.errors.length);
    statusEl.classList.remove('wizard__text--warn');
    statusEl.textContent = incomplete.length
      ? `Saved. Note: "${incomplete[0].p.name || `Profile ${incomplete[0].i + 1}`}" is still ` +
        `incomplete (${incomplete[0].errors[0]}) — fine for now, but it can't be applied until that's fixed.`
      : 'Saved.';
    if (this.onProfilesChanged) this.onProfilesChanged();
  }
}
