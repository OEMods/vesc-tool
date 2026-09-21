/**
 * vesc-profiles.js
 * ------------------------------------------------------------------
 * "Profiles" = named tune presets (drive modes), stored locally in
 * the browser (localStorage — this is a per-device convenience, not
 * synced anywhere) — exactly 3 slots, custom names.
 *
 * Scope decision, worth stating plainly: this deliberately does NOT
 * include pedal ADC voltage calibration (min/max/center) or control
 * type, even though those are "parameters we offer in App config."
 * Those describe how one specific physical pedal is wired and
 * calibrated on this vehicle — not a driving preference. Switching
 * them based on a profile pick would be actively wrong, not just out
 * of scope: the pedal hasn't physically moved just because someone
 * tapped "Profile 2." Everything else offered on the Motor config and
 * App config pages that IS a genuine tuning choice — current limits,
 * battery cutoffs, speed/gearing, ramp time, traction control,
 * killswitch, throttle curve — is included below.
 *
 * Same MCCONF-offset verification caveat as everywhere else in this
 * app applies to applyProfile()'s MCCONF write — see the big comment
 * on MCCONF_OFFSETS in vesc-protocol.js.
 * ------------------------------------------------------------------
 */

import { MCCONF_OFFSETS, APPCONF_OFFSETS, batteryVoltages, mpsToErpm } from './vesc-protocol.js';

const STORAGE_KEY = 'oemods_vesc_profiles_v1';
const MPS_TO_MPH = 2.2369362921;
const ABS_CURRENT_MAX_A = 150;      // same fixed values Motor Config writes behind the scenes
const TEMP_CUTOFF_C = 80;
const TEMP_ACCEL_DEC_FRAC = 0.15;

// Declarative field list, shared by the Profiles editor page and the
// quick-adjust panels — one source of truth for label/type/range
// instead of hand-writing near-identical form markup per field.
export const PROFILE_FIELDS = [
  { group: 'mcconf', key: 'motorCurrentMax', label: 'Motor Current Max (A)', type: 'number', min: 1, max: 150 },
  { group: 'mcconf', key: 'maxBatteryCurrent', label: 'Max Battery Current (A)', type: 'number', min: 1, max: 150 },
  { group: 'mcconf', key: 'motorCurrentMaxBrake', label: 'Motor Current Max Brake (A)', type: 'number', min: 1, max: 150 },
  { group: 'mcconf', key: 'batteryCurrentMaxRegen', label: 'Battery Current Max Regen (A)', type: 'number', min: -50, max: 0 },
  { group: 'mcconf', key: 'batteryS', label: 'Battery pack (S)', type: 'battery' },
  { group: 'mcconf', key: 'wheelDiameterMm', label: 'Tire diameter (mm)', type: 'number', min: 1, max: 2000 },
  { group: 'mcconf', key: 'gearRatio', label: 'Gear ratio', type: 'number', min: 0.1, max: 50, step: 0.01 },
  { group: 'mcconf', key: 'motorPoles', label: 'Motor poles', type: 'number', min: 2, max: 64 },
  { group: 'mcconf', key: 'speedLimitMph', label: 'Top speed (mph)', type: 'number', min: 1, max: 30, step: 0.5 },
  { group: 'mcconf', key: 'reverseErpm', label: 'Reverse speed limit (ERPM)', type: 'number', min: -5000, max: 0, step: 100 },
  { group: 'mcconf', key: 'erpmLimitStartPct', label: 'ERPM limit start (%)', type: 'number', min: 50, max: 99 },
  { group: 'mcconf', key: 'dutyCycleMaxPct', label: 'Duty Cycle Max (%)', type: 'number', min: 1, max: 100 },
  { group: 'appconf', key: 'rampPos', label: 'Ramp time (positive, s)', type: 'number', min: 0, max: 2, step: 0.01 },
  { group: 'appconf', key: 'rampNeg', label: 'Ramp time (negative, s)', type: 'number', min: 0, max: 2, step: 0.01 },
  { group: 'appconf', key: 'tc', label: 'Traction control', type: 'select', options: [[0, 'Off'], [1, 'On']] },
  { group: 'appconf', key: 'killSwMode', label: 'Killswitch mode', type: 'select', options: [[0, 'Off'], [1, 'PPM Low'], [2, 'PPM High']] },
  { group: 'appconf', key: 'throttleExp', label: 'Throttle curve exponent', type: 'number', min: -0.9, max: 2, step: 0.05 },
  { group: 'appconf', key: 'throttleExpMode', label: 'Throttle curve mode', type: 'select', options: [[0, 'Expo'], [1, 'Natural'], [2, 'Poly']] },
];

export function defaultProfile(name) {
  return {
    name,
    motorCurrentMax: 65, maxBatteryCurrent: 35, motorCurrentMaxBrake: 45, batteryCurrentMaxRegen: -4,
    batteryS: null, wheelDiameterMm: null, gearRatio: null, motorPoles: null,
    speedLimitMph: 10, reverseErpm: -2500, erpmLimitStartPct: 95, dutyCycleMaxPct: 95,
    rampPos: 0.3, rampNeg: 0.1, tc: 0, killSwMode: 0, throttleExp: 0, throttleExpMode: 0,
  };
}

function defaultProfiles() {
  return [defaultProfile('Profile 1'), defaultProfile('Profile 2'), defaultProfile('Profile 3')];
}

/** Load the 3 saved profiles, or 3 fresh defaults if none are saved yet
 * or the stored data doesn't look right (never crash the page over it). */
export function loadProfiles() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultProfiles();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== 3) return defaultProfiles();
    // Merge onto a fresh default so a profile saved before a field was
    // added still has every key, rather than silently missing one.
    return parsed.map((p, i) => ({ ...defaultProfile(`Profile ${i + 1}`), ...p }));
  } catch (err) {
    console.warn('[vesc] Could not read saved profiles, using defaults:', err.message);
    return defaultProfiles();
  }
}

/** Persist all 3 profiles. Returns false (and logs) if storage failed
 * (private browsing, storage full, disabled) rather than throwing —
 * callers should tell the person plainly rather than losing the edit
 * silently. */
export function saveProfiles(profiles) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
    return true;
  } catch (err) {
    console.warn('[vesc] Could not save profiles:', err.message);
    return false;
  }
}

/** Same validation rules as the Motor Config page's own _validate —
 * kept in sync deliberately, since a profile is missing exactly the
 * same information a live Motor Config write would need. */
export function validateProfile(p) {
  const errors = [];
  if (!p.name || !p.name.trim()) errors.push('Give this profile a name.');
  if (Number.isNaN(p.motorCurrentMax) || p.motorCurrentMax <= 0) errors.push('Enter a Motor Current Max.');
  if (Number.isNaN(p.maxBatteryCurrent) || p.maxBatteryCurrent <= 0) errors.push('Enter a Max Battery Current.');
  if (!errors.length && p.maxBatteryCurrent < p.motorCurrentMax / 2) {
    errors.push('Max Battery Current cannot be less than half of Motor Current Max.');
  }
  if (Number.isNaN(p.motorCurrentMaxBrake) || p.motorCurrentMaxBrake <= 0) errors.push('Enter a Motor Current Max Brake.');
  if (Number.isNaN(p.batteryCurrentMaxRegen) || p.batteryCurrentMaxRegen > 0) errors.push('Battery Current Max Regen must be zero or negative.');
  if (p.batteryS == null) errors.push('Select a battery pack size.');
  if (!p.wheelDiameterMm || p.wheelDiameterMm <= 0) errors.push('Enter a tire diameter.');
  if (!p.gearRatio || p.gearRatio <= 0) errors.push('Enter a gear ratio.');
  if (!p.motorPoles || p.motorPoles <= 0) errors.push('Enter a motor pole count.');
  if (Number.isNaN(p.reverseErpm) || p.reverseErpm > 0 || p.reverseErpm < -5000) {
    errors.push('Reverse speed limit must be between -5000 and 0 ERPM.');
  }
  if (Number.isNaN(p.erpmLimitStartPct) || p.erpmLimitStartPct < 50 || p.erpmLimitStartPct > 99) {
    errors.push('ERPM limit start must be between 50% and 99%.');
  }
  if (Number.isNaN(p.dutyCycleMaxPct) || p.dutyCycleMaxPct <= 0 || p.dutyCycleMaxPct > 100) {
    errors.push('Duty Cycle Max must be between 0% and 100%.');
  }
  return errors;
}

function buildMcConfPatches(p) {
  const v = batteryVoltages(p.batteryS);
  const mps = p.speedLimitMph / MPS_TO_MPH;
  const maxErpm = mpsToErpm(mps, p.motorPoles, p.gearRatio, p.wheelDiameterMm / 1000);
  return [
    { offset: MCCONF_OFFSETS.lCurrentMax, type: 'f32', value: p.motorCurrentMax },
    { offset: MCCONF_OFFSETS.lCurrentMin, type: 'f32', value: -Math.abs(p.motorCurrentMaxBrake) },
    { offset: MCCONF_OFFSETS.lInCurrentMax, type: 'f32', value: p.maxBatteryCurrent },
    { offset: MCCONF_OFFSETS.lInCurrentMin, type: 'f32', value: p.batteryCurrentMaxRegen },
    { offset: MCCONF_OFFSETS.lAbsCurrentMax, type: 'f32', value: ABS_CURRENT_MAX_A },
    { offset: MCCONF_OFFSETS.lMinVin, type: 'i16', value: v.minVin, scale: 10 },
    { offset: MCCONF_OFFSETS.lMaxVin, type: 'i16', value: v.maxVin, scale: 10 },
    { offset: MCCONF_OFFSETS.lBatteryCutStart, type: 'i16', value: v.cutStart, scale: 10 },
    { offset: MCCONF_OFFSETS.lBatteryCutEnd, type: 'i16', value: v.cutEnd, scale: 10 },
    { offset: MCCONF_OFFSETS.lMaxErpm, type: 'f32', value: maxErpm },
    { offset: MCCONF_OFFSETS.lMinErpm, type: 'f32', value: p.reverseErpm },
    { offset: MCCONF_OFFSETS.lErpmStart, type: 'i16', value: p.erpmLimitStartPct / 100, scale: 10000 },
    { offset: MCCONF_OFFSETS.lMaxDuty, type: 'i16', value: p.dutyCycleMaxPct / 100, scale: 10000 },
    { offset: MCCONF_OFFSETS.lTempFetStart, type: 'u8', value: TEMP_CUTOFF_C },
    { offset: MCCONF_OFFSETS.lTempMotorStart, type: 'u8', value: TEMP_CUTOFF_C },
    { offset: MCCONF_OFFSETS.lTempAccelDec, type: 'i16', value: TEMP_ACCEL_DEC_FRAC, scale: 10000 },
    { offset: MCCONF_OFFSETS.siWheelDiameter, type: 'f32', value: p.wheelDiameterMm / 1000 },
    { offset: MCCONF_OFFSETS.siGearRatio, type: 'f32', value: p.gearRatio },
    { offset: MCCONF_OFFSETS.siMotorPoles, type: 'u8', value: p.motorPoles },
  ];
}

function buildAppConfPatches(p) {
  return [
    { offset: APPCONF_OFFSETS.rampTimePos, type: 'f32', value: p.rampPos },
    { offset: APPCONF_OFFSETS.rampTimeNeg, type: 'f32', value: p.rampNeg },
    { offset: APPCONF_OFFSETS.tc, type: 'u8', value: p.tc },
    { offset: APPCONF_OFFSETS.killSwMode, type: 'u8', value: p.killSwMode },
    { offset: APPCONF_OFFSETS.throttleExp, type: 'f32', value: p.throttleExp },
    { offset: APPCONF_OFFSETS.throttleExpMode, type: 'u8', value: p.throttleExpMode },
  ];
}

/**
 * Apply a profile to the connected board(s). MCCONF fields (current
 * limits, battery, speed/gearing) go to BOTH motors via
 * writeMcConfBothSides, same as Motor Config's own writes — those are
 * per-motor settings, need to match on both sides of a dual-motor
 * board. APPCONF fields (ramp time, traction control, killswitch,
 * throttle curve) go direct only, matching how App (pedal) config has
 * always written them: those live on whichever VESC is actually
 * running the pedal-decode thread, not "both sides" the way motor
 * current limits are.
 *
 * Throws with a clear message on validation failure or a write
 * failure — never partially applies without saying so. Returns the
 * writeMcConfBothSides result ({direct, linked, linkedError?}) so the
 * caller can report exactly what happened.
 */
export async function applyProfile(client, profile) {
  const errors = validateProfile(profile);
  if (errors.length) throw new Error(errors.join(' '));
  const mcResult = await client.writeMcConfBothSides(buildMcConfPatches(profile));
  await client.writeAppConf(buildAppConfPatches(profile));
  return mcResult;
}
