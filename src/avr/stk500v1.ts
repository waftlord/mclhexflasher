import { LogSink } from '../lib/logger';
import { formatHexByte } from '../lib/format';
import { SerialTransport, sleep } from './serialTransport';

const CRC_EOP = 0x20;
const STK_OK = 0x10;
const STK_INSYNC = 0x14;
const STK_NOSYNC = 0x15;

const STK_GET_SYNC = 0x30;
const STK_GET_PARAMETER = 0x41;
const STK_ENTER_PROGMODE = 0x50;
const STK_LEAVE_PROGMODE = 0x51;
const STK_LOAD_ADDRESS = 0x55;
const STK_UNIVERSAL = 0x56;
const STK_PROG_PAGE = 0x64;
const STK_READ_PAGE = 0x74;

const PARAM_SW_MAJOR = 0x81;
const PARAM_SW_MINOR = 0x82;

function statusToText(status: number): string {
  switch (status) {
    case STK_OK:
      return 'OK';
    case STK_INSYNC:
      return 'INSYNC';
    case STK_NOSYNC:
      return 'NOSYNC';
    default:
      return `Status ${formatHexByte(status)}`;
  }
}

export class Stk500v1Programmer {
  private readonly transport: SerialTransport;
  private readonly log: LogSink;
  private extendedAddressByte = 0;

  constructor(transport: SerialTransport, log: LogSink) {
    this.transport = transport;
    this.log = log;
  }

  async connect(): Promise<string> {
    this.log('info', 'Syncing with STK500v1/Optiboot bootloader...');
    let lastError: unknown;

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      try {
        await this.transport.drainQuietly(25);
        await this.command([STK_GET_SYNC], 0, 700);
        this.log('success', 'Bootloader responded: STK500v1/Optiboot.');
        return 'STK500v1/Optiboot';
      } catch (error) {
        lastError = error;
        this.log('debug', `Sync attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`);
        await sleep(120);
      }
    }

    throw new Error(`Could not sync with STK500v1 bootloader. ${lastError instanceof Error ? lastError.message : ''}`.trim());
  }

  async readVersion(): Promise<string> {
    const major = await this.getParameter(PARAM_SW_MAJOR).catch(() => undefined);
    const minor = await this.getParameter(PARAM_SW_MINOR).catch(() => undefined);
    const version = `SW ${major ?? '?'}.${minor ?? '?'}`;
    this.log('info', `Programmer version: ${version}.`);
    return version;
  }

  async enterProgrammingMode(): Promise<void> {
    await this.command([STK_ENTER_PROGMODE], 0, 700).catch(() => undefined);
    this.log('success', 'Entered programming mode.');
  }

  async leaveProgrammingMode(): Promise<void> {
    try {
      await this.command([STK_LEAVE_PROGMODE], 0, 700);
      this.log('success', 'Left programming mode.');
    } catch (error) {
      this.log('warn', `Could not leave programming mode cleanly: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async readSignature(): Promise<[number, number, number]> {
    const bytes: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      bytes.push(await this.universal(0x30, 0x00, index, 0x00));
    }

    const signature: [number, number, number] = [bytes[0], bytes[1], bytes[2]];
    this.log('info', `Device signature: ${signature.map(formatHexByte).join(' ')}.`);
    return signature;
  }

  async loadAddress(byteAddress: number): Promise<void> {
    const wordAddress = byteAddress >>> 1;
    const extendedAddressByte = (wordAddress >>> 16) & 0xff;
    if (extendedAddressByte !== this.extendedAddressByte) {
      await this.loadExtendedAddress(extendedAddressByte);
    }
    await this.command([STK_LOAD_ADDRESS, wordAddress & 0xff, (wordAddress >>> 8) & 0xff], 0, 900);
  }

  async programFlashPage(byteAddress: number, page: Uint8Array): Promise<void> {
    await this.loadAddress(byteAddress);
    await this.command([STK_PROG_PAGE, (page.length >>> 8) & 0xff, page.length & 0xff, 0x46, ...page], 0, 2500);
  }

  async readFlash(byteAddress: number, length: number): Promise<Uint8Array> {
    await this.loadAddress(byteAddress);
    return this.command([STK_READ_PAGE, (length >>> 8) & 0xff, length & 0xff, 0x46], length, Math.max(1500, 500 + length * 8));
  }

  private async getParameter(parameter: number): Promise<number> {
    const response = await this.command([STK_GET_PARAMETER, parameter], 1, 900);
    return response[0];
  }

  private async universal(byte0: number, byte1: number, byte2: number, byte3: number): Promise<number> {
    const response = await this.command([STK_UNIVERSAL, byte0, byte1, byte2, byte3], 1, 900);
    return response[0];
  }

  private async loadExtendedAddress(extendedAddressByte: number): Promise<void> {
    await this.universal(0x4d, 0x00, extendedAddressByte, 0x00);
    this.extendedAddressByte = extendedAddressByte;
  }

  private async command(payload: number[] | Uint8Array, responseLength: number, timeoutMs: number): Promise<Uint8Array> {
    await this.transport.write([...payload, CRC_EOP]);

    const start = await this.transport.readByte(timeoutMs);
    if (start !== STK_INSYNC) {
      await this.transport.drainQuietly(40).catch(() => undefined);
      throw new Error(`Expected INSYNC ${formatHexByte(STK_INSYNC)}, got ${statusToText(start)}.`);
    }

    const response = responseLength > 0 ? await this.transport.readExact(responseLength, timeoutMs) : new Uint8Array();
    const end = await this.transport.readByte(timeoutMs);
    if (end !== STK_OK) {
      await this.transport.drainQuietly(40).catch(() => undefined);
      throw new Error(`Expected OK ${formatHexByte(STK_OK)}, got ${statusToText(end)}.`);
    }

    return response;
  }
}
