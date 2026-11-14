/// <reference types="vite/client" />

type SerialParity = 'none' | 'even' | 'odd';
type SerialFlowControl = 'none' | 'hardware';

interface SerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
}

interface SerialOptions {
  baudRate: number;
  dataBits?: 7 | 8;
  stopBits?: 1 | 2;
  parity?: SerialParity;
  bufferSize?: number;
  flowControl?: SerialFlowControl;
}

interface SerialOutputSignals {
  dataTerminalReady?: boolean;
  requestToSend?: boolean;
  break?: boolean;
}

interface SerialInputSignals {
  dataCarrierDetect: boolean;
  clearToSend: boolean;
  ringIndicator: boolean;
  dataSetReady: boolean;
}

interface SerialPort {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open(options: SerialOptions): Promise<void>;
  close(): Promise<void>;
  forget?(): Promise<void>;
  getInfo(): SerialPortInfo;
  setSignals(signals: SerialOutputSignals): Promise<void>;
  getSignals(): Promise<SerialInputSignals>;
}

interface SerialPortRequestOptions {
  filters?: Array<{
    usbVendorId?: number;
    usbProductId?: number;
  }>;
}

interface Serial {
  requestPort(options?: SerialPortRequestOptions): Promise<SerialPort>;
  getPorts(): Promise<SerialPort[]>;
  addEventListener(type: 'connect' | 'disconnect', listener: (event: Event) => void): void;
  removeEventListener(type: 'connect' | 'disconnect', listener: (event: Event) => void): void;
}

interface MIDIOptions {
  sysex?: boolean;
}

interface MIDIOutput {
  id: string;
  manufacturer?: string | null;
  name?: string | null;
  state?: 'connected' | 'disconnected';
  send(data: number[] | Uint8Array, timestamp?: number): void;
}

interface MIDIOutputMap {
  values(): IterableIterator<MIDIOutput>;
}

interface MIDIAccess {
  outputs: MIDIOutputMap;
}

interface Navigator {
  serial?: Serial;
  requestMIDIAccess?(options?: MIDIOptions): Promise<MIDIAccess>;
}
