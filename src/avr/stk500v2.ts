import { LogSink } from '../lib/logger';
import { formatHexByte } from '../lib/format';
import { SerialTransport, sleep } from './serialTransport';

const MESSAGE_START = 0x1b;
const TOKEN = 0x0e;

const CMD_SIGN_ON = 0x01;
const CMD_SET_PARAMETER = 0x02;
const CMD_GET_PARAMETER = 0x03;
const CMD_LOAD_ADDRESS = 0x06;
const CMD_ENTER_PROGMODE_ISP = 0x10;
const CMD_LEAVE_PROGMODE_ISP = 0x11;
const CMD_CHIP_ERASE_ISP = 0x12;
const CMD_PROGRAM_FLASH_ISP = 0x13;
const CMD_READ_FLASH_ISP = 0x14;
const CMD_READ_SIGNATURE_ISP = 0x1b;

const STATUS_CMD_OK = 0x00;
const STATUS_CMD_TOUT = 0x80;
const STATUS_RDY_BSY_TOUT = 0x81;
const STATUS_CMD_FAILED = 0xc0;
const STATUS_CKSUM_ERROR = 0xc1;
const STATUS_CMD_UNKNOWN = 0xc9;

const PARAM_BUILD_NUMBER_LOW = 0x80;
const PARAM_BUILD_NUMBER_HIGH = 0x81;
const PARAM_HW_VER = 0x90;
const PARAM_SW_MAJOR = 0x91;
const PARAM_SW_MINOR = 0x92;

function statusToText(status: number | undefined): string {
  if (status === undefined) return 'Missing status';

  switch (status) {
    case STATUS_CMD_OK:
      return 'OK';
    case STATUS_CMD_TOUT:
      return 'Command timed out';
    case STATUS_RDY_BSY_TOUT:
      return 'Ready/busy timeout';
    case STATUS_CMD_FAILED:
      return 'Command failed';
    case STATUS_CKSUM_ERROR:
      return 'Checksum error';
    case STATUS_CMD_UNKNOWN:
      return 'Unknown command';
    default:
      return `Status ${formatHexByte(status)}`;
  }
}

function xorChecksum(bytes: number[]): number {
  return bytes.reduce((checksum, value) => checksum ^ value, 0) & 0xff;
}

function decodeAscii(bytes: Uint8Array): string {
  return [...bytes]
    .filter((byte) => byte >= 0x20 && byte <= 0x7e)
    .map((byte) => String.fromCharCode(byte))
    .join('');
}

export class Stk500v2Programmer {
  private readonly transport: SerialTransport;
  private readonly log: LogSink;
  private sequence = 1;

  constructor(transport: SerialTransport, log: LogSink) {
    this.transport = transport;
    this.log = log;
  }

  async connect(): Promise<string> {
    this.log('info', 'Syncing with STK500v2 bootloader...');
    this.log('debug', 'Sending repeated STK500v2 sign-on probes for up to 10 seconds.');
    let lastError: unknown;

    await this.transport.drainQuietly(50);

    for (let attempt = 1; attempt <= 20; attempt += 1) {
      try {
        await this.writeCommandFrame(CMD_SIGN_ON, [], this.sequence);
        const frame = await this.readFrame(700, this.sequence, true, [CMD_SIGN_ON]);
        const response = frame.body;
        this.ensureStatus(response, CMD_SIGN_ON);
        const nameLength = response[2] ?? 0;
        const name = decodeAscii(response.slice(3, 3 + nameLength)) || decodeAscii(response.slice(2));
        this.log('success', `Bootloader responded: ${name || 'STK500v2'}.`);
        this.sequence = (this.sequence + 1) & 0xff;
        return name || 'STK500v2';
      } catch (error) {
        lastError = error;
        this.log('debug', `Sync attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`);
        await sleep(50);
      }
    }

    throw new Error(`Could not sync with STK500v2 bootloader. ${lastError instanceof Error ? lastError.message : ''}`.trim());
  }

  async readVersion(): Promise<string> {
    const values = await Promise.all([
      this.getParameter(PARAM_HW_VER).catch(() => undefined),
      this.getParameter(PARAM_SW_MAJOR).catch(() => undefined),
      this.getParameter(PARAM_SW_MINOR).catch(() => undefined),
      this.getParameter(PARAM_BUILD_NUMBER_HIGH).catch(() => undefined),
      this.getParameter(PARAM_BUILD_NUMBER_LOW).catch(() => undefined),
    ]);

    const [hw, major, minor, buildHigh, buildLow] = values;
    const build = buildHigh !== undefined && buildLow !== undefined ? (buildHigh << 8) | buildLow : undefined;
    const version = `HW ${hw ?? '?'}, SW ${major ?? '?'}.${minor ?? '?'}${build !== undefined ? `, build ${build}` : ''}`;
    this.log('info', `Programmer version: ${version}.`);
    return version;
  }

  async enterProgrammingMode(): Promise<void> {
    const payload = [
      0xc8, // timeout ms; matches AVRDUDE m2560 part parameters
      0x64, // stab delay ms
      0x19, // command execution delay ms
      0x20, // synch loops
      0x00, // byte delay
      0x53, // poll value
      0x03, // poll index
      0xac,
      0x53,
      0x00,
      0x00,
    ];
    const response = await this.command(CMD_ENTER_PROGMODE_ISP, payload, 1500);
    this.ensureStatus(response, CMD_ENTER_PROGMODE_ISP);
    this.log('success', 'Entered programming mode.');
  }

  async leaveProgrammingMode(): Promise<void> {
    try {
      const response = await this.command(CMD_LEAVE_PROGMODE_ISP, [0x01, 0x01], 1500);
      this.ensureStatus(response, CMD_LEAVE_PROGMODE_ISP);
      this.log('success', 'Left programming mode.');
    } catch (error) {
      this.log('warn', `Could not leave programming mode cleanly: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async readSignature(): Promise<[number, number, number]> {
    const bytes: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      // Bootloaders derived from Arduino's STK500v2 code read the signature index from msgBuffer[4].
      const response = await this.command(CMD_READ_SIGNATURE_ISP, [0x00, 0x30, 0x00, index, 0x00], 1500);
      if (response.length < 4) throw new Error('Signature response was too short.');
      if (response[0] !== CMD_READ_SIGNATURE_ISP) throw new Error('Signature response used the wrong command id.');
      if (response[1] !== STATUS_CMD_OK || response[3] !== STATUS_CMD_OK) {
        throw new Error(`Signature read failed: ${statusToText(response[1])} / ${statusToText(response[3])}.`);
      }
      bytes.push(response[2]);
    }
    const signature: [number, number, number] = [bytes[0], bytes[1], bytes[2]];
    this.log('info', `Device signature: ${signature.map(formatHexByte).join(' ')}.`);
    return signature;
  }

  async chipEraseBestEffort(): Promise<void> {
    try {
      const response = await this.command(
        CMD_CHIP_ERASE_ISP,
        [0xac, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00],
        2500,
      );
      if (response[1] === STATUS_CMD_OK) {
        this.log('success', 'Chip erase command accepted.');
      } else {
        this.log('debug', `Chip erase not accepted by bootloader (${statusToText(response[1])}); continuing because page writes usually erase as needed.`);
      }
    } catch (error) {
      this.log('debug', `Chip erase skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async loadAddress(byteAddress: number, largeFlash: boolean): Promise<void> {
    let wordAddress = byteAddress >>> 1;
    if (largeFlash) wordAddress = (wordAddress | 0x80000000) >>> 0;
    const payload = [
      (wordAddress >>> 24) & 0xff,
      (wordAddress >>> 16) & 0xff,
      (wordAddress >>> 8) & 0xff,
      wordAddress & 0xff,
    ];
    const response = await this.command(CMD_LOAD_ADDRESS, payload, 1500);
    this.ensureStatus(response, CMD_LOAD_ADDRESS);
  }

  async programFlashPage(byteAddress: number, page: Uint8Array, largeFlash: boolean): Promise<void> {
    await this.loadAddress(byteAddress, largeFlash);
    const length = page.length;
    const payload = [
      (length >>> 8) & 0xff,
      length & 0xff,
      0xc1, // page mode + write page + timed delay; common avrdude value for flash page write
      0x0a, // delay
      0x40, // load program memory page, low byte
      0x4c, // write program memory page
      0x20, // read program memory
      0x00, // poll1
      0x00, // poll2
      ...page,
    ];
    const response = await this.command(CMD_PROGRAM_FLASH_ISP, payload, 3500);
    this.ensureStatus(response, CMD_PROGRAM_FLASH_ISP);
  }

  async readFlash(byteAddress: number, length: number, largeFlash: boolean): Promise<Uint8Array> {
    await this.loadAddress(byteAddress, largeFlash);
    const response = await this.command(
      CMD_READ_FLASH_ISP,
      [
        (length >>> 8) & 0xff,
        length & 0xff,
        0x20, // read low byte; firmware handles low/high selection in paged mode
        0x00,
        0x00,
        0x00,
      ],
      Math.max(2500, 1000 + length * 8),
    );

    if (response.length < 3) throw new Error('Flash read response was too short.');
    if (response[0] !== CMD_READ_FLASH_ISP) throw new Error('Flash read response used the wrong command id.');
    if (response[1] !== STATUS_CMD_OK) throw new Error(`Flash read failed: ${statusToText(response[1])}.`);
    const status2 = response[response.length - 1];
    if (status2 !== STATUS_CMD_OK) throw new Error(`Flash read ended with ${statusToText(status2)}.`);
    const data = response.slice(2, response.length - 1);
    if (data.length !== length) {
      throw new Error(`Flash read returned ${data.length} byte(s), expected ${length}.`);
    }
    return data;
  }

  private async getParameter(parameter: number): Promise<number> {
    const response = await this.command(CMD_GET_PARAMETER, [parameter], 1200);
    this.ensureStatus(response, CMD_GET_PARAMETER);
    if (response.length < 3) throw new Error('Parameter response was too short.');
    return response[2];
  }

  private ensureStatus(response: Uint8Array, expectedCommand: number): void {
    if (response.length < 2) throw new Error('Response was too short.');
    if (response[0] !== expectedCommand) {
      throw new Error(`Unexpected response command ${formatHexByte(response[0])}; expected ${formatHexByte(expectedCommand)}.`);
    }
    if (response[1] !== STATUS_CMD_OK) {
      throw new Error(statusToText(response[1]));
    }
  }

  private async command(commandId: number, payload: number[] | Uint8Array, timeoutMs: number): Promise<Uint8Array> {
    const sequence = this.sequence;

    await this.writeCommandFrame(commandId, payload, sequence);
    const response = await this.readFrame(timeoutMs, sequence, true, [commandId, ...payload]);

    if (response.sequence !== sequence) {
      throw new Error(`Response sequence ${response.sequence} did not match request ${sequence}.`);
    }

    this.sequence = (this.sequence + 1) & 0xff;
    return response.body;
  }

  private async writeCommandFrame(commandId: number, payload: number[] | Uint8Array, sequence: number): Promise<void> {
    const body = [commandId, ...payload];
    const length = body.length;
    const frame = [MESSAGE_START, sequence, (length >>> 8) & 0xff, length & 0xff, TOKEN, ...body];
    frame.push(xorChecksum(frame));
    await this.transport.write(frame);
  }

  private async readFrame(
    timeoutMs: number,
    expectedSequence: number,
    resync: boolean,
    ignoreEchoBody: number[] = [],
  ): Promise<{ sequence: number; body: Uint8Array }> {
    const deadline = Date.now() + timeoutMs;
    const buffer: number[] = [];
    let lastError: unknown;

    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        if (lastError instanceof Error) throw lastError;
        throw new Error('Timed out waiting for STK500v2 response frame.');
      }

      try {
        buffer.push(await this.transport.readByte(remaining));

        while (buffer.length > 0 && buffer[0] !== MESSAGE_START) buffer.shift();
        if (buffer.length < 5) continue;

        const sequence = buffer[1];
        const length = (buffer[2] << 8) | buffer[3];
        const token = buffer[4];

        if (token !== TOKEN) {
          const error = new Error(`Bad STK500v2 token ${formatHexByte(token)}.`);
          if (!resync) throw error;
          lastError = error;
          buffer.shift();
          continue;
        }

        if (length <= 0 || length > 4096) {
          const error = new Error(`Invalid STK500v2 response length ${length}.`);
          if (!resync) throw error;
          lastError = error;
          buffer.shift();
          continue;
        }

        const frameLength = 5 + length + 1;
        if (buffer.length < frameLength) continue;

        const frame = buffer.slice(0, frameLength);
        buffer.splice(0, frameLength);
        const body = frame.slice(5, 5 + length);
        const checksum = frame[frame.length - 1];
        const expectedChecksum = xorChecksum(frame.slice(0, frame.length - 1));
        if (checksum !== expectedChecksum) {
          const error = new Error(`Bad STK500v2 checksum; got ${formatHexByte(checksum)}, expected ${formatHexByte(expectedChecksum)}.`);
          if (!resync) throw error;
          lastError = error;
          continue;
        }

        if (sequence !== expectedSequence) {
          const error = new Error(`Response sequence ${sequence} did not match request ${expectedSequence}.`);
          if (!resync) throw error;
          lastError = error;
          continue;
        }

        if (ignoreEchoBody.length > 0 && body.length === ignoreEchoBody.length && body.every((byte, index) => byte === ignoreEchoBody[index])) {
          lastError = new Error('Ignored echoed STK500v2 command frame.');
          continue;
        }

        return { sequence, body: Uint8Array.from(body) };
      } catch (error) {
        if (!resync) throw error;
        lastError = error;
      }
    }
  }
}
