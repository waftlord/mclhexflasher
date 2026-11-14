export class TimeoutError extends Error {
  readonly partial?: number[];

  constructor(message: string, partial?: number[]) {
    super(message);
    this.name = 'TimeoutError';
    this.partial = partial;
  }
}

export class DeviceDisconnectedError extends Error {
  constructor(message = 'Serial device disconnected.') {
    super(message);
    this.name = 'DeviceDisconnectedError';
  }
}

type Waiter = {
  resolve: () => void;
  reject: (error: Error) => void;
};

const MAX_RX_BUFFER_BYTES = 128 * 1024;

export class SerialTransport {
  private readonly port: SerialPort;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private writer?: WritableStreamDefaultWriter<Uint8Array>;
  private rx: number[] = [];
  private waiters: Waiter[] = [];
  private closed = false;
  private readLoopDone?: Promise<void>;

  constructor(port: SerialPort) {
    this.port = port;
  }

  async open(baudRate: number): Promise<void> {
    this.closed = false;
    await this.port.open({
      baudRate,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
      bufferSize: 64 * 1024,
    });

    if (!this.port.readable || !this.port.writable) {
      throw new Error('Serial port opened but readable/writable streams are unavailable.');
    }

    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this.readLoopDone = this.pumpReads();
  }

  getInfo(): SerialPortInfo {
    return this.port.getInfo();
  }

  async setSignals(signals: SerialOutputSignals): Promise<void> {
    await this.port.setSignals(signals);
  }

  async write(data: Uint8Array | number[]): Promise<void> {
    if (this.closed) throw new DeviceDisconnectedError('Serial port is closed.');
    if (!this.writer) throw new Error('Serial port is not open for writing.');
    await this.writer.write(data instanceof Uint8Array ? data : Uint8Array.from(data));
  }

  async drainQuietly(settleMs = 80): Promise<void> {
    this.rx = [];
    await sleep(settleMs);
    this.rx = [];
  }

  async readByte(timeoutMs: number): Promise<number> {
    const data = await this.readExact(1, timeoutMs);
    return data[0];
  }

  async readExact(length: number, timeoutMs: number): Promise<Uint8Array> {
    if (!Number.isInteger(length) || length < 0) {
      throw new Error(`Invalid serial read length: ${length}`);
    }
    if (length === 0) return new Uint8Array();

    const deadline = Date.now() + timeoutMs;
    while (this.rx.length < length) {
      if (this.closed) throw new DeviceDisconnectedError();
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        const partial = this.rx.slice(0, Math.min(this.rx.length, 16));
        throw new TimeoutError(
          `Timed out waiting for ${length} serial byte(s). Received ${this.rx.length}${partial.length > 0 ? `: ${formatByteList(partial)}` : ''}.`,
          partial,
        );
      }
      await this.waitForData(remaining);
    }

    const result = this.rx.splice(0, length);
    return Uint8Array.from(result);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.rejectWaiters(new DeviceDisconnectedError('Serial port closed.'));

    const reader = this.reader;
    const writer = this.writer;
    this.reader = undefined;
    this.writer = undefined;

    try {
      await reader?.cancel();
    } catch {
      // Ignore cancel errors during close.
    }
    try {
      reader?.releaseLock();
    } catch {
      // Ignore release errors during close.
    }
    try {
      writer?.releaseLock();
    } catch {
      // Ignore release errors during close.
    }
    try {
      await this.readLoopDone;
    } catch {
      // Ignore read-loop failures during close.
    }
    try {
      await this.port.close();
    } catch {
      // Port may already be closed/disconnected.
    }
  }

  private async pumpReads(): Promise<void> {
    let closeError: Error | null = null;

    try {
      while (!this.closed && this.reader) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value && value.length > 0) {
          for (const byte of value) this.rx.push(byte);
          if (this.rx.length > MAX_RX_BUFFER_BYTES) {
            this.rx.splice(0, this.rx.length - MAX_RX_BUFFER_BYTES);
          }
          this.resolveWaiters();
        }
      }
    } catch (error) {
      closeError = error instanceof Error ? error : new Error(String(error));
    }

    if (!this.closed) {
      this.closed = true;
      this.rejectWaiters(closeError ?? new DeviceDisconnectedError());
    }
  }

  private waitForData(timeoutMs: number): Promise<void> {
    if (this.rx.length > 0) return Promise.resolve();
    if (this.closed) return Promise.reject(new DeviceDisconnectedError());

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      const timer = window.setTimeout(() => {
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        reject(new TimeoutError('Timed out waiting for serial data.'));
      }, timeoutMs);

      waiter.resolve = () => {
        window.clearTimeout(timer);
        resolve();
      };
      waiter.reject = (error: Error) => {
        window.clearTimeout(timer);
        reject(error);
      };

      this.waiters.push(waiter);
    });
  }

  private resolveWaiters(): void {
    const waiters = this.waiters.splice(0);
    waiters.forEach((waiter) => waiter.resolve());
  }

  private rejectWaiters(error: Error): void {
    const waiters = this.waiters.splice(0);
    waiters.forEach((waiter) => waiter.reject(error));
  }
}

function formatByteList(bytes: number[]): string {
  return bytes.map((byte) => `0x${byte.toString(16).padStart(2, '0').toUpperCase()}`).join(' ');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
