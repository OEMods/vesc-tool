/**
 * vesc-rt-data.js
 * ------------------------------------------------------------------
 * Real-time data page. Starts streaming the moment it opens (see the
 * README — VESC Tool's own RT view is just fast repeated
 * COMM_GET_VALUES polling, no dedicated streaming command exists in
 * firmware). Reuses the already-verified startPolling/startAdcPolling
 * helpers at a faster interval.
 *
 * Fault names are the real mc_fault_code enum from firmware source
 * (lispBM/c_libs/vesc_c_if.h, current mainline) — not guessed labels.
 * ------------------------------------------------------------------
 */

import { faultName } from './vesc-protocol.js';

const FIELDS = [
  { key: 'voltage', label: 'Battery voltage', unit: 'V', fmt: (v) => v.toFixed(1) },
  { key: 'erpm', label: 'ERPM', fmt: (v) => Math.round(v).toLocaleString() },
  { key: 'duty', label: 'Duty cycle', unit: '%', fmt: (v) => v.toFixed(1) },
  { key: 'motorCurrent', label: 'Motor current', unit: 'A', fmt: (v) => v.toFixed(1) },
  { key: 'batteryCurrent', label: 'Battery current', unit: 'A', fmt: (v) => v.toFixed(1) },
  { key: 'motorTemp', label: 'Motor temp', unit: '\u00B0C', fmt: (v) => v.toFixed(0) },
  { key: 'vescTemp', label: 'VESC temp', unit: '\u00B0C', fmt: (v) => v.toFixed(0) },
  { key: 'pedalPct', label: 'Pedal position', unit: '%', fmt: (v) => v.toFixed(0) },
];

// Chart series: only motor current / battery current / duty, per what was asked.
const CHART_SERIES = [
  { key: 'motorCurrent', label: 'Motor current (A)', color: '#6FBF6B' },
  { key: 'batteryCurrent', label: 'Battery current (A)', color: '#E0A542' },
  { key: 'duty', label: 'Duty cycle (%)', color: '#7EA9D8' },
];

export class RtDataPage {
  constructor(root, client) {
    this.root = root;
    this.client = client;
    this.onClose = null;
    this._stopValuesPolling = null;
    this._stopAdcPolling = null;
    this._logging = false;
    this._logRows = [];
    this._logStartMs = null;
    this._latest = {};
    this._samples = []; // rolling buffer for the chart: {t, motorCurrent, batteryCurrent, duty}
    this._chartStart = null;
    this._lastFaultCode = 0;
    this._faultLog = []; // {t, code, name} — session only
    this._maxErpmSeen = 1000;
    this._chartYAuto = true;
    this._chartYMin = -20;
    this._chartYMax = 20;
    this._chartWindowSec = 15;
  }

  open() {
    this.root.hidden = false;
    this._prevOnValues = this.client.onValues;
    this._prevOnDecodedAdc = this.client.onDecodedAdc;
    this._render();
  }

  close() {
    this._stopStreaming();
    this.client.onValues = this._prevOnValues;
    this.client.onDecodedAdc = this._prevOnDecodedAdc;
    this.root.hidden = true;
    this.root.innerHTML = '';
    if (this.onClose) this.onClose();
  }

  _stopStreaming() {
    if (this._stopValuesPolling) { this._stopValuesPolling(); this._stopValuesPolling = null; }
    if (this._stopAdcPolling) { this._stopAdcPolling(); this._stopAdcPolling = null; }
  }

  _render() {
    this.root.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'wizard';
    wrap.style.maxWidth = '680px';

    const head = document.createElement('div');
    head.className = 'wizard__head';
    head.innerHTML = `<span class="wizard__title">RT Data</span>`;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn--secondary btn--small';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', () => this.close());
    head.appendChild(closeBtn);
    wrap.appendChild(head);

    const body = document.createElement('div');
    body.className = 'wizard__body';
    body.innerHTML = `
      <div style="display:flex; gap:20px; justify-content:center; flex-wrap:wrap; margin-bottom:20px;">
        <div style="text-align:center;">
          <svg viewBox="0 0 200 120" width="200" height="120" id="rtErpmGauge">
            <path d="M 20 100 A 80 80 0 0 1 180 100" fill="none" stroke-width="12" style="stroke:var(--card-strong);" />
            <line id="rtErpmNeedle" x1="100" y1="100" x2="100" y2="30" stroke-width="4" style="stroke:var(--amber); transform-origin:100px 100px; transition: transform 0.1s linear;" />
            <circle cx="100" cy="100" r="5" style="fill:var(--ink);" />
          </svg>
          <div class="wizard__capture-label">ERPM</div>
          <div class="wizard__capture-value" id="rtErpmValue">0</div>
        </div>
        <div style="text-align:center;">
          <svg viewBox="0 0 200 120" width="200" height="120" id="rtVoltGauge">
            <path d="M 20 100 A 80 80 0 0 1 180 100" fill="none" stroke-width="12" style="stroke:var(--card-strong);" />
            <line id="rtVoltNeedle" x1="100" y1="100" x2="100" y2="30" stroke-width="4" style="stroke:var(--green); transform-origin:100px 100px; transition: transform 0.1s linear;" />
            <circle cx="100" cy="100" r="5" style="fill:var(--ink);" />
            <text x="24" y="115" style="fill:var(--ink-dim); font-size:9px;">E</text>
            <text x="170" y="115" style="fill:var(--ink-dim); font-size:9px;">F</text>
          </svg>
          <div class="wizard__capture-label">Battery voltage</div>
          <div class="wizard__capture-value" id="rtVoltValue">0.0 V</div>
          <div class="wizard__capture-row" style="grid-template-columns:1fr 1fr; margin-top:6px;">
            <input type="number" class="motor-target__input wizard__num-input" id="rtVoltEmpty" placeholder="Empty (V)" style="width:80px;" />
            <input type="number" class="motor-target__input wizard__num-input" id="rtVoltFull" placeholder="Full (V)" style="width:80px;" />
          </div>
        </div>
      </div>

      <div class="telemetry" style="margin-bottom:20px;"></div>

      <p class="wizard__text wizard__text--note" style="margin-bottom:6px;">Motor current / battery current / duty cycle</p>
      <div style="display:flex; gap:14px; margin-bottom:8px; flex-wrap:wrap;">
        ${CHART_SERIES.map((s) => `<span style="font-size:0.78rem; color:var(--ink-dim);"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${s.color};margin-right:5px;"></span>${s.label}</span>`).join('')}
      </div>
      <svg viewBox="0 0 400 160" width="100%" height="160" id="rtChart" style="background:var(--card); border-radius:var(--radius-md);" preserveAspectRatio="none">
        <line x1="0" y1="80" x2="400" y2="80" style="stroke:var(--ink); opacity:0.1;" />
      </svg>
      <div class="wizard__capture-row" style="grid-template-columns:auto auto auto 1fr; margin:10px 0 20px; align-items:center;">
        <button class="btn btn--secondary" id="rtYAuto">Y: Auto</button>
        <input type="number" class="motor-target__input wizard__num-input" id="rtYMin" placeholder="Y min" style="width:70px;" />
        <input type="number" class="motor-target__input wizard__num-input" id="rtYMax" placeholder="Y max" style="width:70px;" />
        <div style="text-align:right;">
          <span class="wizard__capture-label">Window (s)</span>
          <input type="number" class="motor-target__input wizard__num-input" id="rtWindowSec" value="15" style="width:60px;" />
        </div>
      </div>

      <p class="wizard__text wizard__text--note" style="margin-bottom:6px;">Faults this session</p>
      <div id="rtFaultLog" style="margin-bottom:20px;">
        <p class="wizard__text wizard__text--note">No faults yet.</p>
      </div>

      <div class="wizard__capture-row" style="grid-template-columns:auto auto auto 1fr;">
        <button class="btn btn--secondary" id="rtLogToggle">Start logging</button>
        <button class="btn btn--secondary" id="rtLogSave" disabled>Save log</button>
        <button class="btn btn--secondary" id="rtLogView" disabled>View log</button>
        <span class="wizard__text wizard__text--note" id="rtLogStatus" style="align-self:center; margin:0;">Not logging.</span>
      </div>
      <p class="wizard__text wizard__text--note">If "Save log" does nothing (some
      Bluetooth-only browsers, like Bluefy on iPhone, don't implement file
      downloads), use "View log" instead — it shows the CSV as text right on
      this page, which you can copy out manually.</p>
    `;
    wrap.appendChild(body);
    this.root.appendChild(wrap);

    const grid = body.querySelector('.telemetry');
    const els = {};
    FIELDS.forEach((f) => {
      const box = document.createElement('div');
      box.className = 'readout';
      box.innerHTML = `
        <span class="readout__label">${f.label}</span>
        <span class="readout__value"><span id="rt_${f.key}">\u2013</span>${f.unit ? `<span class="readout__unit">${f.unit}</span>` : ''}</span>
      `;
      grid.appendChild(box);
      els[f.key] = box.querySelector(`#rt_${f.key}`);
    });

    const erpmNeedle = body.querySelector('#rtErpmNeedle');
    const erpmValueEl = body.querySelector('#rtErpmValue');
    const voltNeedle = body.querySelector('#rtVoltNeedle');
    const voltValueEl = body.querySelector('#rtVoltValue');
    const voltEmptyInput = body.querySelector('#rtVoltEmpty');
    const voltFullInput = body.querySelector('#rtVoltFull');
    const chartSvg = body.querySelector('#rtChart');
    const yAutoBtn = body.querySelector('#rtYAuto');
    const yMinInput = body.querySelector('#rtYMin');
    const yMaxInput = body.querySelector('#rtYMax');
    const windowInput = body.querySelector('#rtWindowSec');
    const faultLogEl = body.querySelector('#rtFaultLog');
    const logToggle = body.querySelector('#rtLogToggle');
    const logSave = body.querySelector('#rtLogSave');
    const logView = body.querySelector('#rtLogView');
    const logStatus = body.querySelector('#rtLogStatus');

    // Shared by both Save and View — builds the CSV text from whatever
    // rows were captured this session.
    const buildLogCsv = () => {
      const header = ['time_ms', ...FIELDS.map((f) => f.key)].join(',');
      const lines = this._logRows.map((row) =>
        [row.t, ...FIELDS.map((f) => row[f.key])].join(',')
      );
      return [header, ...lines].join('\n');
    };

    // Chart series paths — created once, updated in place each tick.
    const chartPaths = CHART_SERIES.map((s) => {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke-width', '2');
      path.style.stroke = s.color;
      chartSvg.appendChild(path);
      return path;
    });

    yAutoBtn.addEventListener('click', () => {
      this._chartYAuto = true;
      yAutoBtn.dataset.active = 'true';
    });
    yAutoBtn.dataset.active = 'true';
    [yMinInput, yMaxInput].forEach((input) => {
      input.addEventListener('input', () => {
        this._chartYAuto = false;
        yAutoBtn.dataset.active = 'false';
        this._chartYMin = parseFloat(yMinInput.value) || 0;
        this._chartYMax = parseFloat(yMaxInput.value) || 100;
      });
    });
    windowInput.addEventListener('input', () => {
      this._chartWindowSec = Math.max(1, parseFloat(windowInput.value) || 15);
    });

    const renderField = (key) => {
      const f = FIELDS.find((x) => x.key === key);
      if (f && this._latest[key] != null && els[key]) {
        els[key].textContent = f.fmt(this._latest[key]);
      }
    };

    const updateErpmGauge = () => {
      const erpm = this._latest.erpm ?? 0;
      this._maxErpmSeen = Math.max(this._maxErpmSeen, Math.abs(erpm) * 1.15);
      const frac = Math.max(-1, Math.min(1, erpm / this._maxErpmSeen));
      const angle = frac * 90; // -90 (full reverse) .. 0 (stopped, pointing up) .. +90 (full forward)
      erpmNeedle.style.transform = `rotate(${angle.toFixed(1)}deg)`;
      erpmValueEl.textContent = Math.round(erpm).toLocaleString();
    };

    const updateVoltGauge = () => {
      const v = this._latest.voltage ?? 0;
      voltValueEl.textContent = `${v.toFixed(1)} V`;
      const empty = parseFloat(voltEmptyInput.value);
      const full = parseFloat(voltFullInput.value);
      if (!Number.isNaN(empty) && !Number.isNaN(full) && full > empty) {
        const frac = Math.max(0, Math.min(1, (v - empty) / (full - empty)));
        voltNeedle.style.transform = `rotate(${(-90 + frac * 180).toFixed(1)}deg)`;
        voltNeedle.style.stroke = frac < 0.2 ? 'var(--red)' : frac < 0.4 ? 'var(--amber)' : 'var(--green)';
      } else {
        voltNeedle.style.transform = 'rotate(0deg)';
        voltNeedle.style.stroke = 'var(--ink-dim)';
      }
    };
    voltEmptyInput.addEventListener('input', updateVoltGauge);
    voltFullInput.addEventListener('input', updateVoltGauge);

    const updateChart = () => {
      if (this._chartStart == null) this._chartStart = Date.now();
      const now = Date.now();
      const windowMs = this._chartWindowSec * 1000;
      this._samples = this._samples.filter((s) => now - s.t <= windowMs);

      let yMin = this._chartYMin, yMax = this._chartYMax;
      if (this._chartYAuto) {
        let lo = Infinity, hi = -Infinity;
        this._samples.forEach((s) => {
          CHART_SERIES.forEach((series) => {
            const v = s[series.key];
            if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
          });
        });
        if (lo === Infinity) { lo = 0; hi = 1; }
        if (hi === lo) { hi = lo + 1; }
        const pad = (hi - lo) * 0.1;
        yMin = lo - pad; yMax = hi + pad;
      }

      CHART_SERIES.forEach((series, i) => {
        const points = this._samples.map((s) => {
          const x = 400 - ((now - s.t) / windowMs) * 400;
          const val = s[series.key] ?? yMin;
          const y = 160 - ((val - yMin) / (yMax - yMin || 1)) * 160;
          return `${x.toFixed(1)},${Math.max(0, Math.min(160, y)).toFixed(1)}`;
        });
        chartPaths[i].setAttribute('d', points.length ? 'M' + points.join(' L') : '');
      });
    };

    const addFaultToLog = (code) => {
      const entry = { t: new Date(), code, name: faultName(code) };
      this._faultLog.unshift(entry);
      faultLogEl.innerHTML = this._faultLog.slice(0, 20).map((e) => `
        <p class="wizard__text" style="margin:0 0 6px; font-size:0.85rem;">
          <span style="color:var(--red); font-weight:700;">${e.name}</span>
          <span class="wizard__text--note"> \u2014 ${e.t.toLocaleTimeString()}</span>
        </p>
      `).join('');
    };

    const maybeLogRow = () => {
      if (!this._logging) return;
      const row = { t: Date.now() - this._logStartMs };
      FIELDS.forEach((f) => { row[f.key] = this._latest[f.key] ?? ''; });
      this._logRows.push(row);
      logStatus.textContent = `Logging\u2026 ${this._logRows.length} samples.`;
    };

    this.client.onValues = (v) => {
      this._latest.voltage = v.vIn;
      this._latest.erpm = v.rpm;
      this._latest.duty = v.dutyPct;
      this._latest.motorCurrent = v.currentMotorA;
      this._latest.batteryCurrent = v.currentInA;
      this._latest.motorTemp = v.tempMotorC;
      this._latest.vescTemp = v.tempMosC;
      ['voltage', 'erpm', 'duty', 'motorCurrent', 'batteryCurrent', 'motorTemp', 'vescTemp'].forEach(renderField);

      this._samples.push({
        t: Date.now(),
        motorCurrent: v.currentMotorA,
        batteryCurrent: v.currentInA,
        duty: v.dutyPct,
      });
      updateChart();
      updateErpmGauge();
      updateVoltGauge();

      if (v.faultCode !== 0 && v.faultCode !== this._lastFaultCode) {
        addFaultToLog(v.faultCode);
      }
      this._lastFaultCode = v.faultCode;

      maybeLogRow();
    };
    this._stopValuesPolling = this.client.startPolling(100); // 10 Hz

    this.client.onDecodedAdc = (adc) => {
      this._latest.pedalPct = adc.level * 100;
      renderField('pedalPct');
    };
    this._stopAdcPolling = this.client.startAdcPolling(100); // 10 Hz

    logToggle.addEventListener('click', () => {
      if (!this._logging) {
        this._logging = true;
        this._logRows = [];
        this._logStartMs = Date.now();
        logToggle.textContent = 'Stop logging';
        logToggle.dataset.active = 'true';
        logSave.disabled = true;
        logView.disabled = true;
        logStatus.textContent = 'Logging\u2026 0 samples.';
      } else {
        this._logging = false;
        logToggle.textContent = 'Start logging';
        logToggle.dataset.active = 'false';
        logSave.disabled = this._logRows.length === 0;
        logView.disabled = this._logRows.length === 0;
        logStatus.textContent = `Stopped \u2014 ${this._logRows.length} samples ready to save.`;
      }
    });

    logSave.addEventListener('click', () => {
      if (this._logRows.length === 0) return;
      const csv = buildLogCsv();
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      a.href = url;
      a.download = `vesc-rt-log-${stamp}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Revoke on a delay, not immediately: some engines process the
      // download asynchronously, and revoking the object URL right
      // after the click can race ahead of that and invalidate the
      // blob before it's actually been read.
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      logStatus.textContent = `Saved ${this._logRows.length} samples.`;
    });

    // Fallback for browsers/wrappers with no real download support \u2014
    // e.g. Bluefy on iPhone (a custom WKWebView shell that adds Web
    // Bluetooth, but has no guarantee it wires up a file-download
    // delegate the way a real browser does, so the Save button's
    // synthetic <a download> click can silently do nothing). Opening
    // a new window/tab isn't reliable here either \u2014 confirmed on real
    // hardware: window.open(blobUrl) opened a blank window in Bluefy,
    // no content. blob: URLs are scoped to the document that created
    // them, and a from-scratch new-window implementation in a small
    // third-party shell has no guarantee it gives the new context
    // access to the opener's blob registry (or implements window.open
    // as a real second browsing context at all). So this shows the
    // CSV in-page instead \u2014 a plain DOM overlay with a
    // read-only textarea \u2014 which needs nothing beyond what every
    // webview already has to support to render this app at all: no
    // download API, no blob-across-windows, no navigation away from
    // the page (which would also drop the live BLE connection).
    logView.addEventListener('click', () => {
      if (this._logRows.length === 0) return;
      this._showLogTextModal(buildLogCsv());
    });
  }

  _showLogTextModal(csv) {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 500;
      background: rgba(0,0,0,0.85);
      display: flex; align-items: center; justify-content: center;
      padding: 16px;
    `;

    const card = document.createElement('div');
    card.style.cssText = `
      background: var(--card-strong); border-radius: var(--radius-lg);
      max-width: 640px; width: 100%; max-height: 85vh;
      display: flex; flex-direction: column; padding: 18px;
      font-family: var(--font-body);
    `;

    const heading = document.createElement('p');
    heading.className = 'wizard__text';
    heading.style.marginTop = '0';
    heading.textContent = 'Session log \u2014 tap into the box below, select all, then copy (or use "Copy to clipboard" if that works in this browser).';
    card.appendChild(heading);

    const textarea = document.createElement('textarea');
    textarea.readOnly = true;
    textarea.value = csv;
    textarea.style.cssText = `
      flex: 1; min-height: 240px; width: 100%; box-sizing: border-box;
      background: var(--bg); color: var(--ink); border: 1px solid var(--card);
      border-radius: var(--radius-sm); padding: 10px;
      font-family: monospace; font-size: 0.8rem; white-space: pre;
      resize: none;
    `;
    card.appendChild(textarea);

    const statusEl = document.createElement('p');
    statusEl.className = 'wizard__text wizard__text--note';
    statusEl.style.minHeight = '1.2em';
    card.appendChild(statusEl);

    const footer = document.createElement('div');
    footer.className = 'wizard__footer';
    footer.style.marginTop = '10px';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn btn--secondary';
    copyBtn.textContent = 'Copy to clipboard';
    copyBtn.addEventListener('click', async () => {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(csv);
          statusEl.textContent = 'Copied.';
        } else {
          throw new Error('Clipboard API not available');
        }
      } catch (_) {
        // Fallback for a webview with no Clipboard API permission \u2014
        // select the textarea's contents so at least the manual
        // tap-select-copy path (which needs nothing but text
        // selection) is one step shorter.
        textarea.focus();
        textarea.select();
        statusEl.textContent = "Couldn't copy automatically \u2014 text is now selected, use this browser's own copy action.";
      }
    });
    footer.appendChild(copyBtn);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn--primary';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', () => overlay.remove());
    footer.appendChild(closeBtn);

    card.appendChild(footer);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    textarea.focus();
    textarea.select();
  }
}
