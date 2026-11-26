import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';

const vite = await createServer({
  configFile: false,
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, hmr: false, watch: null, ws: false },
});
after(() => vite.close());
const { resolveFirmwareDownloads } = await vite.ssrLoadModule('/src/firmware/githubReleases.ts');
const { isProjectUpgraderFile } = await vite.ssrLoadModule('/src/firmware/catalog.ts');

const stableName = 'mcl_5_1_0.hex';
const upgradeName = 'mcl_project_upgrade_1_0.hex';
const section = (key, filename, tag = '5.10') => `[${key}]\nversion_string = ${tag}\nfilename = ${filename}\n`;
const stable = section('megacmd', stableName);
const upgrade = section('megacmd_upgrader', upgradeName);
const prerelease = (...names) => ({
  prerelease: true, draft: false, tag_name: '5.11-beta', html_url: 'https://github.com/jmamma/MCL/releases',
  assets: names.map(name => ({ name, browser_download_url: `https://example.org/${name}` })),
});

test('stable and upgrader resolve to separate official assets from the same manifest', () => {
  const { stable: firmware, upgrader } = resolveFirmwareDownloads(upgrade + stable, null);
  assert.equal(firmware.downloadUrl, 'https://github.com/jmamma/MCL/releases/download/5.10/mcl_5_1_0.hex');
  assert.equal(upgrader.downloadUrl, 'https://github.com/jmamma/MCL/releases/download/5.10/mcl_project_upgrade_1_0.hex');
  assert.equal(upgrader.releaseUrl, 'https://github.com/jmamma/MCL/releases/tag/5.10');
});

test('an older manifest retains its stable release and hides the upgrader', () => {
  const options = resolveFirmwareDownloads(section('megacommand', 'mcl_5_0_2.hex', '5.02'), []);
  assert.equal(options.stable.filename, 'mcl_5_0_2.hex');
  assert.equal(options.upgrader, null);
});

test('incomplete first section falls back to the other valid hardware section', () => {
  const alternate = section('megacommand_upgrader', upgradeName);
  for (const first of ['', section('megacmd_upgrader', upgradeName, ''), section('megacmd_upgrader', 'image.uf2')]) {
    assert.equal(resolveFirmwareDownloads(first + alternate, []).upgrader.filename, upgradeName);
    assert.equal(resolveFirmwareDownloads(first, []).upgrader, null);
  }
  assert.equal(resolveFirmwareDownloads(upgrade + section('megacommand_upgrader', 'alternate.hex'), []).upgrader.filename, upgradeName);
});

test('misplaced assets never swap the stable firmware and conversion tool', () => {
  const result = resolveFirmwareDownloads(section('megacmd', upgradeName) + section('megacmd_upgrader', stableName), []);
  assert.equal(result.stable.filename, stableName);
  assert.equal(result.upgrader, null);
});

test('beta skips drafts, upgrader-only releases and unrelated files, regardless of asset order', () => {
  for (const name of ['mcl_a_5_0_1.hex', 'MCL_5_1_1.HEX']) {
    const releases = [
      { ...prerelease('mcl_9_9_9.hex'), draft: true },
      { ...prerelease(stableName), prerelease: false },
      prerelease(upgradeName, 'usb.hex'),
      prerelease('usb.hex', upgradeName, name),
    ];
    assert.equal(resolveFirmwareDownloads(null, releases).beta.filename, name);
  }
  assert.equal(resolveFirmwareDownloads(null, [prerelease(upgradeName)]).beta.enabled, false);
});

test('metadata outages preserve independent downloads and a known stable fallback', () => {
  assert.equal(resolveFirmwareDownloads(null, null).stable.filename, stableName);
  assert.equal(resolveFirmwareDownloads(null, [prerelease(stableName)]).beta.enabled, true);
  assert.equal(resolveFirmwareDownloads(stable + upgrade, null).upgrader.filename, upgradeName);
});

test('local files, including repeat downloads, get the correct flash action', () => {
  const { upgrader } = resolveFirmwareDownloads(section('megacmd_upgrader', 'legacy_tool.hex'), []);
  for (const name of [upgradeName, 'MCL_PROJECT_UPGRADE_1_0 (2).HEX', 'mcl_project_upgrade_1_0-1.hex']) {
    assert.equal(isProjectUpgraderFile(name, null), true);
  }
  assert.equal(isProjectUpgraderFile('legacy_tool (1).hex', upgrader), true);
  assert.equal(isProjectUpgraderFile('legacy-2.hex', { ...upgrader, filename: 'legacy-2.hex' }), true);
  assert.equal(isProjectUpgraderFile(stableName, upgrader), false);
  assert.equal(isProjectUpgraderFile('my_upgrade.hex', null), false);
});

test('DIY bootloader version queries use consecutive command sequences', async () => {
  const { Stk500v2Programmer } = await vite.ssrLoadModule('/src/avr/stk500v2.ts');
  const sequences = [];
  const pending = [];
  const transport = {
    async write(request) {
      const sequence = request[1];
      sequences.push(sequence);
      const response = [0x1b, sequence, 0, 3, 0x0e, 0x03, 0, sequence];
      pending.push(...response, response.reduce((sum, byte) => sum ^ byte, 0));
    },
    async readByte() {
      assert.ok(pending.length);
      return pending.shift();
    },
  };
  const programmer = new Stk500v2Programmer(transport, () => {});
  assert.equal(await programmer.readVersion(), 'HW 1, SW 2.3, build 1029');
  assert.deepEqual(sequences, [1, 2, 3, 4, 5]);
});
