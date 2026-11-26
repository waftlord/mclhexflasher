import { FirmwareDownloads, MCL_REMOTE_HEX_FIRMWARE, RemoteHexFirmware } from './catalog';

interface GitHubAsset {
  name: string;
  browser_download_url: string;
}

interface GitHubRelease {
  tag_name: string;
  name: string | null;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  assets: GitHubAsset[];
}

const API_BASE = 'https://api.github.com/repos/jmamma/MCL';
const GITHUB_REPO = 'jmamma/MCL';
const MANIFEST_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/master/build/manifest.ini`;
const MAIN_MCL_HEX = /^mcl_(?:[a-z]_)?\d+_\d+_\d+\.hex$/i;
let firmwareOptionsPromise: Promise<FirmwareDownloads> | null = null;

function betaFirmware(releases: GitHubRelease[]): RemoteHexFirmware {
  for (const release of releases) {
    if (!release?.prerelease || release.draft || !Array.isArray(release.assets)) continue;
    const asset = release.assets.find((item) => item?.browser_download_url && MAIN_MCL_HEX.test(item.name));
    if (asset) {
      return {
        ...MCL_REMOTE_HEX_FIRMWARE.beta,
        enabled: true,
        unavailableReason: undefined,
        description: `MCL ${release.tag_name} beta release.`,
        filename: asset.name,
        downloadUrl: asset.browser_download_url,
        releaseUrl: release.html_url,
      };
    }
  }
  return MCL_REMOTE_HEX_FIRMWARE.beta;
}

type Manifest = Record<string, Record<string, string>>;

function parseManifest(manifestText: string): Manifest {
  const manifest: Manifest = {};
  let currentSection: Record<string, string> | null = null;

  for (const rawLine of manifestText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;

    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      currentSection = {};
      manifest[sectionMatch[1].trim()] = currentSection;
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1 || !currentSection) continue;

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (key) currentSection[key] = value;
  }

  return manifest;
}

function firmwareFromManifest(manifest: Manifest, kind: 'stable' | 'upgrader'): RemoteHexFirmware | null {
  const isUpgrader = kind === 'upgrader';
  const sections = isUpgrader ? ['megacmd_upgrader', 'megacommand_upgrader'] : ['megacmd', 'megacommand'];
  for (const key of sections) {
    const section = manifest[key];
    if (!section?.version_string || !/^[a-z0-9][a-z0-9._-]*\.hex$/i.test(section.filename)) continue;
    if (!isUpgrader && /upgrad/i.test(section.filename)) continue;
    if (isUpgrader && MAIN_MCL_HEX.test(section.filename)) continue;
    const tag = encodeURIComponent(section.version_string);
    return {
      id: `mcl-${kind}`,
      label: isUpgrader ? 'Project upgrader' : 'Latest stable',
      channelLabel: isUpgrader ? 'Project upgrader' : 'Stable',
      description: isUpgrader ? 'For projects created before MCL 5.00.' : `MCL ${section.version_string} stable release.`,
      filename: section.filename,
      downloadUrl: `https://github.com/${GITHUB_REPO}/releases/download/${tag}/${section.filename}`,
      releaseUrl: `https://github.com/${GITHUB_REPO}/releases/tag/${tag}`,
      sha256: null,
      enabled: true,
    };
  }
  return null;
}

async function getText(url: string): Promise<string | null> {
  const response = await fetch(url, {
    cache: 'no-store',
    signal: AbortSignal.timeout(8000),
    headers: {
      Accept: 'text/plain',
    },
  });

  if (!response.ok) return null;
  return response.text();
}

async function getJson<T>(url: string): Promise<T | null> {
  const response = await fetch(url, {
    cache: 'no-store',
    signal: AbortSignal.timeout(8000),
    headers: {
      Accept: 'application/vnd.github+json',
    },
  });

  if (!response.ok) return null;
  return response.json() as Promise<T>;
}

async function fetchFirmwareDownloadOptions(): Promise<FirmwareDownloads> {
  const [manifestText, releases] = await Promise.all([
    getText(MANIFEST_URL).catch(() => null),
    getJson<GitHubRelease[]>(`${API_BASE}/releases?per_page=20`).catch(() => null),
  ]);
  return resolveFirmwareDownloads(manifestText, releases);
}

export function resolveFirmwareDownloads(manifestText: string | null, releases: GitHubRelease[] | null): FirmwareDownloads {
  const manifest = parseManifest(manifestText ?? '');
  return {
    stable: firmwareFromManifest(manifest, 'stable') ?? MCL_REMOTE_HEX_FIRMWARE.stable,
    upgrader: firmwareFromManifest(manifest, 'upgrader'),
    beta: betaFirmware(Array.isArray(releases) ? releases : []),
  };
}

export function getMclFirmwareDownloadOptions(): Promise<FirmwareDownloads> {
  firmwareOptionsPromise ??= fetchFirmwareDownloadOptions();
  return firmwareOptionsPromise;
}
