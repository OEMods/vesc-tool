/**
 * vesc-quick-adjust.js
 * ------------------------------------------------------------------
 * Small bottom-sheet panel for the home screen's 4 "quick adjust"
 * buttons (Speed, Ramp Time, Motor Current, Battery Current) — one
 * field at a time, no need to open the full Motor/App config pages
 * for a fast in-the-driveway tweak. Reads the live value on open,
 * writes it back on Save. What gets read/written is entirely up to
 * the caller-supplied config (see app.js) — this component only
 * knows how to show a slider and call two async functions.
 * ------------------------------------------------------------------
 */

export class QuickAdjustPanel {
  constructor(root) {
    this.root = root;
    this.onClose = null;
  }

  /**
   * config: {
   *   title, unit,
   *   min, max, step,
   *   format?: (value) => string,
   *   readValue: () => Promise<number>,
   *   writeValue: (value) => Promise<void>,
   * }
   */
  async open(config) {
    this.root.hidden = false;
    this.root.innerHTML = '';

    const panel = document.createElement('div');
    panel.className = 'quickadjust';
    panel.innerHTML = `
      <div class="quickadjust__head">
        <span class="quickadjust__title">${config.title}</span>
        <button class="btn btn--secondary btn--small" id="qaClose">Close</button>
      </div>
      <div class="quickadjust__value"><span id="qaValue">–</span><span class="quickadjust__unit">${config.unit || ''}</span></div>
      <div class="quickadjust__row">
        <button class="btn btn--secondary quickadjust__step" id="qaMinus">&minus;</button>
        <input type="range" id="qaSlider" min="${config.min}" max="${config.max}" step="${config.step ?? 1}" class="wizard__slider" />
        <button class="btn btn--secondary quickadjust__step" id="qaPlus">+</button>
      </div>
      <p class="wizard__text wizard__text--note" id="qaStatus">Reading current value…</p>
      <button class="btn btn--primary" id="qaSave" disabled>Save</button>
    `;
    this.root.appendChild(panel);

    const valueEl = panel.querySelector('#qaValue');
    const slider = panel.querySelector('#qaSlider');
    const statusEl = panel.querySelector('#qaStatus');
    const saveBtn = panel.querySelector('#qaSave');
    const closeBtn = panel.querySelector('#qaClose');
    const minusBtn = panel.querySelector('#qaMinus');
    const plusBtn = panel.querySelector('#qaPlus');
    const step = config.step ?? 1;
    const fmt = config.format || ((v) => (step < 1 ? v.toFixed(2) : v.toFixed(0)));

    const close = () => {
      this.root.hidden = true;
      this.root.innerHTML = '';
      if (this.onClose) this.onClose();
    };
    closeBtn.addEventListener('click', close);

    const setValue = (v) => {
      v = Math.max(config.min, Math.min(config.max, v));
      slider.value = v;
      valueEl.textContent = fmt(v);
    };

    slider.addEventListener('input', () => setValue(parseFloat(slider.value)));
    minusBtn.addEventListener('click', () => setValue(parseFloat(slider.value) - step));
    plusBtn.addEventListener('click', () => setValue(parseFloat(slider.value) + step));

    try {
      const current = await config.readValue();
      setValue(current);
      statusEl.textContent = '';
      saveBtn.disabled = false;
    } catch (err) {
      statusEl.textContent = `Couldn't read the current value (${err.message}) — you can still set one blind.`;
      statusEl.classList.add('wizard__text--warn');
      setValue((config.min + config.max) / 2);
      saveBtn.disabled = false;
    }

    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      statusEl.textContent = 'Saving…';
      statusEl.classList.remove('wizard__text--warn');
      try {
        await config.writeValue(parseFloat(slider.value));
        statusEl.textContent = 'Saved.';
        setTimeout(close, 700);
      } catch (err) {
        statusEl.textContent = `Save failed: ${err.message}`;
        statusEl.classList.add('wizard__text--warn');
        saveBtn.disabled = false;
      }
    });
  }
}
