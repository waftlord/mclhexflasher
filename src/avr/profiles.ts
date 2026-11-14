export type BootloaderProtocol = 'stk500v2' | 'stk500v1';

export interface HardwareProfile {
  id: string;
  label: string;
  shortLabel: string;
  description: string;
  mcu: string;
  protocol: BootloaderProtocol;
  baudRate: number;
  pageSize: number;
  flashSize: number;
  expectedSignature?: [number, number, number];
  signatureRequired?: boolean;
  resetStrategy: 'dtr-toggle' | 'wiring-dtr-toggle';
  help: string[];
}

export const DEFAULT_PROFILE_ID = 'mcl-megacmd-arduino-stk500v1';

const BOOT_MENU_OS_UPGRADE_HELP =
  'Power off by unplugging USB. Hold Page while plugging USB back in, choose OS UPGRADE, then select the USB serial device, load the HEX file, and flash.';

export const HARDWARE_PROFILES: HardwareProfile[] = [
  {
    id: 'mcl-megacmd-arduino-stk500v1',
    label: 'MegaCMD',
    shortLabel: 'MegaCMD',
    description: 'MegaCMD',
    mcu: 'ATmega2560',
    protocol: 'stk500v1',
    baudRate: 115200,
    pageSize: 256,
    flashSize: 262144,
    expectedSignature: [0x1e, 0x98, 0x01],
    signatureRequired: false,
    resetStrategy: 'dtr-toggle',
    help: [
      BOOT_MENU_OS_UPGRADE_HELP,
    ],
  },
  {
    id: 'mcl-megacommand-stk500v2',
    label: 'MegaCommand DIY',
    shortLabel: 'MegaCommand DIY',
    description: 'MegaCommand DIY',
    mcu: 'ATmega2560',
    protocol: 'stk500v2',
    baudRate: 115200,
    pageSize: 256,
    flashSize: 262144,
    expectedSignature: [0x1e, 0x98, 0x01],
    signatureRequired: true,
    resetStrategy: 'wiring-dtr-toggle',
    help: [
      BOOT_MENU_OS_UPGRADE_HELP,
    ],
  },
];

export function getProfile(id: string): HardwareProfile {
  const profile = HARDWARE_PROFILES.find((candidate) => candidate.id === id);
  if (!profile && id === 'mcl-megacommand-stk500v2-wiring-reset') {
    return getProfile('mcl-megacommand-stk500v2');
  }
  if (!profile) throw new Error(`Unknown hardware profile: ${id}`);
  return profile;
}
