import { MCL_REMOTE_HEX_FIRMWARE, RemoteHexFirmware } from './catalog';

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
const STABLE_MANIFEST_SECTIONS = ['megacmd', 'megacommand'];
let firmwareOptionsPromise: Promise<RemoteHexFirmware[]> | null = null;

function findHexAsset(release: GitHubRelease): GitHubAsset | null {
  const assets = release.assets.filter((asset) => asset.name.toLowerCase().endsWith('.hex'));
  return assets.find((asset) => asset.name.toLowerCase().includes('mcl')) ?? assets[0] ?? null;
}

function releaseDescription(release: GitHubRelease, label: 'beta'): string {
  const version = release.tag_name || release.name || 'Latest';
  return `MCL ${version} ${label} release.`;
}

function firmwareFromRelease(
  id: string,
  label: string,
  channelLabel: string,
  release: GitHubRelease,
  channel: 'beta',
): RemoteHexFirmware | null {
  const asset = findHexAsset(release);
  if (!asset) return null;

  return {
    id,
    label,
    channelLabel,
    description: releaseDescription(release, channel),
    filename: asset.name,
    downloadUrl: asset.browser_download_url,
    releaseUrl: release.html_url,
    sha256: null,
    enabled: true,
  };
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

function stableFirmwareFromManifest(manifest: Manifest): RemoteHexFirmware | null {
  const section = STABLE_MANIFEST_SECTIONS
    .map((sectionName) => manifest[sectionName])
    .find((entry) => entry?.version_string && entry.filename);

  if (!section) return null;

  const filename = section.filename;
  const versionTag = section.version_string;
  if (!filename.toLowerCase().endsWith('.hex')) return null;

  return {
    id: 'mcl-stable',
    label: 'Latest stable',
    channelLabel: 'Stable',
    description: `MCL ${versionTag} stable release.`,
    filename,
    downloadUrl: `https://github.com/${GITHUB_REPO}/releases/download/${versionTag}/${filename}`,
    releaseUrl: `https://github.com/${GITHUB_REPO}/releases/tag/${versionTag}`,
    sha256: null,
    enabled: true,
  };
}

async function getText(url: string): Promise<string | null> {
  const response = await fetch(url, {
    cache: 'no-store',
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
    headers: {
      Accept: 'application/vnd.github+json',
    },
  });

  if (!response.ok) return null;
  return response.json() as Promise<T>;
}

async function fetchFirmwareDownloadOptions(): Promise<RemoteHexFirmware[]> {
  const [fallbackStable, fallbackBeta] = MCL_REMOTE_HEX_FIRMWARE;
  const [manifestText, releases] = await Promise.all([
    getText(MANIFEST_URL),
    getJson<GitHubRelease[]>(`${API_BASE}/releases?per_page=20`),
  ]);

  const stable = manifestText ? stableFirmwareFromManifest(parseManifest(manifestText)) : null;

  const betaRelease = releases?.find((release) => (
    !release.draft
    && release.prerelease
    && Boolean(findHexAsset(release))
  ));
  const beta = betaRelease
    ? firmwareFromRelease('mcl-beta', 'Beta', 'Beta', betaRelease, 'beta')
    : null;

  return [stable ?? fallbackStable, beta ?? fallbackBeta];
}

export function getMclFirmwareDownloadOptions(): Promise<RemoteHexFirmware[]> {
  firmwareOptionsPromise ??= fetchFirmwareDownloadOptions();
  return firmwareOptionsPromise;
}
