/**
 * vesc-ble.js
 * ------------------------------------------------------------------
 * Web Bluetooth transport. VESC's BLE module exposes the standard
 * Nordic UART Service (NUS) — this isn't VESC-specific, it's the
 * de facto standard for "serial over BLE" and VESC just rides it.
 *
 *   Service UUID: 6e400001-b5a3-f393-e0a9-e50e24dcca9e
 *   RX (write)  : 6e400002-b5a3-f393-e0a9-e50e24dcca9e  (phone -> VESC)
 *   TX (notify) : 6e400003-b5a3-f393-e0a9-e50e24dcca9e  (VESC -> phone)
 *
 * Naming is from the peripheral's point of view, which trips people
 * up: we WRITE to the "RX" characteristic and SUBSCRIBE to the "TX"
 * characteristic. Kept the peripheral's naming here since that's
 * what you'll see in every datasheet and nRF Connect capture.
 *
 * Full command parity with vesc-usb.js (VescUsbClient) — same public
 * method names, same _pending* one-shot resolver pattern, same
 * _handlePacket dispatch. Every one of those methods is transport-
 * agnostic (they just build a packet and call this._write(bytes)),
 * so they're carried over unchanged; the only real differences from
 * USB are connect()/disconnect() (device picker + GATT vs. serial
 * port) and _write() itself (chunked BLE writes vs. one unrestricted
 * serial write — see _write's own comment). Whenever a new command
 * gets added to vesc-usb.js, mirror it here the same way, or the app
 * silently loses that capability the moment BLE is wired into app.js
 * instead of USB.
 * ------------------------------------------------------------------
 */

import {
  PacketAssembler, buildSimpleCommand, buildForwardedCommand, framePacket,
  parseGetValues, parseDecodedAdc, parseMotorRL, parseFwVersion,
  applyAppConfPatches, buildDetectApplyAllFocRequest, parseDetectApplyAllFoc,
  COMM,
} from './vesc-protocol.js';
// applyAppConfPatches is blob-agnostic (see its doc comment in
// vesc-protocol.js) and is reused below for MCCONF writes too, same
// as vesc-usb.js.

const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_RX_CHAR = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // write
const NUS_TX_CHAR = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // notify

export class VescBleClient {
  constructor() {
    this.device = null;
    this.server = null;
    this.rxChar = null; // write target
    this.txChar = null; // notify source
    this.assembler = new PacketAssembler((payload) => this._handlePacket(payload));
    this.onValues = null;      // (values) => void
    this.onDecodedAdc = null;  // (adc: {level, voltage, level2, voltage2}) => void
    this.onPingCanResult = null; // (rawBytes: Uint8Array) => void — see requestPingCan
    this.onAppConfRaw = null;    // (rawBytes: Uint8Array) => void — see requestAppConf
    this.onConnectionChange = null; // (connected: boolean) => void
    this.onLog = null;         // (msg: string) => void
    this.onRawPacket = null;   // (commId, hexString) => void — for offset validation
    this._pendingAppConfRead = null;      // one-shot resolver, see _requestFreshAppConf
    this._pendingAppConfWriteAck = null;  // one-shot resolver, see writeAppConf
    this._pendingMotorRL = null;          // one-shot resolver, see detectMotorRL
    this._pendingMcConfRead = null;       // one-shot resolver, see requestMcConfRaw
    this._pendingMcConfWriteAck = null;   // one-shot resolver, see writeMcConfRaw
    this._pendingPingCan = null;          // one-shot resolver, see detectLinkedCanId
    this._pendingFwVersion = null;        // one-shot resolver, see requestFwVersion
    this._pendingDetectApplyAllFoc = null; // one-shot resolver, see detectApplyAllFoc
    this._pendingMcConfDefaultRead = null; // one-shot resolver, see requestMcConfDefaultRaw
    this._pendingAppConfDefaultRead = null; // one-shot resolver, see requestAppConfDefaultRaw
    // null = talk to the directly-connected board. A number = forward
    // every request over CAN to that controller ID — same meaning and
    // same buildForwardedCommand mechanism as vesc-usb.js.
    this.targetCanId = null;
  }

  static isSupported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  _log(msg) {
    console.log('[vesc-ble]', msg);
    if (this.onLog) this.onLog(msg);
  }

  async connect() {
    if (!VescBleClient.isSupported()) {
      throw new Error('NO_WEB_BLUETOOTH');
    }

    this._log('Opening device picker…');
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [NUS_SERVICE] }],
      // If a client's VESC BLE module advertises a custom name filter
      // instead of the service UUID, swap the line above for:
      // filters: [{ namePrefix: 'VESC' }], optionalServices: [NUS_SERVICE],
    });

    this.device.addEventListener('gattserverdisconnected', () => this._onDisconnected());

    this._log(`Connecting to ${this.device.name || 'device'}…`);
    this.server = await this.device.gatt.connect();

    const service = await this.server.getPrimaryService(NUS_SERVICE);
    this.rxChar = await service.getCharacteristic(NUS_RX_CHAR);
    this.txChar = await service.getCharacteristic(NUS_TX_CHAR);

    await this.txChar.startNotifications();
    this.txChar.addEventListener('characteristicvaluechanged', (ev) => {
      const bytes = new Uint8Array(ev.target.value.buffer);
      this.assembler.push(bytes);
    });

    this._log('Connected.');
    if (this.onConnectionChange) this.onConnectionChange(true);
  }

  disconnect() {
    if (this.device && this.device.gatt.connected) {
      this.device.gatt.disconnect();
    }
  }

  _onDisconnected() {
    this._log('Disconnected.');
    this.rxChar = null;
    this.txChar = null;
    if (this.onConnectionChange) this.onConnectionChange(false);
  }

  get isConnected() {
    return !!(this.device && this.device.gatt && this.device.gatt.connected);
  }

  /**
   * Write raw bytes to the RX characteristic, chunked to a safe BLE
   * write size. 20 bytes is the conservative default ATT payload
   * (23-byte MTU minus 3-byte header) — some stacks negotiate higher,
   * but this is a working baseline that won't fail on cheap modules.
   * Same role as vesc-usb.js's _write (every command method below
   * calls this exact same way) — the only difference is USB sends a
   * whole packet in one write, BLE has to chunk it.
   */
  async _write(bytes, chunkSize = 20) {
    if (!this.isConnected || !this.rxChar) throw new Error('NOT_CONNECTED');
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.slice(i, i + chunkSize);
      await this.rxChar.writeValue(chunk);
    }
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
   * raw bytes to onAppConfRaw. Same purpose as vesc-usb.js's version —
   * a real, verified byte layout for the pedal/ADC config fields.
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
   * signal to measure the windings; the rotor doesn't turn. No input
   * parameters needed. Firmware runs the measurement synchronously
   * before replying, so this gets a longer timeout than a normal
   * request — give it several seconds.
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
   * in vesc-protocol.js for the full source-verified rundown.
   *
   * Always sent direct — never CAN-forwarded, even if targetCanId is
   * set, because a single-PCB dual-motor board already handles both
   * motors internally for this specific command. detectCan is
   * firmware's own separate real-CAN-bus discovery flag, unrelated to
   * this app's targetCanId addressing.
   *
   * This is a "blocking command" in firmware — DC offset cal, R/L
   * measurement, an openloop flux-linkage spin, and sensor detection
   * all run synchronously before it replies, so give it a long
   * timeout (default 45s, same as USB — over BLE the command packet
   * itself is tiny and chunking it costs nothing next to a 15-25s
   * detection run; if a real BLE module turns out to need more slack,
   * raise this default rather than the USB one).
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
   * byte offsets (see MCCONF_OFFSETS in vesc-protocol.js), and write
   * the whole blob back via COMM_SET_MCCONF. Everything not explicitly
   * patched passes through unchanged.
   *
   * targetCanId is an explicit parameter here (not this.targetCanId)
   * for the same reason as vesc-usb.js: battery/speed settings need
   * to go to a specific, often BOTH, side(s) regardless of whatever
   * the dashboard's "reading from" selection currently is.
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
   * is known (this.targetCanId) — also forwarded to that motor.
   * COMM_SET_MCCONF is not automatically dual on a single-PCB
   * dual-motor board, so this does two real, separate writes. Same
   * return shape as vesc-usb.js: { direct, linked, linkedError? }.
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
   * Request the firmware's compiled-in default MCCONF blob for a
   * specific target (COMM_GET_MCCONF_DEFAULT). Firmware splices this
   * board's real FOC current/voltage ADC calibration offsets back
   * into the "default" blob it returns — safe to write straight back
   * via SET_MCCONF without decoding or patching anything (see
   * resetMcConfToDefaults). Pass null for the directly-connected
   * board, or a CAN ID to forward.
   */
  async requestMcConfDefaultRaw(targetCanId, timeoutMs = 4000) {
    const packet = targetCanId != null
      ? buildForwardedCommand(targetCanId, Uint8Array.of(COMM.GET_MCCONF_DEFAULT))
      : buildSimpleCommand(COMM.GET_MCCONF_DEFAULT);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingMcConfDefaultRead = null;
        reject(new Error('Timed out waiting for MCCONF defaults'));
      }, timeoutMs);
      this._pendingMcConfDefaultRead = (bytes) => {
        clearTimeout(timer);
        this._pendingMcConfDefaultRead = null;
        resolve(bytes);
      };
      this._write(packet).catch((err) => {
        clearTimeout(timer);
        this._pendingMcConfDefaultRead = null;
        reject(err);
      });
    });
  }

  /**
   * Reset MCCONF to firmware defaults for a specific target: read the
   * compiled-in default blob and write it straight back unmodified
   * via COMM_SET_MCCONF. No byte-offset patching involved. Pass null
   * for the directly-connected board, or a CAN ID to forward.
   */
  async resetMcConfToDefaults(targetCanId, timeoutMs = 6000) {
    const defaults = await this.requestMcConfDefaultRaw(targetCanId, timeoutMs);

    const inner = new Uint8Array(1 + defaults.length);
    inner[0] = COMM.SET_MCCONF;
    inner.set(defaults, 1);

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
   * Reset MCCONF to firmware defaults on BOTH sides of the board,
   * mirroring writeMcConfBothSides: always direct, and — if a linked
   * CAN ID is known — also forwarded to that motor.
   */
  async resetMcConfToDefaultsBothSides(timeoutMs = 6000) {
    await this.resetMcConfToDefaults(null, timeoutMs);
    if (this.targetCanId == null) {
      return { direct: true, linked: null };
    }
    try {
      await this.resetMcConfToDefaults(this.targetCanId, timeoutMs);
      return { direct: true, linked: true };
    } catch (err) {
      return { direct: true, linked: false, linkedError: err.message };
    }
  }

  /**
   * Request the firmware's compiled-in default APPCONF blob
   * (COMM_GET_APPCONF_DEFAULT). Same forwarding convention as the
   * rest of the APPCONF methods (implicit this.targetCanId, single
   * target — app-level config only lives on one physical side of a
   * dual-motor board, unlike MCCONF).
   */
  async requestAppConfDefaultRaw(timeoutMs = 4000) {
    const packet = this.targetCanId != null
      ? buildForwardedCommand(this.targetCanId, Uint8Array.of(COMM.GET_APPCONF_DEFAULT))
      : buildSimpleCommand(COMM.GET_APPCONF_DEFAULT);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingAppConfDefaultRead = null;
        reject(new Error('Timed out waiting for APPCONF defaults'));
      }, timeoutMs);
      this._pendingAppConfDefaultRead = (bytes) => {
        clearTimeout(timer);
        this._pendingAppConfDefaultRead = null;
        resolve(bytes);
      };
      this._write(packet).catch((err) => {
        clearTimeout(timer);
        this._pendingAppConfDefaultRead = null;
        reject(err);
      });
    });
  }

  /**
   * Reset APPCONF to firmware defaults: read the compiled-in default
   * blob and write it straight back unmodified via COMM_SET_APPCONF.
   */
  async resetAppConfToDefaults(timeoutMs = 6000) {
    const defaults = await this.requestAppConfDefaultRaw(timeoutMs);

    const inner = new Uint8Array(1 + defaults.length);
    inner[0] = COMM.SET_APPCONF;
    inner.set(defaults, 1);

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
   * Ask the connected board which other CAN devices it knows about.
   * Response handler surfaces raw bytes via onPingCanResult, same as
   * vesc-usb.js.
   */
  async requestPingCan() {
    await this._write(buildSimpleCommand(COMM.PING_CAN));
  }

  /**
   * Promise-based auto-detect of a linked CAN VESC — same PING_CAN
   * scan the dashboard's "LINKED VESC" button uses, just awaitable,
   * via its own pending-resolver slot rather than onPingCanResult so
   * it doesn't collide with whatever the dashboard has that callback
   * set to mid-scan. Resolves with a CAN ID, or null if the scan
   * found nothing.
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
      // Firmware's confirmation that the write was received and applied.
      if (this._pendingAppConfWriteAck) this._pendingAppConfWriteAck();
    } else if (commId === COMM.DETECT_MOTOR_R_L) {
      const result = parseMotorRL(body);
      if (this._pendingMotorRL) this._pendingMotorRL(result);
    } else if (commId === COMM.GET_MCCONF) {
      if (this._pendingMcConfRead) this._pendingMcConfRead(body);
    } else if (commId === COMM.SET_MCCONF) {
      // Firmware's confirmation the write was received, applied, and
      // stored to flash — same bare-command-byte pattern as SET_APPCONF.
      if (this._pendingMcConfWriteAck) this._pendingMcConfWriteAck();
    } else if (commId === COMM.DETECT_APPLY_ALL_FOC) {
      const result = parseDetectApplyAllFoc(body);
      if (this._pendingDetectApplyAllFoc) this._pendingDetectApplyAllFoc(result);
    } else if (commId === COMM.FW_VERSION) {
      const fw = parseFwVersion(body);
      if (this._pendingFwVersion) this._pendingFwVersion(fw);
    } else if (commId === COMM.GET_MCCONF_DEFAULT) {
      if (this._pendingMcConfDefaultRead) this._pendingMcConfDefaultRead(body);
    } else if (commId === COMM.GET_APPCONF_DEFAULT) {
      if (this._pendingAppConfDefaultRead) this._pendingAppConfDefaultRead(body);
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
  startAdcPolling(intervalMs = 150) {
    const handle = setInterval(() => {
      this.requestDecodedAdc().catch((err) => this._log(`adc poll error: ${err.message}`));
    }, intervalMs);
    return () => clearInterval(handle);
  }
}
