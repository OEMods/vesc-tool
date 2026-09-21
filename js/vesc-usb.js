/**
 * vesc-usb.js
 * ------------------------------------------------------------------
 * Web Serial transport for VESCs connected over USB. The VESC's
 * onboard USB port enumerates as a CDC-ACM virtual serial port —
 * same binary packet protocol as BLE (vesc-protocol.js), just no
 * BLE chunking or MTU limits to worry about. This is the easier
 * transport to validate the protocol layer against first.
 *
 * Desktop Chrome/Edge only. No mobile browser supports Web Serial —
 * Chrome Android explicitly does not implement it, Safari opposes it.
 * That's expected and fine for bench testing.
 * ------------------------------------------------------------------
 */

import { PacketAssembler, buildSimpleCommand, buildForwardedCommand, framePacket, parseGetValues, parseDecodedAdc, parseMotorRL, parseFwVersion, applyAppConfPatches, buildDetectApplyAllFocRequest, parseDetectApplyAllFoc, COMM } from './vesc-protocol.js';
// applyAppConfPatches is blob-agnostic (see its doc comment in
// vesc-protocol.js) and is reused below for MCCONF writes too.

// VESC's USB CDC-ACM doesn't actually gate on baud rate (it's a
// virtual port over USB, not real RS-232), but Web Serial requires
// you to specify one to open the port. 115200 is the conventional
// value VESC Tool itself uses.
const BAUD_RATE = 115200;

export class VescUsbClient {
  constructor() {
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.readLoopPromise = null;
    this.assembler = new PacketAssembler((payload) => this._handlePacket(payload));
    this.onValues = null;
    this.onDecodedAdc = null; // (values: {level, voltage, level2, voltage2}) => void
    this.onPingCanResult = null; // (rawBytes: Uint8Array) => void — see requestPingCan
    this.onAppConfRaw = null; // (rawBytes: Uint8Array) => void — see requestAppConf
    this._pendingAppConfRead = null;      // one-shot resolver, see _requestFreshAppConf
    this._pendingAppConfWriteAck = null;  // one-shot resolver, see writeAppConf
    this._pendingMotorRL = null;          // one-shot resolver, see detectMotorRL
    this._pendingMcConfRead = null;       // one-shot resolver, see requestMcConfRaw
    this._pendingMcConfWriteAck = null;   // one-shot resolver, see writeMcConfRaw
    this._pendingPingCan = null;          // one-shot resolver, see detectLinkedCanId
    this._pendingFwVersion = null;        // one-shot resolver, see requestFwVersion
    this._pendingDetectApplyAllFoc = null; // one-shot resolver, see detectApplyAllFoc
    // null = talk to the directly-connected board. A number = forward
    // every request over CAN to that controller ID (see
    // buildForwardedCommand — used for dual-motor boards where the
    // second motor lives behind COMM_FORWARD_CAN).
    this.targetCanId = null;
    this.onConnectionChange = null;
    this.onLog = null;
    this.onRawPacket = null; // (commId, hexString) => void — for offset validation
    this._connected = false;
  }

  static isSupported() {
    return typeof navigator !== 'undefined' && !!navigator.serial;
  }

  _log(msg) {
    console.log('[vesc-usb]', msg);
    if (this.onLog) this.onLog(msg);
  }

  async connect() {
    if (!VescUsbClient.isSupported()) {
      throw new Error('NO_WEB_SERIAL');
    }

    this._log('Opening port picker…');
    this.port = await navigator.serial.requestPort();

    await this.port.open({ baudRate: BAUD_RATE });
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();

    this._connected = true;
    this._log('Connected.');
    if (this.onConnectionChange) this.onConnectionChange(true);

    this.readLoopPromise = this._readLoop();
  }

  async _readLoop() {
    try {
      while (true) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) this.assembler.push(value);
      }
    } catch (err) {
      // A read error usually means the cable got pulled or the port
      // closed underneath us — treat it as a disconnect, not a crash.
      this._log(`Read loop ended: ${err.message}`);
    } finally {
      this._teardown();
    }
  }

  async disconnect() {
    if (this.reader) {
      try { await this.reader.cancel(); } catch (_) { /* already gone */ }
    }
    await this._teardown();
  }

  async _teardown() {
    if (!this._connected) return;
    this._connected = false;

    try { this.reader?.releaseLock(); } catch (_) {}
    try { this.writer?.releaseLock(); } catch (_) {}
    try { await this.port?.close(); } catch (_) {}

    this.reader = null;
    this.writer = null;
    this.port = null;

    this._log('Disconnected.');
    if (this.onConnectionChange) this.onConnectionChange(false);
  }

  get isConnected() {
    return this._connected;
  }

  async _write(bytes) {
    if (!this.isConnected || !this.writer) throw new Error('NOT_CONNECTED');
    // USB has no BLE-style MTU limit — send the whole packet in one write.
    await this.writer.write(bytes);
  }

  async requestValues() {
    const packet = this.targetCanId != null
      ? buildForwardedCommand(this.targetCanId, Uint8Array.of(COMM.GET_VALUES))
      : buildSimpleCommand(COMM.GET_VALUES);
    await this._write(packet);
  }

  async requestDecodedAdc() {
    const packet = this.targetCanId != null
      ? buildForwardedCommand(this.targetCanId, Uint8Array.of(COMM.GET_DECODED_ADC))
      : buildSimpleCommand(COMM.GET_DECODED_ADC);
    await this._write(packet);
  }

  /**
   * Debug capture: request the full COMM_GET_APPCONF blob and hand the
   * raw bytes to onAppConfRaw. This is how we get a real, verified byte
   * layout for the pedal/ADC config fields instead of guessing at the
   * wire encoding — same approach that fixed GET_VALUES.
   */
  async requestAppConf() {
    const packet = this.targetCanId != null
      ? buildForwardedCommand(this.targetCanId, Uint8Array.of(COMM.GET_APPCONF))
      : buildSimpleCommand(COMM.GET_APPCONF);
    await this._write(packet);
  }

  /** Internal: request APPCONF and wait for the specific reply, rather
   * than relying on the general onAppConfRaw callback (which fires for
   * every dump, debug or otherwise). Used so a write always patches a
   * blob it just read, not a stale one from earlier in the session. */
  async _requestFreshAppConf(timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingAppConfRead = null;
        reject(new Error('Timed out waiting for APPCONF read'));
      }, timeoutMs);
      this._pendingAppConfRead = (bytes) => {
        clearTimeout(timer);
        this._pendingAppConfRead = null;
        resolve(bytes);
      };
      this.requestAppConf().catch((err) => {
        clearTimeout(timer);
        this._pendingAppConfRead = null;
        reject(err);
      });
    });
  }

  /** Public one-shot APPCONF read that resolves with the raw bytes —
   * same underlying mechanism writeAppConf uses to get a fresh copy
   * before patching, exposed directly for read-only uses (e.g.
   * reading controllerId for the wizard's detection-result display). */
  async readAppConf(timeoutMs = 4000) {
    return this._requestFreshAppConf(timeoutMs);
  }

  /**
   * Read the current APPCONF fresh, patch specific verified byte
   * offsets (see APPCONF_OFFSETS in vesc-protocol.js), and write the
   * whole blob back via SET_APPCONF. Everything not explicitly patched
   * passes through unchanged. Resolves once the firmware confirms the
   * write; rejects on timeout or transport error — never assumes
   * success silently.
   *
   * patches: same shape as applyAppConfPatches — [{offset, type, value, scale?}]
   */
  async writeAppConf(patches, timeoutMs = 4000) {
    const original = await this._requestFreshAppConf(timeoutMs);
    const patched = applyAppConfPatches(original, patches);

    const inner = new Uint8Array(1 + patched.length);
    inner[0] = COMM.SET_APPCONF;
    inner.set(patched, 1);

    const packet = this.targetCanId != null
      ? buildForwardedCommand(this.targetCanId, inner)
      : framePacket(inner);

    const ackPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingAppConfWriteAck = null;
        reject(new Error('Timed out waiting for SET_APPCONF confirmation'));
      }, timeoutMs);
      this._pendingAppConfWriteAck = () => {
        clearTimeout(timer);
        this._pendingAppConfWriteAck = null;
        resolve();
      };
    });

    await this._write(packet);
    await ackPromise;
    return true;
  }

  /**
   * Run resistance/inductance detection (COMM_DETECT_MOTOR_R_L). This
   * is a standstill measurement — firmware injects a small FOC test
   * signal to measure the windings; the rotor doesn't turn (confirmed
   * from source: mcpwm_foc_measure_res_ind, called with no motion).
   * No input parameters needed. Firmware runs the measurement
   * synchronously before replying, so this gets a longer timeout than
   * a normal request — give it several seconds.
   */
  async detectMotorRL(timeoutMs = 8000) {
    const packet = this.targetCanId != null
      ? buildForwardedCommand(this.targetCanId, Uint8Array.of(COMM.DETECT_MOTOR_R_L))
      : buildSimpleCommand(COMM.DETECT_MOTOR_R_L);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingMotorRL = null;
        reject(new Error('Timed out waiting for R/L detection to finish'));
      }, timeoutMs);
      this._pendingMotorRL = (result) => {
        clearTimeout(timer);
        this._pendingMotorRL = null;
        resolve(result);
      };
      this._write(packet).catch((err) => {
        clearTimeout(timer);
        this._pendingMotorRL = null;
        reject(err);
      });
    });
  }

  /**
   * Run the full "detect and apply all FOC parameters" routine
   * (COMM_DETECT_APPLY_ALL_FOC) — resistance/inductance/max-current,
   * flux linkage, and hall/encoder sensor detection in one shot, with
   * firmware applying and (on success) permanently saving the results
   * itself. See buildDetectApplyAllFocRequest/parseDetectApplyAllFoc
   * in vesc-protocol.js for the full source-verified rundown of what
   * this does and why it's safe without knowing MCCONF's byte layout.
   *
   * Always sent direct — never CAN-forwarded, even if targetCanId is
   * set, because a single-PCB dual-motor board already handles both
   * motors internally for this specific command (see protocol.js
   * comment). detectCan is firmware's own separate real-CAN-bus
   * discovery flag, unrelated to this app's targetCanId addressing.
   *
   * This is a "blocking command" in firmware — DC offset cal, R/L
   * measurement, an openloop flux-linkage spin, and sensor detection
   * all run synchronously before it replies, so give it a long
   * timeout (default 45s; real hardware runs have taken 15-25s).
   */
  async detectApplyAllFoc(params, timeoutMs = 45000) {
    const body = buildDetectApplyAllFocRequest(params);
    const inner = new Uint8Array(1 + body.length);
    inner[0] = COMM.DETECT_APPLY_ALL_FOC;
    inner.set(body, 1);
    const packet = framePacket(inner);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingDetectApplyAllFoc = null;
        reject(new Error('Timed out waiting for full motor detection to finish'));
      }, timeoutMs);
      this._pendingDetectApplyAllFoc = (result) => {
        clearTimeout(timer);
        this._pendingDetectApplyAllFoc = null;
        resolve(result);
      };
      this._write(packet).catch((err) => {
        clearTimeout(timer);
        this._pendingDetectApplyAllFoc = null;
        reject(err);
      });
    });
  }

  /**
   * Ask the connected board for its firmware version and hardware name.
   * Confirmed response format against mainline firmware source.
   */
  async requestFwVersion(timeoutMs = 4000) {
    const packet = this.targetCanId != null
      ? buildForwardedCommand(this.targetCanId, Uint8Array.of(COMM.FW_VERSION))
      : buildSimpleCommand(COMM.FW_VERSION);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingFwVersion = null;
        reject(new Error('Timed out waiting for firmware version'));
      }, timeoutMs);
      this._pendingFwVersion = (fw) => {
        clearTimeout(timer);
        this._pendingFwVersion = null;
        resolve(fw);
      };
      this._write(packet).catch((err) => {
        clearTimeout(timer);
        this._pendingFwVersion = null;
        reject(err);
      });
    });
  }

  /**
   * Read raw COMM_GET_MCCONF bytes for a specific motor, independent
   * of the client's global targetCanId (so the motor config page can
   * read "this VESC" and "linked VESC" as two separate explicit calls
   * without disturbing the dashboard's own reading-from selection).
   * Pass null for the directly-connected board, or a CAN ID to forward.
   * MCCONF's field layout isn't verified yet — this returns raw bytes
   * only; decoding happens once we've done the same capture-and-diff
   * pass that got APPCONF working.
   */
  async requestMcConfRaw(targetCanId, timeoutMs = 4000) {
    const packet = targetCanId != null
      ? buildForwardedCommand(targetCanId, Uint8Array.of(COMM.GET_MCCONF))
      : buildSimpleCommand(COMM.GET_MCCONF);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingMcConfRead = null;
        reject(new Error('Timed out waiting for MCCONF read'));
      }, timeoutMs);
      this._pendingMcConfRead = (bytes) => {
        clearTimeout(timer);
        this._pendingMcConfRead = null;
        resolve(bytes);
      };
      this._write(packet).catch((err) => {
        clearTimeout(timer);
        this._pendingMcConfRead = null;
        reject(err);
      });
    });
  }

  /**
   * Read the current MCCONF for a specific target fresh, patch specific
   * byte offsets (see MCCONF_OFFSETS in vesc-protocol.js — READ THAT
   * COMMENT, these offsets are not hardware-verified the way APPCONF's
   * are), and write the whole blob back via COMM_SET_MCCONF. Everything
   * not explicitly patched passes through unchanged.
   *
   * Unlike writeAppConf, targetCanId is an explicit parameter here
   * rather than implicitly using this.targetCanId — because, unlike a
   * pedal (which only lives on one physical side of a dual-motor
   * board), battery/speed settings need to go to a specific, often
   * BOTH, side(s) regardless of whatever the dashboard's "reading
   * from" selection currently is. Pass null for the directly-connected
   * board, or a CAN ID to forward via COMM_FORWARD_CAN. Resolves once
   * firmware confirms the write (bare command-byte ack, same pattern
   * as SET_APPCONF); rejects on timeout or transport error.
   *
   * patches: same shape as applyAppConfPatches — [{offset, type, value, scale?}]
   */
  async writeMcConfRaw(patches, targetCanId, timeoutMs = 6000) {
    const original = await this.requestMcConfRaw(targetCanId, timeoutMs);
    const patched = applyAppConfPatches(original, patches);

    const inner = new Uint8Array(1 + patched.length);
    inner[0] = COMM.SET_MCCONF;
    inner.set(patched, 1);

    const packet = targetCanId != null
      ? buildForwardedCommand(targetCanId, inner)
      : framePacket(inner);

    const ackPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingMcConfWriteAck = null;
        reject(new Error('Timed out waiting for SET_MCCONF confirmation'));
      }, timeoutMs);
      this._pendingMcConfWriteAck = () => {
        clearTimeout(timer);
        this._pendingMcConfWriteAck = null;
        resolve();
      };
    });

    await this._write(packet);
    await ackPromise;
    return true;
  }

  /**
   * Write the same MCCONF patches to BOTH sides of the board: always
   * direct (the physically-connected motor), and — if a linked CAN ID
   * is known (this.targetCanId, set from the dashboard's "LINKED
   * VESC" pairing) — also forwarded to that motor. Unlike
   * detectApplyAllFoc, COMM_SET_MCCONF is NOT automatically dual on a
   * single-PCB dual-motor board — a direct write only ever touches the
   * currently-selected motor thread — so this does two real, separate
   * writes rather than relying on firmware to fan it out.
   *
   * Returns { direct: boolean, linked: boolean|null, linkedError?:
   * string }. The direct write throws on failure (nothing was written
   * at all — a hard error). The linked write, if attempted, does NOT
   * throw on its own failure — it's reported back instead, so a caller
   * writing safety-relevant config (battery cutoffs, speed limits)
   * can tell "direct succeeded, no link exists" apart from "direct
   * succeeded, but the second motor didn't get it" rather than losing
   * that distinction to a thrown error either way. linked is null when
   * no linked CAN ID is set, true/false once a link is known and that
   * write was attempted.
   */
  async writeMcConfBothSides(patches, timeoutMs = 6000) {
    await this.writeMcConfRaw(patches, null, timeoutMs);
    if (this.targetCanId == null) {
      return { direct: true, linked: null };
    }
    try {
      await this.writeMcConfRaw(patches, this.targetCanId, timeoutMs);
      return { direct: true, linked: true };
    } catch (err) {
      return { direct: true, linked: false, linkedError: err.message };
    }
  }

  /**
   * Ask the connected board which other CAN devices it knows about.
   * Command ID (62) is confirmed against firmware source, but the
   * reply's exact byte layout isn't — the response handler surfaces
   * raw bytes via onPingCanResult so we can verify against your
   * hardware, same as the GET_VALUES fix.
   */
  async requestPingCan() {
    await this._write(buildSimpleCommand(COMM.PING_CAN));
  }

  /**
   * Promise-based auto-detect of a linked CAN VESC — same PING_CAN
   * scan and same "take the first discovered ID, 255 is a list
   * terminator" reading the dashboard's "LINKED VESC" button already
   * uses, just awaitable instead of callback-based, and via its own
   * pending-resolver slot rather than onPingCanResult so it doesn't
   * fight with whatever the dashboard has that callback set to mid-scan
   * (same kind of collision RT Data's onValues/onDecodedAdc save-and-
   * restore pattern exists to avoid — see README). Resolves with a
   * CAN ID, or null if the scan found nothing.
   */
  async detectLinkedCanId(timeoutMs = 4000) {
    const packet = buildSimpleCommand(COMM.PING_CAN);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingPingCan = null;
        reject(new Error('Timed out waiting for CAN scan'));
      }, timeoutMs);
      this._pendingPingCan = (rawBytes) => {
        clearTimeout(timer);
        this._pendingPingCan = null;
        const ids = Array.from(rawBytes).filter((b) => b !== 255);
        resolve(ids.length ? ids[0] : null);
      };
      this._write(packet).catch((err) => {
        clearTimeout(timer);
        this._pendingPingCan = null;
        reject(err);
      });
    });
  }

  _handlePacket(payload) {
    if (payload.length === 0) return;
    const commId = payload[0];
    const body = payload.slice(1);

    if (this.onRawPacket) {
      const hex = Array.from(body).map((b) => b.toString(16).padStart(2, '0')).join(' ');
      this.onRawPacket(commId, hex);
    }

    if (commId === COMM.GET_VALUES) {
      const values = parseGetValues(body);
      if (values && this.onValues) this.onValues(values);
    } else if (commId === COMM.GET_DECODED_ADC) {
      const adc = parseDecodedAdc(body);
      if (adc && this.onDecodedAdc) this.onDecodedAdc(adc);
    } else if (commId === COMM.PING_CAN) {
      if (this.onPingCanResult) this.onPingCanResult(body);
      if (this._pendingPingCan) this._pendingPingCan(body);
    } else if (commId === COMM.GET_APPCONF) {
      if (this.onAppConfRaw) this.onAppConfRaw(body);
      if (this._pendingAppConfRead) this._pendingAppConfRead(body);
    } else if (commId === COMM.SET_APPCONF) {
      // Firmware's confirmation that the write was received and applied
      // (commands.c sends back just the bare command byte after storing
      // to flash — see README for the source reference).
      if (this._pendingAppConfWriteAck) this._pendingAppConfWriteAck();
    } else if (commId === COMM.DETECT_MOTOR_R_L) {
      const result = parseMotorRL(body);
      if (this._pendingMotorRL) this._pendingMotorRL(result);
    } else if (commId === COMM.GET_MCCONF) {
      if (this._pendingMcConfRead) this._pendingMcConfRead(body);
    } else if (commId === COMM.SET_MCCONF) {
      // Firmware's confirmation the write was received, applied, and
      // stored to flash — commands.c sends back just the bare command
      // byte, same pattern as SET_APPCONF (see README).
      if (this._pendingMcConfWriteAck) this._pendingMcConfWriteAck();
    } else if (commId === COMM.DETECT_APPLY_ALL_FOC) {
      const result = parseDetectApplyAllFoc(body);
      if (this._pendingDetectApplyAllFoc) this._pendingDetectApplyAllFoc(result);
    } else if (commId === COMM.FW_VERSION) {
      const fw = parseFwVersion(body);
      if (this._pendingFwVersion) this._pendingFwVersion(fw);
    }
  }

  /** Start polling GET_VALUES on an interval. Returns a stop function. */
  startPolling(intervalMs = 250) {
    const handle = setInterval(() => {
      this.requestValues().catch((err) => this._log(`poll error: ${err.message}`));
    }, intervalMs);
    return () => clearInterval(handle);
  }

  /** Start polling GET_DECODED_ADC on an interval. Returns a stop function. */
  startAdcPolling(intervalMs = 100) {
    const handle = setInterval(() => {
      this.requestDecodedAdc().catch((err) => this._log(`adc poll error: ${err.message}`));
    }, intervalMs);
    return () => clearInterval(handle);
  }
}
