import { VescUsbClient } from './vesc-usb.js';
import { SetupWizard } from './vesc-wizard.js';
import { PedalConfigPage } from './vesc-pedal-config.js';
import { MotorConfigPage } from './vesc-motor-config.js';
import { RtDataPage } from './vesc-rt-data.js';
import { ProfilesPage } from './vesc-profiles-page.js';
import { QuickAdjustPanel } from './vesc-quick-adjust.js';
import { loadProfiles, applyProfile, validateProfile } from './vesc-profiles.js';
import { APPCONF_OFFSETS, MCCONF_OFFSETS, parseMcConfConfigFields, erpmToMps, mpsToErpm } from './vesc-protocol.js';

const MPS_TO_MPH = 2.2369362921;

// Milestone: USB first. This file talks to VescUsbClient — same shape
// of client (connect/disconnect/onValues/onLog/onConnectionChange) as
// VescBleClient, so swapping transports later is a one-line change,
// not a rewrite.

const els = {
  unsupportedBanner: document.getElementById('unsupportedBanner'),
  connectPanel: document.getElementById('connectPanel'),
  connectBtn: document.getElementById('connectBtn'),
  telemetry: document.getElementById('telemetry'),
  statusPill: document.getElementById('statusPill'),
  statusText: document.getElementById('statusText'),
  faultReadout: document.getElementById('faultReadout'),
  dutyGaugeFill: document.getElementById('dutyGaugeFill'),
  dutyGaugeValue: document.getElementById('dutyGaugeValue'),
  setupEntry: document.getElementById('setupEntry'),
  newSetupBtn: document.getElementById('newSetupBtn'),
  wizardOverlay: document.getElementById('wizardOverlay'),
  pedalConfigBtn: document.getElementById('pedalConfigBtn'),
  pedalConfigOverlay: document.getElementById('pedalConfigOverlay'),
  motorConfigBtn: document.getElementById('motorConfigBtn'),
  motorConfigOverlay: document.getElementById('motorConfigOverlay'),
  rtDataBtn: document.getElementById('rtDataBtn'),
  rtDataOverlay: document.getElementById('rtDataOverlay'),
  profilesBtn: document.getElementById('profilesBtn'),
  profilesOverlay: document.getElementById('profilesOverlay'),
  quickAdjustOverlay: document.getElementById('quickAdjustOverlay'),
  quickActions: document.getElementById('quickActions'),
  profileButtons: document.getElementById('profileButtons'),
  qaSpeedBtn: document.getElementById('qaSpeedBtn'),
  qaRampBtn: document.getElementById('qaRampBtn'),
  qaMotorCurrentBtn: document.getElementById('qaMotorCurrentBtn'),
  qaBatteryCurrentBtn: document.getElementById('qaBatteryCurrentBtn'),
  dashboardHero: document.getElementById('dashboardHero'),
  speedValue: document.getElementById('speedValue'),
  motorTarget: document.getElementById('motorTarget'),
  motorTargetButtons: document.getElementById('motorTargetButtons'),
  targetLocalBtn: document.getElementById('targetLocalBtn'),
  scanCanBtn: document.getElementById('scanCanBtn'),
  disconnectBtn: document.getElementById('disconnectBtn'),
  fwBanner: document.getElementById('fwBanner'),
};

const dutyColors = {
  low: getComputedStyle(document.documentElement).getPropertyValue('--green').trim(),
  mid: getComputedStyle(document.documentElement).getPropertyValue('--amber').trim(),
  high: getComputedStyle(document.documentElement).getPropertyValue('--red').trim(),
};
const DUTY_CIRCUMFERENCE = 502.65; // matches SVG circle r=80 (2 * PI * 80)

const readoutFields = {
  vIn: (v) => v.vIn.toFixed(1),
  currentMotor: (v) => v.currentMotorA.toFixed(1),
  currentIn: (v) => v.currentInA.toFixed(1),
  rpm: (v) => Math.round(v.rpm).toLocaleString(),
  tempMos: (v) => v.tempMosC.toFixed(0),
  tempMotor: (v) => v.tempMotorC.toFixed(0),
};

const client = new VescUsbClient();
let stopPolling = null;

// Cached vehicle geometry (poles/gear/wheel) so the dashboard's live
// speed readout doesn't need a fresh MCCONF read on every poll tick —
// just re-derived from ERPM in GET_VALUES. Refreshed whenever a page
// that could have changed it (Motor config, a profile apply, a Quick
// Adjust speed save) closes/completes.
let vehicleGeometry = null; // { motorPoles, gearRatio, wheelDiameterM }

async function refreshVehicleGeometry() {
  try {
    const raw = await client.requestMcConfRaw(null);
    const c = parseMcConfConfigFields(raw);
    if (c && c.motorPoles && c.gearRatio && c.wheelDiameterM) {
      vehicleGeometry = { motorPoles: c.motorPoles, gearRatio: c.gearRatio, wheelDiameterM: c.wheelDiameterM };
    }
  } catch (err) {
    log(`Couldn't read vehicle geometry for the speed readout: ${err.message}`, 'error');
  }
}

const wizard = new SetupWizard(els.wizardOverlay, client);
const pedalConfigPage = new PedalConfigPage(els.pedalConfigOverlay, client);
const motorConfigPage = new MotorConfigPage(els.motorConfigOverlay, client);
const rtDataPage = new RtDataPage(els.rtDataOverlay, client);
const profilesPage = new ProfilesPage(els.profilesOverlay, client);
const quickAdjustPanel = new QuickAdjustPanel(els.quickAdjustOverlay);

// Only one full-screen page (wizard or either config page) at a time —
// closing whatever else is open before opening a new one avoids two
// overlays stacking on top of each other.
function closeAllPages() {
  if (!els.wizardOverlay.hidden) wizard.close();
  if (!els.pedalConfigOverlay.hidden) pedalConfigPage.close();
  if (!els.motorConfigOverlay.hidden) motorConfigPage.close();
  if (!els.rtDataOverlay.hidden) rtDataPage.close();
  if (!els.profilesOverlay.hidden) profilesPage.close();
}

const resumePollingOnClose = () => {
  if (client.isConnected && !stopPolling) {
    stopPolling = client.startPolling(250);
  }
  if (client.isConnected) refreshVehicleGeometry();
};
wizard.onClose = resumePollingOnClose;
pedalConfigPage.onClose = resumePollingOnClose;
motorConfigPage.onClose = resumePollingOnClose;
rtDataPage.onClose = resumePollingOnClose;
profilesPage.onClose = resumePollingOnClose;
profilesPage.onProfilesChanged = renderProfileButtons;

els.newSetupBtn.addEventListener('click', () => {
  closeAllPages();
  if (stopPolling) { stopPolling(); stopPolling = null; }
  wizard.open();
});

els.pedalConfigBtn.addEventListener('click', () => {
  closeAllPages();
  if (stopPolling) { stopPolling(); stopPolling = null; }
  pedalConfigPage.open();
});

els.motorConfigBtn.addEventListener('click', () => {
  closeAllPages();
  if (stopPolling) { stopPolling(); stopPolling = null; }
  motorConfigPage.open();
});

els.rtDataBtn.addEventListener('click', () => {
  closeAllPages();
  if (stopPolling) { stopPolling(); stopPolling = null; }
  rtDataPage.open();
});

els.profilesBtn.addEventListener('click', () => {
  closeAllPages();
  if (stopPolling) { stopPolling(); stopPolling = null; }
  profilesPage.open();
});

// ---------- Profiles: 3 home-screen quick-switch buttons ----------
// Labels come straight from each saved profile's custom name. Applying
// writes MCCONF to both sides (direct + linked, if any) and APPCONF
// direct-only — same behavior as every other write in this app.

function renderProfileButtons() {
  const profiles = loadProfiles();
  const buttonEls = [
    document.getElementById('profileBtn0'),
    document.getElementById('profileBtn1'),
    document.getElementById('profileBtn2'),
  ];
  profiles.forEach((p, i) => {
    const btn = buttonEls[i];
    if (!btn) return;
    btn.textContent = p.name || `Profile ${i + 1}`;
    btn.onclick = () => applyProfileByIndex(i);
  });
}

async function applyProfileByIndex(i) {
  const profiles = loadProfiles();
  const profile = profiles[i];
  if (!profile) return;
  const errors = validateProfile(profile);
  if (errors.length) {
    log(`Can't apply "${profile.name}" — it's incomplete: ${errors[0]}`, 'error');
    return;
  }
  log(`Applying profile "${profile.name}"…`);
  try {
    const result = await applyProfile(client, profile);
    if (result.linkedError) {
      log(`Applied "${profile.name}" to this VESC, but the linked VESC failed: ${result.linkedError.message}`, 'error');
    } else {
      log(`Applied "${profile.name}".`);
    }
    refreshVehicleGeometry();
  } catch (err) {
    log(`Failed to apply "${profile.name}": ${err.message}`, 'error');
  }
}

renderProfileButtons();

// ---------- Quick Adjust: 4 home-screen single-field panels ----------

function pausePollingForPanel() {
  if (stopPolling) { stopPolling(); stopPolling = null; }
}

els.qaSpeedBtn.addEventListener('click', () => {
  pausePollingForPanel();
  quickAdjustPanel.onClose = resumePollingOnClose;
  quickAdjustPanel.open({
    title: 'Top speed',
    unit: 'mph',
    min: 1,
    max: 30,
    step: 0.5,
    readValue: async () => {
      const raw = await client.requestMcConfRaw(null);
      const c = parseMcConfConfigFields(raw);
      if (!c || !c.motorPoles || !c.gearRatio || !c.wheelDiameterM) {
        throw new Error('gear/wheel/pole data not set yet — run the setup wizard first');
      }
      vehicleGeometry = { motorPoles: c.motorPoles, gearRatio: c.gearRatio, wheelDiameterM: c.wheelDiameterM };
      return erpmToMps(c.maxErpm, c.motorPoles, c.gearRatio, c.wheelDiameterM) * MPS_TO_MPH;
    },
    writeValue: async (mph) => {
      if (!vehicleGeometry) throw new Error('gear/wheel/pole data not set yet — run the setup wizard first');
      const erpm = mpsToErpm(mph / MPS_TO_MPH, vehicleGeometry.motorPoles, vehicleGeometry.gearRatio, vehicleGeometry.wheelDiameterM);
      await client.writeMcConfBothSides([{ offset: MCCONF_OFFSETS.lMaxErpm, type: 'f32', value: erpm }]);
    },
  });
});

els.qaRampBtn.addEventListener('click', () => {
  pausePollingForPanel();
  quickAdjustPanel.onClose = resumePollingOnClose;
  quickAdjustPanel.open({
    title: 'Pedal ramp time',
    unit: 's',
    min: 0,
    max: 2,
    step: 0.01,
    readValue: async () => {
      const raw = await client.readAppConf();
      const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      return view.getFloat32(APPCONF_OFFSETS.rampTimePos);
    },
    writeValue: async (value) => {
      await client.writeAppConf([{ offset: APPCONF_OFFSETS.rampTimePos, type: 'f32', value }]);
    },
  });
});

els.qaMotorCurrentBtn.addEventListener('click', () => {
  pausePollingForPanel();
  quickAdjustPanel.onClose = resumePollingOnClose;
  quickAdjustPanel.open({
    title: 'Motor current max',
    unit: 'A',
    min: 1,
    max: 150,
    step: 1,
    readValue: async () => {
      const raw = await client.requestMcConfRaw(null);
      const c = parseMcConfConfigFields(raw);
      if (!c) throw new Error('MCCONF payload too short to decode');
      return c.currentMax;
    },
    writeValue: async (value) => {
      await client.writeMcConfBothSides([{ offset: MCCONF_OFFSETS.lCurrentMax, type: 'f32', value }]);
    },
  });
});

els.qaBatteryCurrentBtn.addEventListener('click', () => {
  pausePollingForPanel();
  quickAdjustPanel.onClose = resumePollingOnClose;
  quickAdjustPanel.open({
    title: 'Max battery current',
    unit: 'A',
    min: 1,
    max: 150,
    step: 1,
    readValue: async () => {
      const raw = await client.requestMcConfRaw(null);
      const c = parseMcConfConfigFields(raw);
      if (!c) throw new Error('MCCONF payload too short to decode');
      return c.inCurrentMax;
    },
    writeValue: async (value) => {
      await client.writeMcConfBothSides([{ offset: MCCONF_OFFSETS.lInCurrentMax, type: 'f32', value }]);
    },
  });
});

function setTarget(targetId) {
  client.targetCanId = targetId;
  els.targetLocalBtn.dataset.active = String(targetId == null);
  els.scanCanBtn.dataset.active = String(targetId != null);
  log(targetId == null ? 'Reading from this VESC.' : `Reading from linked VESC (CAN ID ${targetId}).`);
}

els.targetLocalBtn.addEventListener('click', () => setTarget(null));

client.onPingCanResult = (rawBytes) => {
  const hex = Array.from(rawBytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');
  console.debug('[vesc] PING_CAN raw:', hex);

  // Best-effort read: treat each byte as a candidate discovered CAN ID.
  // 255 shows up as a list terminator in some firmware builds, so drop it.
  const ids = Array.from(rawBytes).filter((b) => b !== 255);

  if (ids.length === 0) {
    log('CAN scan found nothing on the bus.', 'error');
    return;
  }

  // Single fixed "LINKED VESC" button — take the first discovered ID.
  setTarget(ids[0]);
};

els.scanCanBtn.addEventListener('click', () => {
  log('Scanning CAN bus…');
  client.requestPingCan().catch((err) => log(`Scan failed: ${err.message}`, 'error'));
});

client.onAppConfRaw = (rawBytes) => {
  const hex = Array.from(rawBytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');
  console.log('[vesc] APPCONF raw (%d bytes):', rawBytes.length, hex);
};

els.disconnectBtn.addEventListener('click', () => {
  client.disconnect();
});

function log(msg, kind = '') {
  const time = new Date().toLocaleTimeString([], { hour12: false });
  (kind === 'error' ? console.error : console.debug)(`[vesc] ${time}  ${msg}`);
}

function setStatus(state, text) {
  els.statusPill.dataset.state = state;
  els.statusText.textContent = text;
}

client.onLog = (msg) => log(msg);

// Raw-byte logging so we can validate GET_VALUES field offsets against
// real firmware. Prints to the dev console only (not the UI log) —
// open devtools (F12) and watch for "GET_VALUES raw:" lines. Once the
// parsed numbers on screen are confirmed correct against a multimeter
// and known RPM, this can come out.
client.onRawPacket = (commId, hex) => {
  if (commId === 4) console.debug('[vesc] GET_VALUES raw:', hex);
};

client.onConnectionChange = (connected) => {
  if (connected) {
    setStatus('connected', 'Connected');
    els.connectPanel.hidden = true;
    els.dashboardHero.hidden = false;
    els.telemetry.hidden = false;
    els.quickActions.hidden = false;
    els.setupEntry.hidden = false;
    els.motorTarget.hidden = false;
    els.disconnectBtn.hidden = false;
    stopPolling = client.startPolling(250);
    refreshVehicleGeometry();

    els.fwBanner.hidden = false;
    els.fwBanner.textContent = 'Reading firmware version…';
    client.requestFwVersion()
      .then((fw) => {
        if (!fw) { els.fwBanner.textContent = ''; els.fwBanner.hidden = true; return; }
        els.fwBanner.textContent = `Firmware ${fw.major}.${fw.minor}${fw.hwName ? ' · ' + fw.hwName : ''}`;
      })
      .catch((err) => {
        els.fwBanner.textContent = '';
        els.fwBanner.hidden = true;
        log(`Couldn't read firmware version: ${err.message}`, 'error');
      });
  } else {
    setStatus('idle', 'Not connected');
    els.connectPanel.hidden = false;
    els.dashboardHero.hidden = true;
    els.telemetry.hidden = true;
    els.quickActions.hidden = true;
    els.setupEntry.hidden = true;
    els.motorTarget.hidden = true;
    els.disconnectBtn.hidden = true;
    els.fwBanner.hidden = true;
    els.fwBanner.textContent = '';
    client.targetCanId = null;
    vehicleGeometry = null;
    els.speedValue.textContent = '–';
    if (stopPolling) { stopPolling(); stopPolling = null; }
  }
};

client.onValues = (values) => {
  for (const [id, fmt] of Object.entries(readoutFields)) {
    const el = document.getElementById(id);
    if (el) el.textContent = fmt(values);
  }
  const faultEl = document.getElementById('fault');
  const hasFault = values.faultCode !== 0;
  faultEl.textContent = hasFault ? `Code ${values.faultCode}` : 'None';
  els.faultReadout.classList.toggle('is-fault', hasFault);

  if (vehicleGeometry) {
    const mph = erpmToMps(values.rpm, vehicleGeometry.motorPoles, vehicleGeometry.gearRatio, vehicleGeometry.wheelDiameterM) * MPS_TO_MPH;
    els.speedValue.textContent = Math.max(0, mph).toFixed(1);
  }

  const dutyPct = Math.max(0, Math.min(100, values.dutyPct));
  const offset = DUTY_CIRCUMFERENCE * (1 - dutyPct / 100);
  els.dutyGaugeFill.style.strokeDashoffset = offset.toFixed(2);
  els.dutyGaugeValue.textContent = dutyPct.toFixed(0);
  els.dutyGaugeFill.style.stroke =
    dutyPct > 80 ? dutyColors.high : dutyPct > 45 ? dutyColors.mid : dutyColors.low;
};

els.connectBtn.addEventListener('click', async () => {
  els.connectBtn.disabled = true;
  setStatus('connecting', 'Connecting…');
  try {
    await client.connect();
  } catch (err) {
    setStatus('idle', 'Not connected');
    if (err.message === 'NO_WEB_SERIAL') {
      els.unsupportedBanner.hidden = false;
    } else if (err.name === 'NotFoundError') {
      log('No device selected.', '');
    } else {
      log(`Connect failed: ${err.message}`, 'error');
    }
  } finally {
    els.connectBtn.disabled = false;
  }
});

// Browser support check on load — don't wait for a failed connect
// attempt to tell the customer their browser can't do this at all.
if (!VescUsbClient.isSupported()) {
  els.unsupportedBanner.hidden = false;
  els.connectBtn.disabled = true;
  els.connectBtn.textContent = 'USB serial not available in this browser';
}

log('Ready.');
