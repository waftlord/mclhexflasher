export interface FirmwarePage {
  address: number;
  data: Uint8Array;
  usedBytes: number;
}

export interface FirmwareImage {
  bytes: Map<number, number>;
  minAddress: number;
  maxAddressExclusive: number;
  usedBytes: number;
  lineCount: number;
  eofSeen: boolean;
}

export interface HexSummary {
  usedBytes: number;
  minAddress: number;
  maxAddressExclusive: number;
  pageCount: number;
}

const UINT32_MAX = 0xffffffff;

function parseHexByte(text: string, offset: number): number {
  const chunk = text.slice(offset, offset + 2);
  if (!/^[0-9a-fA-F]{2}$/.test(chunk)) {
    throw new Error(`Invalid hex byte "${chunk}" at character ${offset + 1}.`);
  }
  return Number.parseInt(chunk, 16);
}

function assertByte(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new Error(`${label} is not a byte: ${value}`);
  }
}

export function parseIntelHex(text: string): FirmwareImage {
  const bytes = new Map<number, number>();
  let baseAddress = 0;
  let minAddress = Number.POSITIVE_INFINITY;
  let maxAddressExclusive = 0;
  let eofSeen = false;

  const normalized = text.replace(/^\uFEFF/, '').replace(/\r/g, '');
  const lines = normalized.split('\n');

  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = rawLine.trim();
    if (line.length === 0) return;
    if (!line.startsWith(':')) {
      throw new Error(`Line ${lineNumber}: Intel HEX records must start with ':'.`);
    }
    if ((line.length - 1) % 2 !== 0) {
      throw new Error(`Line ${lineNumber}: record has an odd number of hex characters.`);
    }

    const byteCount = parseHexByte(line, 1);
    const addressHigh = parseHexByte(line, 3);
    const addressLow = parseHexByte(line, 5);
    const recordType = parseHexByte(line, 7);
    const expectedLength = 11 + byteCount * 2;
    if (line.length !== expectedLength) {
      throw new Error(`Line ${lineNumber}: byte count says ${byteCount}, but record length is ${line.length}.`);
    }

    const data: number[] = [];
    let checksumSum = byteCount + addressHigh + addressLow + recordType;
    for (let i = 0; i < byteCount; i += 1) {
      const value = parseHexByte(line, 9 + i * 2);
      data.push(value);
      checksumSum += value;
    }
    const checksum = parseHexByte(line, 9 + byteCount * 2);
    checksumSum += checksum;
    if ((checksumSum & 0xff) !== 0) {
      throw new Error(`Line ${lineNumber}: checksum mismatch.`);
    }

    const address = (addressHigh << 8) | addressLow;
    if (eofSeen) {
      throw new Error(`Line ${lineNumber}: record found after EOF.`);
    }

    switch (recordType) {
      case 0x00: {
        const absoluteAddress = baseAddress + address;
        const lastAddress = absoluteAddress + byteCount - 1;
        if (byteCount > 0 && lastAddress > UINT32_MAX) {
          throw new Error(`Line ${lineNumber}: data record exceeds 32-bit address space.`);
        }
        data.forEach((value, offset) => {
          assertByte(value, `Line ${lineNumber} data byte`);
          const location = absoluteAddress + offset;
          const existing = bytes.get(location);
          if (existing !== undefined && existing !== value) {
            throw new Error(`Line ${lineNumber}: overlapping data at 0x${location.toString(16)}.`);
          }
          bytes.set(location, value);
          minAddress = Math.min(minAddress, location);
          maxAddressExclusive = Math.max(maxAddressExclusive, location + 1);
        });
        break;
      }
      case 0x01:
        if (byteCount !== 0) throw new Error(`Line ${lineNumber}: EOF record must have byte count 0.`);
        eofSeen = true;
        break;
      case 0x02: {
        if (byteCount !== 2) throw new Error(`Line ${lineNumber}: extended segment address must contain 2 bytes.`);
        baseAddress = (((data[0] << 8) | data[1]) << 4) >>> 0;
        break;
      }
      case 0x04: {
        if (byteCount !== 2) throw new Error(`Line ${lineNumber}: extended linear address must contain 2 bytes.`);
        baseAddress = (((data[0] << 8) | data[1]) << 16) >>> 0;
        break;
      }
      case 0x03:
        if (byteCount !== 4) throw new Error(`Line ${lineNumber}: start segment address must contain 4 bytes.`);
        // Start address records are allowed but not needed for bootloader flashing.
        break;
      case 0x05:
        if (byteCount !== 4) throw new Error(`Line ${lineNumber}: start linear address must contain 4 bytes.`);
        // Start address records are allowed but not needed for bootloader flashing.
        break;
      default:
        throw new Error(`Line ${lineNumber}: unsupported Intel HEX record type 0x${recordType.toString(16)}.`);
    }
  });

  if (bytes.size === 0) throw new Error('HEX file contains no data records.');
  if (!eofSeen) throw new Error('HEX file is missing an EOF record.');

  return {
    bytes,
    minAddress,
    maxAddressExclusive,
    usedBytes: bytes.size,
    lineCount: lines.length,
    eofSeen,
  };
}

export function makeFirmwarePages(image: FirmwareImage, pageSize: number): FirmwarePage[] {
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error(`Invalid page size: ${pageSize}`);
  }

  const byPage = new Map<number, FirmwarePage>();

  for (const [address, value] of image.bytes.entries()) {
    const pageAddress = Math.floor(address / pageSize) * pageSize;
    let page = byPage.get(pageAddress);
    if (!page) {
      page = {
        address: pageAddress,
        data: new Uint8Array(pageSize).fill(0xff),
        usedBytes: 0,
      };
      byPage.set(pageAddress, page);
    }
    page.data[address - pageAddress] = value;
    page.usedBytes += 1;
  }

  return [...byPage.values()].sort((a, b) => a.address - b.address);
}

export function summarizeHex(image: FirmwareImage, pageSize: number): HexSummary {
  return {
    usedBytes: image.usedBytes,
    minAddress: image.minAddress,
    maxAddressExclusive: image.maxAddressExclusive,
    pageCount: makeFirmwarePages(image, pageSize).length,
  };
}

export async function readHexFile(file: File): Promise<FirmwareImage> {
  const text = await file.text();
  return parseIntelHex(text);
}
