export interface RemoteHexFirmware {
  id: string;
  label: string;
  channelLabel: string;
  description: string;
  filename: string;
  downloadUrl: string | null;
  releaseUrl: string | null;
  sha256: string | null;
  enabled: boolean;
  unavailableReason?: string;
}

export interface FirmwareDownloads {
  stable: RemoteHexFirmware;
  beta: RemoteHexFirmware;
  upgrader: RemoteHexFirmware | null;
}

export const MCL_REMOTE_HEX_FIRMWARE: FirmwareDownloads = {
  stable: {
    id: 'mcl-stable',
    label: 'Latest stable',
    channelLabel: 'Stable',
    description: 'MCL 5.10 stable release.',
    filename: 'mcl_5_1_0.hex',
    downloadUrl: 'https://github.com/jmamma/MCL/releases/download/5.10/mcl_5_1_0.hex',
    releaseUrl: 'https://github.com/jmamma/MCL/releases/tag/5.10',
    sha256: '1a0fb22196a439403f024422223075f83de12469346e3c165c712487f99a447f',
    enabled: true,
  },
  beta: {
    id: 'mcl-beta',
    label: 'Beta',
    channelLabel: 'Beta',
    description: 'No beta HEX available',
    filename: 'mcl-beta.hex',
    downloadUrl: null,
    releaseUrl: null,
    sha256: null,
    enabled: false,
    unavailableReason: 'No beta HEX available',
  },
  upgrader: null,
};

// Browsers may append a copy number when the same download already exists.
export function isProjectUpgraderFile(filename: string, upgrader: RemoteHexFirmware | null): boolean {
  const name = filename.toLowerCase();
  const publishedName = upgrader?.filename.toLowerCase();
  const originalName = name.replace(/(?: \(\d+\)|-\d+)(?=\.hex$)/, '');
  return name === publishedName || originalName === publishedName || /^mcl_project_upgrade_\d+(?:_\d+)+\.hex$/.test(originalName);
}
