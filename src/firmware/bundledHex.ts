import type { RemoteHexFirmware } from './catalog';
import stableUrl from './images/mcl_5_1_0.hex?url';
import upgraderUrl from './images/mcl_project_upgrade_1_0.hex?url';

const release = 'https://github.com/jmamma/MCL/releases/download/5.10/';
const images = new Map([
  [release + 'mcl_5_1_0.hex', {
    url: stableUrl,
    sha256: '1a0fb22196a439403f024422223075f83de12469346e3c165c712487f99a447f',
  }],
  [release + 'mcl_project_upgrade_1_0.hex', {
    url: upgraderUrl,
    sha256: 'd6bddfe69263acf5a9e65d38f245d47f72b384d781039d628c9c17fc09f13ad6',
  }],
]);

export function hasBundledHex(firmware: RemoteHexFirmware): boolean {
  return images.has(firmware.downloadUrl ?? '');
}

export async function loadBundledHex(firmware: RemoteHexFirmware): Promise<File> {
  const image = images.get(firmware.downloadUrl ?? '');
  if (!image) throw new Error('This release is available from the MCL release page.');
  const response = await fetch(image.url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Could not load ${firmware.filename}. Please retry.`);
  const bytes = await response.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const digest = Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
  if (digest !== image.sha256) throw new Error(`${firmware.filename} did not match the official release checksum.`);
  return new File([bytes], firmware.filename, { type: 'text/plain' });
}
