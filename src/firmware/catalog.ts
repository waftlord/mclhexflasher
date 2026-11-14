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

export const MCL_REMOTE_HEX_FIRMWARE: RemoteHexFirmware[] = [
  {
    id: 'mcl-stable',
    label: 'Latest stable',
    channelLabel: 'Stable',
    description: 'MCL 4.70 stable release.',
    filename: 'mcl_4_7_0.hex',
    downloadUrl: 'https://github.com/jmamma/MCL/releases/download/4.70/mcl_4_7_0.hex',
    releaseUrl: 'https://github.com/jmamma/MCL/releases/tag/4.70',
    sha256: '9790f3d7b29ef4019b0cb08a1456733ccd76802e7dc845f036daab387e2d7cec',
    enabled: true,
  },
  {
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
];
