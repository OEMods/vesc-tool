/**
 * vesc-protocol.js
 * ------------------------------------------------------------------
 * Binary packet layer for VESC's UART/BLE comm protocol.
 * This is a from-scratch JS reimplementation of the framing VESC
 * Tool and BLDC firmware use — NOT a port of copyrighted source.
 *
 * Packet formats:
 *   Short: 0x02 | len(1B) | payload(len B) | crc_hi | crc_lo | 0x03
 *   Long:  0x03 | len_hi | len_lo (payload len 0-65535) | payload | crc_hi | crc_lo | 0x03
 *
 * CRC is CRC16-CCITT (XModem variant, poly 0x1021, init 0x0000)
 * computed over the payload bytes only.
 *
 * IMPORTANT: COMM_GET_VALUES field order/count has changed across
 * BLDC firmware versions (new fields get appended). The parser below
 * covers the common/stable prefix of fields. Before shipping to a
 * client, confirm field order against the exact firmware version
 * their VESC is running — get a real capture and diff it. Flagging
 * this now so it doesn't bite us later.
 * ------------------------------------------------------------------
 */

export const COMM = {
  FW_VERSION: 0,
  GET_VALUES: 4,
  SET_DUTY: 5,
  SET_CURRENT: 6,
  SET_RPM: 8,
  GET_MCCONF: 14,
  SET_MCCONF: 13,
  GET_MCCONF_DEFAULT: 15,
  GET_APPCONF: 17,
  SET_APPCONF: 16,
  GET_APPCONF_DEFAULT: 18,
  DETECT_MOTOR_R_L: 25,
  DETECT_MOTOR_FLUX_LINKAGE: 26,
  DETECT_ENCODER: 27,
  DETECT_HALL_FOC: 28,
  ALIVE: 30,
  GET_DECODED_ADC: 32,
  FORWARD_CAN: 34,
  DETECT_MOTOR_FLUX_LINKAGE_OPENLOOP: 57,
  DETECT_APPLY_ALL_FOC: 58,
  PING_CAN: 62,
};

/**
 * Real mc_fault_code enum from firmware source (datatypes.h, current
 * mainline) — not guessed labels. Shared by the RT Data fault log and
 * the full motor-detection result decoder (DETECT_APPLY_ALL_FOC can
 * return a fault offset by -100, see parseDetectApplyAllFoc below).
 */
export const FAULT_NAMES = {
  0: 'None', 1: 'Over voltage', 2: 'Under voltage', 3: 'Gate driver fault',
  4: 'Absolute over current', 5: 'Over temperature (controller)', 6: 'Over temperature (motor)',
  7: 'Gate driver over voltage', 8: 'Gate driver under voltage', 9: 'MCU under voltage',
  10: 'Booting from watchdog reset', 11: 'Encoder SPI fault',
  12: 'Encoder sin/cos below min amplitude', 13: 'Encoder sin/cos above max amplitude',
  14: 'Flash corruption', 15: 'Current sensor 1 offset fault', 16: 'Current sensor 2 offset fault',
  17: 'Current sensor 3 offset fault', 18: 'Unbalanced currents', 19: 'Brake fault',
  20: 'Resolver loss of tracking', 21: 'Resolver DOS', 22: 'Resolver loss of signal',
  23: 'Flash corruption (app config)', 24: 'Flash corruption (motor config)',
  25: 'Encoder: no magnet detected', 26: 'Encoder: magnet too strong', 27: 'Phase filter fault',
};
export const faultName = (code) => FAULT_NAMES[code] ?? `Unknown fault (code ${code})`;

/**
 * Byte offsets into the raw COMM_GET_APPCONF/SET_APPCONF payload,
 * confirmed against a real capture off Scott's Flipsky 75100 Dual on
 * firmware 6.05 (see README for the verification process — matched
 * against known defaults: timeout_msec=1000, PPM pulse 1.0/2.0/1.5ms,
 * app_uart_baudrate=115200, and confirmed app_to_use=5/ADC_UART
 * against the board's actual live setting at capture time).
 *
 * IMPORTANT: this firmware build has one extra byte around offset 32
 * that a newer reference confgenerator.c source doesn't have — these
 * offsets are specific to this exact field layout. Re-verify (same
 * capture-and-diff process, see README) before trusting them against
 * a different firmware version or hardware target.
 */
export const APPCONF_OFFSETS = {
  // Cross-checked, not just guessed: byte 4 (right after the 4-byte
  // signature) is the very first field in current mainline
  // confgenerator.c's serialize order, and computing forward from
  // there lands app_to_use at exactly byte 33 — matching the
  // independently, real-hardware-confirmed offset below to the byte.
  // That agreement is what makes this offset trustworthy without its
  // own separate hardware capture.
  controllerId: 4,     // uint8 — appconf->controller_id ("VESC ID" in VESC Tool)
  // Added this session: killSwMode sits immediately before app_to_use
  // in current mainline's serialize order (servo_out_enable, then
  // kill_sw_mode, then app_to_use — confirmed by reading
  // confgenerator_serialize_appconf directly). Walking byte-by-byte
  // from byte 4 through that exact field order lands app_to_use at
  // byte 33 with ZERO fudging needed — matching the real-hardware-
  // verified offset below to the byte. That's the same cross-check
  // that already validated controllerId, now also covering
  // killSwMode since it's the field directly adjacent: getting your
  // next-door neighbor's address right is good evidence you have the
  // right house. This is likely also the explanation for the "one
  // extra byte around offset 32" this build has vs. the OLDER
  // reference source used earlier in the project (see README) —
  // kill_sw_mode is probably that extra byte, added to firmware after
  // that older reference was written.
  killSwMode: 32,      // uint8 — KILL_SW_MODE enum (0=Disabled,1=PPM_LOW,2=PPM_HIGH,3=ADC2_LOW,4=ADC2_HIGH,5=ADC3_LOW,6=ADC3_HIGH,7=SWDIO_LOW,8=SWDIO_HIGH,9=SWCLK_LOW,10=SWCLK_HIGH)
  appToUse: 33,        // uint8 — app_use enum (0=None,1=PPM,2=ADC,3=UART,4=PPM_UART,5=ADC_UART,...)
  adcCtrlType: 90,      // uint8 — ADC_CTRL_TYPE_* enum
  adcVoltageStart: 95,  // int16 BE, /1000 -> volts (pedal idle/min)
  adcVoltageEnd: 97,    // int16 BE, /1000 -> volts (pedal full-press/max)
  adcVoltageMin: 99,    // int16 BE, /1000 -> volts (safety floor)
  adcVoltageMax: 101,   // int16 BE, /1000 -> volts (safety ceiling)
  adcVoltageCenter: 103, // int16 BE, /1000 -> volts (brake/neutral point, meaning depends on ctrl_type)
  adcVoltage2Start: 105, // int16 BE, /1000 -> volts (second pedal/brake channel)
  adcVoltage2End: 107,   // int16 BE, /1000 -> volts
  // Confirmed in a second verification pass (see README) using known
  // firmware defaults as landmarks — tc_max_diff decoded to exactly
  // 3000.0 (the default the person confirmed), app_uart_baudrate to
  // exactly 115200, ramp times to sane 0.3s/0.1s, multi_esc to true
  // (correct for a dual-motor board). These are raw float32 (IEEE-754,
  // not the /1000 fixed-point format the voltage fields use above).
  throttleExp: 114,     // float32 raw — throttle curve exponent
  throttleExpBrake: 118, // float32 raw — brake curve exponent
  throttleExpMode: 122,  // uint8 — THR_EXP_EXPO=0, THR_EXP_NATURAL=1, THR_EXP_POLY=2
  rampTimePos: 123,      // float32 raw — seconds, ramp-up
  rampTimeNeg: 127,      // float32 raw — seconds, ramp-down
  tc: 132,               // uint8 bool — traction control on/off
  tcMaxDiff: 133,        // float32 raw — ERPM mismatch threshold
};

/**
 * Apply a list of patches to a copy of a raw config blob. Blob-agnostic
 * despite the name — also reused as-is for MCCONF writes (battery
 * cutoffs, speed/gearing) since the byte-level patch types are
 * identical (float16's fixed-point encoding is exactly what the 'i16'
 * type already does with a scale). Everything not explicitly patched
 * passes through byte-for-byte unchanged — this is what makes patching
 * safe without having verified every field in the struct.
 * patches: [{ offset, type: 'u8' | 'i16' | 'f32', value, scale? }]
 */
export function applyAppConfPatches(blob, patches) {
  const out = new Uint8Array(blob); // copy — never mutate the original read
  const view = new DataView(out.buffer);
  for (const p of patches) {
    if (p.type === 'u8') {
      out[p.offset] = p.value & 0xff;
    } else if (p.type === 'i16') {
      view.setInt16(p.offset, Math.round(p.value * (p.scale ?? 1)));
    } else if (p.type === 'f32') {
      view.setFloat32(p.offset, p.value);
    } else {
      throw new Error(`Unknown APPCONF patch type: ${p.type}`);
    }
  }
  return out;
}

/**
 * Byte offsets into the raw COMM_GET_MCCONF payload for just the
 * handful of fields needed to mirror VESC Tool's post-detection
 * "Detection Result" popup — NOT a full MCCONF decode (arbitrary
 * field editing on the Motor Config page is still raw-hex-only, see
 * README). Computed by walking confgenerator_serialize_mcconf's
 * field order in current mainline firmware source byte-by-byte
 * (every field's exact width: float32_auto=4B, float16=2B, u8=1B —
 * see buffer.c) — mechanical, not guessed, but only cross-checked
 * once so far (see controllerId's note above; app_to_use landed
 * exactly right computing the same way through APPCONF). Treat these
 * the way any not-yet-hardware-verified offset gets treated here:
 * fine to trust for a read-only display, re-verify against a real
 * capture (same landmark-matching process as APPCONF) before ever
 * writing to any of these bytes directly.
 *
 * float32_auto decodes as ordinary IEEE-754 float32 for all normal
 * (non-subnormal) values — confirmed by working through buffer.c's
 * bit-packing math, so plain DataView.getFloat32 is correct here,
 * no custom decode needed.
 */
export const MCCONF_MOTOR_OFFSETS = {
  currentMax: 8,        // float32 (IEEE-754) — l_current_max, amps ("Motor current" after detection)
  focMotorL: 158,       // float32 (IEEE-754) — foc_motor_l, henries
  focMotorLdLqDiff: 162, // float32 (IEEE-754) — foc_motor_ld_lq_diff, henries
  focMotorR: 166,       // float32 (IEEE-754) — foc_motor_r, ohms
  focMotorFluxLinkage: 170, // float32 (IEEE-754) — foc_motor_flux_linkage, weber
  focTempComp: 241,     // uint8 bool — foc_temp_comp
};

/**
 * Battery-cutoff and speed/gearing fields, added for the wizard's
 * battery and speed steps. Derived the SAME mechanical way as
 * MCCONF_MOTOR_OFFSETS above (walking confgenerator_serialize_mcconf's
 * field order byte-by-byte in current mainline source) — but these
 * specific fields have had ZERO real-hardware capture cross-check,
 * unlike controllerId/app_to_use in APPCONF. Trusting these for a
 * WRITE (not just a read) is a bigger risk than anything shipped so
 * far in this project: a wrong offset here doesn't just show a wrong
 * number on screen, it overwrites 2-4 real bytes of a customer's
 * motor config on flash. Do not treat this as verified. Re-derive
 * against a real capture (same landmark-matching process used for
 * APPCONF) before this goes out to an actual customer kit — the UI
 * built on top of this says so too, this isn't just a code comment.
 *
 * Field widths, per buffer.c: float32_auto behaves as plain IEEE-754
 * float32 (proven this session, see MCCONF_MOTOR_OFFSETS comment
 * above) — that's what's used for the ERPM and si_* fields below.
 * float16 is a 2-byte fixed-point value (raw/scale = real value) —
 * used for the voltage fields, all with scale 10 (0.1V resolution).
 */
export const MCCONF_OFFSETS = {
  // This block was re-derived this session by reading
  // confgenerator_serialize_mcconf directly (source saved locally),
  // field-by-field from ind=0 (the leading uint32 signature) rather
  // than spot-checking individual fields — a stronger derivation than
  // the original pass, and it landed on the exact same byte numbers
  // for every field that pass already had (lMinErpm/lMaxErpm/lMinVin/
  // lMaxVin/lBatteryCutStart/lBatteryCutEnd/lBatteryRegenCutStart/
  // lBatteryRegenCutEnd all matched to the byte) — a real (if still
  // not hardware-real) cross-check, not just a repeat of the same
  // guess. Still NOT checked against an actual capture off real
  // hardware, unlike every APPCONF offset — see the big caveat above
  // this object and in README before trusting any of this on a write
  // to a real customer kit.
  lCurrentMax: 8,           // float32 (IEEE-754) — l_current_max, amps (Motor Current Max / phase amps)
  lCurrentMin: 12,          // float32 (IEEE-754) — l_current_min, amps, STORED NEGATIVE (Motor Current Max Brake, as -magnitude)
  lInCurrentMax: 16,        // float32 (IEEE-754) — l_in_current_max, amps (Max Battery Current, per side)
  lInCurrentMin: 20,        // float32 (IEEE-754) — l_in_current_min, amps, negative (Battery Current Max Regen)
  lAbsCurrentMax: 28,       // float32 (IEEE-754) — l_abs_current_max, amps (hard ceiling, fixed at 150A by this app)
  lMinErpm: 32,             // float32 (IEEE-754) — l_min_erpm (negative, reverse speed limit)
  lMaxErpm: 36,             // float32 (IEEE-754) — l_max_erpm (forward speed limit)
  lErpmStart: 40,           // float16, scale 10000 — l_erpm_start, fraction 0-1 (ERPM limit start, e.g. 0.95 = 95%)
  lMinVin: 50,              // float16, scale 10 — l_min_vin, volts (absolute low-voltage fault floor)
  lMaxVin: 52,              // float16, scale 10 — l_max_vin, volts (absolute high-voltage fault ceiling)
  lBatteryCutStart: 54,     // float16, scale 10 — l_battery_cut_start, volts (soft current taper begins)
  lBatteryCutEnd: 56,       // float16, scale 10 — l_battery_cut_end, volts (current tapered to zero)
  lBatteryRegenCutStart: 58, // float16, scale 10 — l_battery_regen_cut_start, volts (not written by this app)
  lBatteryRegenCutEnd: 60,   // float16, scale 10 — l_battery_regen_cut_end, volts (not written by this app)
  lTempFetStart: 63,        // uint8 — l_temp_fet_start, °C (MOSFET limp-mode start, fixed at 80 by this app)
  lTempFetEnd: 64,          // uint8 — l_temp_fet_end, °C (MOSFET hard cutoff — not written by this app)
  lTempMotorStart: 65,      // uint8 — l_temp_motor_start, °C (motor limp-mode start, fixed at 80 by this app)
  lTempMotorEnd: 66,        // uint8 — l_temp_motor_end, °C (motor hard cutoff — not written by this app)
  lTempAccelDec: 67,        // float16, scale 10000 — l_temp_accel_dec, fraction (fixed at 0.15 by this app)
  lMinDuty: 69,             // float16, scale 10000 — l_min_duty, fraction (not written by this app)
  lMaxDuty: 71,             // float16, scale 10000 — l_max_duty, fraction (Duty Cycle Max, e.g. 0.95 = 95%)
  siMotorPoles: 452,        // uint8 — si_motor_poles
  siGearRatio: 453,         // float32 (IEEE-754) — si_gear_ratio
  siWheelDiameter: 457,     // float32 (IEEE-754), METERS — si_wheel_diameter
};

/**
 * Decode just the battery/speed-setup fields out of a raw MCCONF blob
 * (command byte already stripped). Used to prefill the wizard's speed
 * step with the board's current gear ratio/pole count rather than
 * asking the person to guess them blind. See MCCONF_OFFSETS above for
 * the verification-status caveat. Returns null if the blob is shorter
 * than expected.
 */
export function parseMcConfSetupFields(raw) {
  if (raw.length < MCCONF_OFFSETS.siWheelDiameter + 4) {
    console.warn('[vesc] MCCONF payload shorter than expected for setup fields', raw.length);
    return null;
  }
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  return {
    minErpm: view.getFloat32(MCCONF_OFFSETS.lMinErpm),
    maxErpm: view.getFloat32(MCCONF_OFFSETS.lMaxErpm),
    minVin: view.getInt16(MCCONF_OFFSETS.lMinVin) / 10,
    maxVin: view.getInt16(MCCONF_OFFSETS.lMaxVin) / 10,
    batteryCutStart: view.getInt16(MCCONF_OFFSETS.lBatteryCutStart) / 10,
    batteryCutEnd: view.getInt16(MCCONF_OFFSETS.lBatteryCutEnd) / 10,
    motorPoles: raw[MCCONF_OFFSETS.siMotorPoles],
    gearRatio: view.getFloat32(MCCONF_OFFSETS.siGearRatio),
    wheelDiameterM: view.getFloat32(MCCONF_OFFSETS.siWheelDiameter),
  };
}

/**
 * Decode every field the Motor Config page reads/writes/compares —
 * a superset of parseMcConfSetupFields (which stays as-is, still used
 * by the wizard's speed step). Same offsets, same not-hardware-verified
 * caveat.
 */
export function parseMcConfConfigFields(raw) {
  if (raw.length < MCCONF_OFFSETS.siWheelDiameter + 4) {
    console.warn('[vesc] MCCONF payload shorter than expected for config-page fields', raw.length);
    return null;
  }
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  return {
    currentMax: view.getFloat32(MCCONF_OFFSETS.lCurrentMax),
    currentMin: view.getFloat32(MCCONF_OFFSETS.lCurrentMin),
    inCurrentMax: view.getFloat32(MCCONF_OFFSETS.lInCurrentMax),
    inCurrentMin: view.getFloat32(MCCONF_OFFSETS.lInCurrentMin),
    absCurrentMax: view.getFloat32(MCCONF_OFFSETS.lAbsCurrentMax),
    minErpm: view.getFloat32(MCCONF_OFFSETS.lMinErpm),
    maxErpm: view.getFloat32(MCCONF_OFFSETS.lMaxErpm),
    erpmStart: view.getInt16(MCCONF_OFFSETS.lErpmStart) / 10000,
    minVin: view.getInt16(MCCONF_OFFSETS.lMinVin) / 10,
    maxVin: view.getInt16(MCCONF_OFFSETS.lMaxVin) / 10,
    batteryCutStart: view.getInt16(MCCONF_OFFSETS.lBatteryCutStart) / 10,
    batteryCutEnd: view.getInt16(MCCONF_OFFSETS.lBatteryCutEnd) / 10,
    tempFetStart: raw[MCCONF_OFFSETS.lTempFetStart],
    tempFetEnd: raw[MCCONF_OFFSETS.lTempFetEnd],
    tempMotorStart: raw[MCCONF_OFFSETS.lTempMotorStart],
    tempMotorEnd: raw[MCCONF_OFFSETS.lTempMotorEnd],
    tempAccelDec: view.getInt16(MCCONF_OFFSETS.lTempAccelDec) / 10000,
    maxDuty: view.getInt16(MCCONF_OFFSETS.lMaxDuty) / 10000,
    motorPoles: raw[MCCONF_OFFSETS.siMotorPoles],
    gearRatio: view.getFloat32(MCCONF_OFFSETS.siGearRatio),
    wheelDiameterM: view.getFloat32(MCCONF_OFFSETS.siWheelDiameter),
  };
}

/**
 * Canonical ERPM<->speed conversion, sourced directly from firmware
 * (the COMM_SET_MCCONF_TEMP_SETUP handler in commands.c):
 *   fact = (poles/2) * 60 * gear_ratio / (wheel_diameter_m * PI)
 *   erpm = speed_m_per_s * fact
 * wheelDiameterM must be in meters, matching si_wheel_diameter's own
 * units — mm inputs from the UI get converted before calling this.
 */
export function erpmSpeedFactor(motorPoles, gearRatio, wheelDiameterM) {
  return ((motorPoles / 2) * 60 * gearRatio) / (wheelDiameterM * Math.PI);
}
export function erpmToMps(erpm, motorPoles, gearRatio, wheelDiameterM) {
  return erpm / erpmSpeedFactor(motorPoles, gearRatio, wheelDiameterM);
}
export function mpsToErpm(mps, motorPoles, gearRatio, wheelDiameterM) {
  return mps * erpmSpeedFactor(motorPoles, gearRatio, wheelDiameterM);
}

/**
 * Belt-drive pulley picker, for kits (all of Scott's) that gear down
 * through a motor pulley + hub pulley rather than a chain/gearbox
 * ratio someone would otherwise have to know or measure by hand.
 * gear_ratio (si_gear_ratio, what MCCONF actually stores and what
 * erpmSpeedFactor/mpsToErpm/erpmToMps above take) is motor turns per
 * wheel turn — for a belt, that's simply hub teeth / motor teeth,
 * same relationship as a chain sprocket pair (belt speed is constant
 * across both pulleys, so teeth count and rotation speed are
 * inversely proportional).
 */
export const PULLEY_MOTOR_TEETH_OPTIONS = Array.from({ length: 20 - 12 + 1 }, (_, i) => i + 12); // 12T-20T
export const PULLEY_HUB_TEETH_OPTIONS = Array.from({ length: 85 - 58 + 1 }, (_, i) => i + 58);   // 58T-85T
export function pulleyGearRatio(motorTeeth, hubTeeth) {
  if (!motorTeeth || !hubTeeth) return null;
  return hubTeeth / motorTeeth;
}
/**
 * Best-effort reverse lookup for prefilling the two dropdowns from a
 * gear ratio already on the board (from a live read, or from before
 * this calculator existed) — there's no exact inverse for a single
 * ratio number, so this finds the in-range pulley pair whose ratio is
 * closest, for the UI to show as an approximation rather than exact.
 */
export function closestPulleyPair(targetRatio) {
  if (!targetRatio || targetRatio <= 0) return null;
  let best = null;
  let bestDiff = Infinity;
  for (const motorTeeth of PULLEY_MOTOR_TEETH_OPTIONS) {
    for (const hubTeeth of PULLEY_HUB_TEETH_OPTIONS) {
      const diff = Math.abs(hubTeeth / motorTeeth - targetRatio);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = { motorTeeth, hubTeeth, ratio: hubTeeth / motorTeeth };
      }
    }
  }
  return best;
}

/**
 * Battery combo table for the wizard's battery step. 5S/10S/15S/20S
 * map to 1x/2x/3x/4x M18-or-DeWalt-20V packs in series (confirmed by
 * Scott: these packs are 5S, so N packs in series = 5N-S — the naming
 * convention here follows that directly). Other S-counts get no
 * invented combo name, just the plain "XS" label — making up a combo
 * name for an S-count nobody actually stacks that way would be more
 * confusing than the "S" jargon this is trying to fix.
 *
 * Nominal voltage uses 3.6V/cell, which is also what makes "M18"
 * literal: 5 cells x 3.6V = 18V nominal.
 *
 * Cutoff values below are NOT what was originally requested (25%
 * start / 28% end of nominal) — those numbers are both far too low
 * for lithium (real cutoffs sit at ~76-92% of nominal, not ~25-28%)
 * and backwards (end must be a lower voltage than start, not higher).
 * Using them as given would risk over-discharging/damaging customer
 * packs. These are standard li-ion cutoffs instead: 3.3V/cell where
 * the soft current taper begins, 3.0V/cell where it reaches zero —
 * see README and the battery step's own on-screen note.
 */
export const BATTERY_COMBO_NAMES = {
  5: '1x M18 / DeWalt 20V',
  10: '2x M18 / DeWalt 20V',
  15: '3x M18 / DeWalt 20V',
  20: '4x M18 / DeWalt 20V',
};
export function batteryComboLabel(sCount) {
  const combo = BATTERY_COMBO_NAMES[sCount];
  return combo ? `${sCount}S (${combo})` : `${sCount}S`;
}
export function batteryVoltages(sCount) {
  const perCellNominal = 3.6;
  const perCellCutStart = 3.3;
  const perCellCutEnd = 3.0;
  // l_min_vin/l_max_vin (MCCONF_OFFSETS.lMinVin/lMaxVin) are firmware's
  // absolute, pack-agnostic hard fault floor/ceiling — not a per-cell
  // value scaled to whatever pack is plugged in. Confirmed against
  // firmware's own compiled-in defaults (12V / 90V): these bound the
  // widest range of packs the hardware could ever see, wide enough to
  // never be the thing that trips first (the real per-pack protection
  // is cutStart/cutEnd below), so this app leaves them at firmware's
  // own defaults for every S-count rather than computing a per-cell
  // value that would risk being tighter than the actual pack's normal
  // operating range on a small S-count, or falsely appear "protective"
  // on a large one.
  const MIN_VIN_DEFAULT = 12;
  const MAX_VIN_DEFAULT = 90;
  return {
    nominal: sCount * perCellNominal,
    cutStart: sCount * perCellCutStart,
    cutEnd: sCount * perCellCutEnd,
    minVin: MIN_VIN_DEFAULT,
    maxVin: MAX_VIN_DEFAULT,
  };
}

/**
 * Decode just the "Detection Result" fields out of a raw MCCONF blob
 * (command byte already stripped) — see MCCONF_MOTOR_OFFSETS above
 * for what's trusted here and why. Returns null if the blob is
 * shorter than expected (wrong firmware/struct version — don't guess
 * past the end of the buffer).
 */
export function parseMcConfMotorSummary(raw) {
  if (raw.length < MCCONF_MOTOR_OFFSETS.focTempComp + 1) {
    console.warn('[vesc] MCCONF payload shorter than expected for motor summary', raw.length);
    return null;
  }
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  return {
    currentMaxA: view.getFloat32(MCCONF_MOTOR_OFFSETS.currentMax),
    resistanceOhm: view.getFloat32(MCCONF_MOTOR_OFFSETS.focMotorR),
    inductanceH: view.getFloat32(MCCONF_MOTOR_OFFSETS.focMotorL),
    ldLqDiffH: view.getFloat32(MCCONF_MOTOR_OFFSETS.focMotorLdLqDiff),
    fluxLinkageWb: view.getFloat32(MCCONF_MOTOR_OFFSETS.focMotorFluxLinkage),
    tempComp: raw[MCCONF_MOTOR_OFFSETS.focTempComp] !== 0,
  };
}

/** CRC16-CCITT (XModem), poly 0x1021, init 0x0000 */
export function crc16(bytes) {
  let crc = 0x0000;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8;
    for (let b = 0; b < 8; b++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xffff;
    }
  }
  return crc & 0xffff;
}

/** Wrap a payload (Uint8Array) in a VESC packet frame */
export function framePacket(payload) {
  const len = payload.length;
  const useShort = len <= 255;
  const header = useShort
    ? Uint8Array.of(0x02, len)
    : Uint8Array.of(0x03, (len >> 8) & 0xff, len & 0xff);

  const crc = crc16(payload);
  const footer = Uint8Array.of((crc >> 8) & 0xff, crc & 0xff, 0x03);

  const out = new Uint8Array(header.length + payload.length + footer.length);
  out.set(header, 0);
  out.set(payload, header.length);
  out.set(footer, header.length + payload.length);
  return out;
}

/**
 * Incremental frame de-packetizer. BLE MTU is small (often 20 bytes),
 * so a single VESC packet arrives across several BLE notifications.
 * Feed raw bytes in as they arrive; get back complete payloads.
 */
export class PacketAssembler {
  constructor(onPacket) {
    this.buf = [];
    this.onPacket = onPacket;
  }

  push(bytes) {
    for (const b of bytes) this.buf.push(b);
    this._tryParse();
  }

  _tryParse() {
    while (true) {
      if (this.buf.length < 1) return;
      const startByte = this.buf[0];
      let headerLen, payloadLen;

      if (startByte === 0x02) {
        if (this.buf.length < 2) return;
        headerLen = 2;
        payloadLen = this.buf[1];
      } else if (startByte === 0x03) {
        if (this.buf.length < 3) return;
        headerLen = 3;
        payloadLen = (this.buf[1] << 8) | this.buf[2];
      } else {
        // Desynced — drop the byte and keep scanning.
        this.buf.shift();
        continue;
      }

      const totalLen = headerLen + payloadLen + 3; // +crc(2) +end(1)
      if (this.buf.length < totalLen) return; // wait for more data

      const frame = this.buf.slice(0, totalLen);
      const payload = frame.slice(headerLen, headerLen + payloadLen);
      const crcHi = frame[headerLen + payloadLen];
      const crcLo = frame[headerLen + payloadLen + 1];
      const endByte = frame[headerLen + payloadLen + 2];
      const gotCrc = (crcHi << 8) | crcLo;
      const wantCrc = crc16(payload);

      this.buf = this.buf.slice(totalLen);

      if (endByte !== 0x03 || gotCrc !== wantCrc) {
        console.warn('[vesc] bad frame (crc/end mismatch), dropped', {
          gotCrc, wantCrc, endByte,
        });
        continue; // don't deliver corrupt packets, keep scanning
      }

      this.onPacket(new Uint8Array(payload));
    }
  }
}

// --- Payload readers -------------------------------------------------

class Reader {
  constructor(bytes) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.i = 0;
  }
  u8() { const v = this.view.getUint8(this.i); this.i += 1; return v; }
  i16() { const v = this.view.getInt16(this.i); this.i += 2; return v; }
  u16() { const v = this.view.getUint16(this.i); this.i += 2; return v; }
  i32() { const v = this.view.getInt32(this.i); this.i += 4; return v; }
  u32() { const v = this.view.getUint32(this.i); this.i += 4; return v; }
  remaining() { return this.view.byteLength - this.i; }
}

/**
 * Parse a COMM_GET_VALUES response payload (command byte already stripped).
 *
 * Field order below is verified against a working implementation
 * checked byte-offset by byte-offset on real BLDC firmware (source:
 * OpenSourceEBike/EBike_EScooter_modular_DIY, vesc.py, referencing
 * firmware bldc main branch). Two FOC current fields (id, iq) sit
 * between battery current and duty cycle — easy to miss if you're
 * going off an older/simplified field list, which is exactly what
 * caused the original version of this parser to read garbage past
 * that point.
 */
export function parseGetValues(payload) {
  const MIN_LEN = 2 + 2 + 4 + 4 + 4 + 4 + 2 + 4 + 2 + 4 + 4 + 4 + 4 + 4 + 4 + 1;
  if (payload.length < MIN_LEN) {
    console.warn('[vesc] GET_VALUES payload shorter than expected', payload.length);
    return null;
  }
  const r = new Reader(payload);
  return {
    tempMosC: r.i16() / 10,
    tempMotorC: r.i16() / 10,
    currentMotorA: r.i32() / 100,
    currentInA: r.i32() / 100,
    idA: r.i32() / 100,   // FOC d-axis current
    iqA: r.i32() / 100,   // FOC q-axis current
    dutyPct: r.i16() / 1000 * 100,
    rpm: r.i32(),
    vIn: r.i16() / 10,
    ampHours: r.i32() / 10000,
    ampHoursCharged: r.i32() / 10000,
    wattHours: r.i32() / 10000,
    wattHoursCharged: r.i32() / 10000,
    tachometer: r.i32(),
    tachometerAbs: r.i32(),
    faultCode: r.u8(),
  };
}

/**
 * ADC control type options. Values are the real ADC_CTRL_TYPE_* enum
 * values from firmware source (datatypes.h) — confirmed, not guessed.
 * Only exposing the three that actually come up for these kits rather
 * than the full firmware list (duty-cycle control, PID position, etc.
 * aren't relevant here and would just add confusing options). Shared
 * between the setup wizard and the standalone App/pedal config page.
 */
export const CONTROL_TYPES = [
  {
    value: 5, // ADC_CTRL_TYPE_CURRENT_REV_BUTTON_BRAKE_CENTER
    label: 'Current Reverse Button Brake Center (Power Wheels Factory Style)',
    desc: 'A button toggles reverse; pedal center position acts as the brake.',
    centerHint: 'This is the important one: center is the pedal\'s brake/neutral threshold. ' +
      'Since this pedal springs back to idle, recommended: capture it at true idle — the same ' +
      'point as your idle calibration.',
  },
  {
    value: 8, // ADC_CTRL_TYPE_CURRENT_NOREV_BRAKE_ADC
    label: 'Current No Reverse Brake ADC2 (second pedal for brake)',
    desc: 'No reverse. A second pedal wired to ADC2 is the brake.',
    centerHint: 'Braking comes from the second pedal here, not from crossing center on this ' +
      'one — recommended: same as your idle voltage.',
  },
];

/**
 * Parse a COMM_FW_VERSION response payload (command byte stripped).
 * Confirmed from firmware source (comm/commands.c, mainline):
 * [major(u8), minor(u8), hw_name (null-terminated string), 12-byte
 * UUID, pairing_done, test_version, hw_type, custom_config_num, ...].
 * Only major/minor/hwName are parsed — that's all the dashboard needs.
 */
export function parseFwVersion(payload) {
  if (payload.length < 3) return null;
  const major = payload[0];
  const minor = payload[1];
  let i = 2;
  let hwName = '';
  while (i < payload.length && payload[i] !== 0) {
    hwName += String.fromCharCode(payload[i]);
    i++;
  }
  return { major, minor, hwName };
}
export function buildSimpleCommand(commId) {
  return framePacket(Uint8Array.of(commId));
}

/**
 * Parse a COMM_DETECT_MOTOR_R_L response payload (command byte stripped).
 * Layout from firmware source: [r as float32/1e6, l as float32/1e3].
 * r decodes cleanly to ohms. l's real-world unit isn't independently
 * confirmed against your exact firmware (the source used for this
 * layout was a third-party fork, not the mainline repo) — dividing by
 * 1e3 alone lines up with a sane µH-range reading for a small hobby
 * motor, so that's what's used here, but treat it as best-effort
 * until cross-checked against official VESC Tool's own reading for
 * the same motor.
 * A response of exactly 0/0 means the firmware's detection routine
 * itself failed (commands.c zeroes both on failure).
 */
export function parseMotorRL(payload) {
  if (payload.length < 8) {
    console.warn('[vesc] DETECT_MOTOR_R_L payload shorter than expected', payload.length);
    return null;
  }
  const r = new Reader(payload);
  const resistance = r.i32() / 1e6; // ohms
  const inductance = r.i32() / 1e3; // µH (best-effort, see note above)
  return { resistance, inductance, failed: resistance === 0 && inductance === 0 };
}

/**
 * Wrap a command in COMM_FORWARD_CAN so it's routed to another
 * controller on the CAN bus (or, on true dual-motor single-PCB
 * hardware, to the second motor's internal thread — confirmed from
 * firmware source: commands.c intercepts this before it hits the
 * physical CAN bus when the target ID matches the board's own
 * second-motor ID). Payload: [FORWARD_CAN, targetCanId, ...inner].
 * The reply comes back as a normal, unwrapped packet with the
 * inner command's own ID — no special reply parsing needed.
 */
export function buildForwardedCommand(targetCanId, innerCommandBytes) {
  const payload = new Uint8Array(2 + innerCommandBytes.length);
  payload[0] = COMM.FORWARD_CAN;
  payload[1] = targetCanId & 0xff;
  payload.set(innerCommandBytes, 2);
  return framePacket(payload);
}

/**
 * Parse a COMM_GET_DECODED_ADC response payload (command byte stripped).
 * Confirmed against current firmware source (vedderb/bldc/commands.c):
 * four int32 values, each the real value * 1e6. `level`/`level2` are
 * the decoded 0..1 (or -1..1 for reversible modes) pedal position;
 * `voltage`/`voltage2` are the raw ADC voltage in volts. A second
 * pedal channel (level2/voltage2) is only meaningful if the client's
 * setup actually uses two ADC inputs — most single-pedal setups can
 * ignore it.
 */
export function parseDecodedAdc(payload) {
  if (payload.length < 16) {
    console.warn('[vesc] GET_DECODED_ADC payload shorter than expected', payload.length);
    return null;
  }
  const r = new Reader(payload);
  return {
    level: r.i32() / 1e6,
    voltage: r.i32() / 1e6,
    level2: r.i32() / 1e6,
    voltage2: r.i32() / 1e6,
  };
}

/**
 * COMM_DETECT_APPLY_ALL_FOC — the same one-shot "detect and apply all
 * FOC parameters" routine official VESC Tool's motor setup wizard
 * uses. Confirmed from firmware source (comm/commands.c +
 * conf_general.c, current mainline): the retry/apply/store logic
 * lives entirely in firmware, not in VESC Tool's own app code — so
 * unlike a raw single-shot flux-linkage or R/L call, this one command
 * runs DC offset calibration, then R/L + max-current measurement,
 * then an openloop flux-linkage measurement (motor spins for real —
 * NOT a standstill test, unlike plain R/L detection), then hall/AS5147
 * encoder sensor detection (motor spins again briefly), applies
 * everything to the live motor config, and — if the overall result is
 * success — writes it to flash for real (conf_general_store_mc_configuration).
 * This is why it's the right tool for "populate motor config for
 * real": we don't have to know or guess a single MCCONF byte offset
 * ourselves — firmware does the write internally, the same trusted
 * path VESC Tool itself relies on.
 *
 * Request payload (command byte NOT included — see buildDetectApplyAllFocRequest):
 *   [detectCan: u8 bool, maxPowerLoss: i32/1e3, minCurrentIn: i32/1e3,
 *    maxCurrentIn: i32/1e3, openloopRpm: i32/1e3, slErpm: i32/1e3]
 * min/max current in, openloop RPM, and sl ERPM all mean "leave
 * unchanged" when passed as 0 (confirmed from source doc comments on
 * conf_general_detect_apply_all_foc_can) — only maxPowerLoss is
 * actually used unconditionally.
 *
 * IMPORTANT — always send this direct (never wrapped in
 * COMM_FORWARD_CAN): on single-PCB dual-motor hardware like a Flipsky
 * 75100 Dual, firmware already detects+applies+stores BOTH motors in
 * one call on its own (confirmed from source: the HW_HAS_DUAL_MOTORS
 * code paths run every measurement a second time for the second
 * motor thread internally). detectCan is a separate, real-CAN-bus
 * discovery flag for genuinely separate physical VESCs — not the
 * same thing as this app's own CAN-forwarded second-motor addressing
 * used elsewhere, and not needed for a single-PCB dual board.
 */
export function buildDetectApplyAllFocRequest({
  detectCan = false, maxPowerLoss, minCurrentIn = 0, maxCurrentIn = 0,
  openloopRpm = 0, slErpm = 0,
}) {
  const body = new Uint8Array(1 + 4 * 5);
  const view = new DataView(body.buffer);
  body[0] = detectCan ? 1 : 0;
  view.setInt32(1, Math.round(maxPowerLoss * 1e3));
  view.setInt32(5, Math.round(minCurrentIn * 1e3));
  view.setInt32(9, Math.round(maxCurrentIn * 1e3));
  view.setInt32(13, Math.round(openloopRpm * 1e3));
  view.setInt32(17, Math.round(slErpm * 1e3));
  return body;
}

/**
 * Parse the COMM_DETECT_APPLY_ALL_FOC response (command byte stripped):
 * a single int16 result code. Meanings confirmed from firmware source
 * doc comments (conf_general.c):
 *   2  = success, AS5147/encoder sensor detected and applied
 *   1  = success, hall sensors detected and applied
 *   0  = success, no position sensor found — sensorless mode applied
 *  -1  = sensor detection failed (R/L/flux-linkage/current-limits were
 *        still measured, applied, and saved — only the sensor step failed)
 *  -10 = flux linkage detection failed; nothing was changed/saved
 *  -50 = CAN-bus detection timed out (only possible if detectCan was true)
 *  -51 = CAN-bus detection failed on at least one device (detectCan true)
 *  <= -100 = a motor fault occurred during detection; real fault code
 *        is (result + 100) — see FAULT_NAMES
 *  any other negative = detection failed for another reason; nothing changed
 */
export function parseDetectApplyAllFoc(payload) {
  if (payload.length < 2) {
    console.warn('[vesc] DETECT_APPLY_ALL_FOC payload shorter than expected', payload.length);
    return null;
  }
  const code = new Reader(payload).i16();
  let message;
  let success = false;
  if (code === 2) { message = 'Done — position sensor detected: AS5147/SPI encoder. Applied and saved.'; success = true; }
  else if (code === 1) { message = 'Done — position sensor detected: Hall sensors. Applied and saved.'; success = true; }
  else if (code === 0) { message = 'Done — no position sensor found. Sensorless mode applied and saved.'; success = true; }
  else if (code === -1) { message = 'Motor parameters (resistance, inductance, flux linkage, current limits) were measured, applied, and saved — but sensor detection itself failed. Check hall/encoder wiring, or use sensorless mode.'; success = true; }
  else if (code === -10) { message = 'Flux linkage detection failed. Nothing was changed or saved — check motor phase connections and try again.'; }
  else if (code === -50) { message = 'CAN-bus detection timed out.'; }
  else if (code === -51) { message = 'CAN-bus detection failed on at least one linked VESC.'; }
  // Fault codes are returned as (faultCode - 100) — see conf_general.c's
  // "Offset fault by -100" comment. FAULT_NAMES covers faultCode 0-27,
  // so the offset range is -100 (fault 0) down to -73 (fault 27). This
  // was previously checked as `code <= -100`, which only ever matched
  // fault 0 (FAULT_CODE_NONE, which firmware wouldn't even report as a
  // failure) — every real fault (under voltage, over current, etc.)
  // fell through to the generic "unknown code" message below instead
  // of naming the actual fault. Fixed to cover the whole offset range.
  else if (code <= -73 && code >= -100) { message = `Motor fault during detection: ${faultName(code + 100)}. Nothing was changed or saved.`; }
  else { message = `Detection failed (code ${code}). Nothing was changed or saved.`; }
  return { code, message, success };
}
