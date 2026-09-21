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
 * ------------------------------------------------------------------
 */

import { PacketAssembler, buildSimpleCommand, parseGetValues, parseDecodedAdc, COMM } from './vesc-protocol.js';

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
    this.onConnectionChange = null; // (connected: boolean) => void
    this.onLog = null;         // (msg: string) => void
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
   */
  async _writeChunked(bytes, chunkSize = 20) {
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.slice(i, i + chunkSize);
      await this.rxChar.writeValue(chunk);
    }
  }

  async requestValues() {
    if (!this.isConnected || !this.rxChar) throw new Error('NOT_CONNECTED');
    const packet = buildSimpleCommand(COMM.GET_VALUES);
    await this._writeChunked(packet);
  }

  async requestDecodedAdc() {
    if (!this.isConnected || !this.rxChar) throw new Error('NOT_CONNECTED');
    const packet = buildSimpleCommand(COMM.GET_DECODED_ADC);
    await this._writeChunked(packet);
  }

  _handlePacket(payload) {
    if (payload.length === 0) return;
    const commId = payload[0];
    const body = payload.slice(1);

    if (commId === COMM.GET_VALUES) {
      const values = parseGetValues(body);
      if (values && this.onValues) this.onValues(values);
    } else if (commId === COMM.GET_DECODED_ADC) {
      const adc = parseDecodedAdc(body);
      if (adc && this.onDecodedAdc) this.onDecodedAdc(adc);
    }
    // Other comm IDs (FW_VERSION, MCCONF, etc.) get handled here as
    // we add the screens that need them.
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
