import { LogSink } from '../lib/logger';
import { formatBytes, formatHexAddress, percent } from '../lib/format';
import { FirmwareImage, makeFirmwarePages } from './intelHex';
import { HardwareProfile } from './profiles';
import { SerialTransport, sleep } from './serialTransport';
import { Stk500v1Programmer } from './stk500v1';
import { Stk500v2Programmer } from './stk500v2';

const UI_PAINT_INTERVAL_PAGES = 8;

export type FlashStage =
  | 'idle'
  | 'opening'
  | 'resetting'
  | 'syncing'
  | 'checking'
  | 'writing'
  | 'verifying'
  | 'rebooting'
  | 'done'
  | 'error';

export interface FlashProgress {
  stage: FlashStage;
  percent: number;
  message: string;
}

export interface FlashOptions {
  port: SerialPort;
  profile: HardwareProfile;
  image: FirmwareImage;
  verify: boolean;
  log: LogSink;
  onProgress: (progress: FlashProgress) => void;
  signal?: AbortSignal;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Flash cancelled.');
}

function signaturesMatch(actual: [number, number, number], expected: [number, number, number]): boolean {
  return actual[0] === expected[0] && actual[1] === expected[1] && actual[2] === expected[2];
}

function signatureText(signature: [number, number, number]): string {
  return signature.map((byte) => `0x${byte.toString(16).padStart(2, '0').toUpperCase()}`).join(' ');
}

function firstMismatch(expected: Uint8Array, actual: Uint8Array): number | undefined {
  const length = Math.min(expected.length, actual.length);
  for (let i = 0; i < length; i += 1) {
    if (expected[i] !== actual[i]) return i;
  }
  return expected.length === actual.length ? undefined : length;
}

function byteHex(value: number | undefined): string {
  return typeof value === 'number' ? `0x${value.toString(16).padStart(2, '0').toUpperCase()}` : '??';
}

async function yieldForProgress(index: number, total: number): Promise<void> {
  if (index === 0 || index + 1 === total || (index + 1) % UI_PAINT_INTERVAL_PAGES === 0) {
    await sleep(0);
  }
}

async function resetForBootloader(transport: SerialTransport, profile: HardwareProfile, log: LogSink): Promise<void> {
  if (profile.resetStrategy === 'wiring-dtr-toggle') {
    log('info', 'Using MegaCommand DIY Wiring reset pulse: release DTR/RTS for 50 ms, assert for 50 ms, release, then sync.');
    await transport.setSignals({ dataTerminalReady: false, requestToSend: false }).catch(() => undefined);
    await sleep(50);
    await transport.setSignals({ dataTerminalReady: true, requestToSend: true }).catch(() => undefined);
    await sleep(50);
    await transport.setSignals({ dataTerminalReady: false, requestToSend: false }).catch(() => undefined);
    await sleep(50);
    await transport.drainQuietly(50);
    return;
  }

  if (profile.resetStrategy === 'dtr-toggle') {
    log('info', 'Toggling DTR/RTS to request bootloader reset...');
    await transport.setSignals({ dataTerminalReady: false, requestToSend: false }).catch(() => undefined);
    await sleep(120);
    await transport.setSignals({ dataTerminalReady: true, requestToSend: true }).catch(() => undefined);
    await sleep(120);
    await transport.setSignals({ dataTerminalReady: false, requestToSend: false }).catch(() => undefined);
    await sleep(profile.protocol === 'stk500v2' ? 1200 : 550);
    await transport.drainQuietly(profile.protocol === 'stk500v2' ? 100 : 50);
    return;
  }

  throw new Error(`Unsupported reset strategy: ${profile.resetStrategy satisfies never}`);
}

async function releaseResetSignalsForClose(transport: SerialTransport, profile: HardwareProfile, log: LogSink): Promise<void> {
  if (profile.resetStrategy !== 'wiring-dtr-toggle') return;

  await transport.setSignals({ dataTerminalReady: false, requestToSend: false }).catch((error) => {
    log('debug', `Could not release DTR/RTS before close: ${error instanceof Error ? error.message : String(error)}`);
  });
}

export async function flashFirmware(options: FlashOptions): Promise<void> {
  const { port, profile, image, verify, log, onProgress, signal } = options;

  if (image.maxAddressExclusive > profile.flashSize) {
    throw new Error(
      `HEX ends at ${formatHexAddress(image.maxAddressExclusive)}, beyond ${profile.mcu} flash size ${formatHexAddress(profile.flashSize)}.`,
    );
  }

  const pages = makeFirmwarePages(image, profile.pageSize);
  if (pages.length === 0) throw new Error('No firmware pages to write.');

  const largeFlash = profile.flashSize > 0x10000;
  const transport = new SerialTransport(port);

  try {
    onProgress({ stage: 'opening', percent: 2, message: `Opening serial port at ${profile.baudRate} baud...` });
    await transport.open(profile.baudRate);
    log('success', `Opened serial port at ${profile.baudRate} baud.`);

    onProgress({ stage: 'resetting', percent: 5, message: 'Preparing bootloader...' });
    await resetForBootloader(transport, profile, log);

    assertNotAborted(signal);
    onProgress({ stage: 'syncing', percent: 8, message: 'Syncing with bootloader...' });

    if (profile.protocol === 'stk500v2') {
      const programmer = new Stk500v2Programmer(transport, log);
      try {
        await programmer.connect();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not sync with Wiring/STK500v2 bootloader. ${message}`.trim());
      }
      await programmer.readVersion().catch((error) => log('debug', `Version query skipped: ${error instanceof Error ? error.message : String(error)}`));
      await programmer.enterProgrammingMode().catch((error) => log('debug', `Enter programming mode returned: ${error instanceof Error ? error.message : String(error)}`));

      await verifySignatureIfAvailable(programmer, profile, log, onProgress);
      await programmer.chipEraseBestEffort();

      await writeStk500v2(programmer, pages, image.usedBytes, largeFlash, log, onProgress, signal);
      if (verify) await verifyStk500v2(programmer, pages, largeFlash, log, onProgress, signal);
      else log('warn', 'Readback verification is disabled.');

      onProgress({ stage: 'rebooting', percent: 98, message: 'Leaving bootloader...' });
      await programmer.leaveProgrammingMode();
    } else {
      await flashStk500v1Flow(new Stk500v1Programmer(transport, log), profile, pages, image.usedBytes, verify, log, onProgress, signal);
    }

    onProgress({ stage: 'done', percent: 100, message: `Firmware update complete. Wrote ${formatBytes(image.usedBytes)} across ${pages.length} page(s).` });
    log('success', 'Firmware update complete.');
  } finally {
    await releaseResetSignalsForClose(transport, profile, log);
    await transport.close();
  }
}

async function flashStk500v1Flow(
  programmer: Stk500v1Programmer,
  profile: HardwareProfile,
  pages: ReturnType<typeof makeFirmwarePages>,
  usedBytes: number,
  verify: boolean,
  log: LogSink,
  onProgress: (progress: FlashProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  await programmer.connect();
  await programmer.readVersion().catch((error) => log('debug', `Version query skipped: ${error instanceof Error ? error.message : String(error)}`));
  await programmer.enterProgrammingMode();

  await verifySignatureIfAvailable(programmer, profile, log, onProgress);
  await writeStk500v1(programmer, pages, usedBytes, log, onProgress, signal);
  if (verify) await verifyStk500v1(programmer, pages, log, onProgress, signal);
  else log('warn', 'Readback verification is disabled.');

  onProgress({ stage: 'rebooting', percent: 98, message: 'Leaving bootloader...' });
  await programmer.leaveProgrammingMode();
}

async function verifySignatureIfAvailable(
  programmer: { readSignature: () => Promise<[number, number, number]> },
  profile: HardwareProfile,
  log: LogSink,
  onProgress: (progress: FlashProgress) => void,
): Promise<void> {
  onProgress({ stage: 'checking', percent: 12, message: 'Checking device signature...' });
  try {
    const signature = await programmer.readSignature();
    if (profile.expectedSignature && !signaturesMatch(signature, profile.expectedSignature)) {
      throw new Error(
        `Wrong device signature. Expected ${signatureText(profile.expectedSignature)} for ${profile.mcu}, got ${signatureText(signature)}.`,
      );
    }
    if (profile.expectedSignature) log('success', `Signature matches ${profile.mcu}.`);
  } catch (error) {
    if (profile.expectedSignature && profile.signatureRequired !== false) throw error;
    log('warn', `Could not read signature: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeStk500v2(
  programmer: Stk500v2Programmer,
  pages: ReturnType<typeof makeFirmwarePages>,
  usedBytes: number,
  largeFlash: boolean,
  log: LogSink,
  onProgress: (progress: FlashProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  log('info', `Writing ${pages.length} flash page(s), ${formatBytes(usedBytes)} used data...`);
  for (let index = 0; index < pages.length; index += 1) {
    assertNotAborted(signal);
    const page = pages[index];
    onProgress({
      stage: 'writing',
      percent: 15 + percent(index, pages.length) * 0.55,
      message: `Writing page ${index + 1} of ${pages.length} at ${formatHexAddress(page.address)}...`,
    });
    await programmer.programFlashPage(page.address, page.data, largeFlash);
    onProgress({
      stage: 'writing',
      percent: 15 + percent(index + 1, pages.length) * 0.55,
      message: `Wrote page ${index + 1} of ${pages.length}.`,
    });
    await yieldForProgress(index, pages.length);
  }
  log('success', `Wrote ${pages.length} page(s).`);
}

async function verifyStk500v2(
  programmer: Stk500v2Programmer,
  pages: ReturnType<typeof makeFirmwarePages>,
  largeFlash: boolean,
  log: LogSink,
  onProgress: (progress: FlashProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  log('info', 'Verifying flash by reading back each written page...');
  for (let index = 0; index < pages.length; index += 1) {
    assertNotAborted(signal);
    const page = pages[index];
    onProgress({
      stage: 'verifying',
      percent: 70 + percent(index, pages.length) * 0.27,
      message: `Verifying page ${index + 1} of ${pages.length} at ${formatHexAddress(page.address)}...`,
    });
    const actual = await programmer.readFlash(page.address, page.data.length, largeFlash);
    const mismatch = firstMismatch(page.data, actual);
    if (mismatch !== undefined) {
      throw new Error(
        `Verify failed at ${formatHexAddress(page.address + mismatch)}: expected ${byteHex(page.data[mismatch])}, got ${byteHex(actual[mismatch])}.`,
      );
    }
    onProgress({
      stage: 'verifying',
      percent: 70 + percent(index + 1, pages.length) * 0.27,
      message: `Verified page ${index + 1} of ${pages.length}.`,
    });
    await yieldForProgress(index, pages.length);
  }
  log('success', 'Verification passed.');
}

async function writeStk500v1(
  programmer: Stk500v1Programmer,
  pages: ReturnType<typeof makeFirmwarePages>,
  usedBytes: number,
  log: LogSink,
  onProgress: (progress: FlashProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  log('info', `Writing ${pages.length} flash page(s), ${formatBytes(usedBytes)} used data...`);
  for (let index = 0; index < pages.length; index += 1) {
    assertNotAborted(signal);
    const page = pages[index];
    onProgress({
      stage: 'writing',
      percent: 15 + percent(index, pages.length) * 0.55,
      message: `Writing page ${index + 1} of ${pages.length} at ${formatHexAddress(page.address)}...`,
    });
    await programmer.programFlashPage(page.address, page.data);
    onProgress({
      stage: 'writing',
      percent: 15 + percent(index + 1, pages.length) * 0.55,
      message: `Wrote page ${index + 1} of ${pages.length}.`,
    });
    await yieldForProgress(index, pages.length);
  }
  log('success', `Wrote ${pages.length} page(s).`);
}

async function verifyStk500v1(
  programmer: Stk500v1Programmer,
  pages: ReturnType<typeof makeFirmwarePages>,
  log: LogSink,
  onProgress: (progress: FlashProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  log('info', 'Verifying flash by reading back each written page...');
  for (let index = 0; index < pages.length; index += 1) {
    assertNotAborted(signal);
    const page = pages[index];
    onProgress({
      stage: 'verifying',
      percent: 70 + percent(index, pages.length) * 0.27,
      message: `Verifying page ${index + 1} of ${pages.length} at ${formatHexAddress(page.address)}...`,
    });
    const actual = await programmer.readFlash(page.address, page.data.length);
    const mismatch = firstMismatch(page.data, actual);
    if (mismatch !== undefined) {
      throw new Error(
        `Verify failed at ${formatHexAddress(page.address + mismatch)}: expected ${byteHex(page.data[mismatch])}, got ${byteHex(actual[mismatch])}.`,
      );
    }
    onProgress({
      stage: 'verifying',
      percent: 70 + percent(index + 1, pages.length) * 0.27,
      message: `Verified page ${index + 1} of ${pages.length}.`,
    });
    await yieldForProgress(index, pages.length);
  }
  log('success', 'Verification passed.');
}
