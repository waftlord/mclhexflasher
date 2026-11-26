import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Cpu, Download, FileCode2, PlugZap, RotateCcw, TerminalSquare, Usb } from 'lucide-react';
import { flashFirmware, FlashProgress } from './avr/flasher';
import { FirmwareImage, readHexFile, summarizeHex } from './avr/intelHex';
import { DEFAULT_PROFILE_ID, getProfile, HARDWARE_PROFILES, HardwareProfile } from './avr/profiles';
import { isProjectUpgraderFile, MCL_REMOTE_HEX_FIRMWARE } from './firmware/catalog';
import { getMclFirmwareDownloadOptions } from './firmware/githubReleases';
import { createLogEntry, downloadTextFile, LogEntry, LogLevel, logEntriesToText } from './lib/logger';
import { formatBytes, formatHexAddress, formatUsbId } from './lib/format';

function browserSupportsSerial(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator && !!navigator.serial;
}

function browserSupportsMidi(): boolean {
  return typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator && !!navigator.requestMIDIAccess;
}

const MAX_LOG_ENTRIES = 180;
const MAX_HEX_FILE_BYTES = 8 * 1024 * 1024;
const HEX_FILE_EXTENSION = /\.hex$/i;
// MCL's AVR USB serial-mode command. See THIRD_PARTY_NOTICES.md.
const MIDI_SERIAL_MODE_SYSEX = [0xf0, 0x7d, 0x4d, 0x43, 0x4c, 0x01, 0x03, 0xf7];

function recoveryHint(error: string): string {
  const lower = error.toLowerCase();
  if (lower.includes('sync')) return 'Re-enter bootloader mode, close serial tools, retry.';
  if (lower.includes('signature')) return 'Wrong profile or wrong device.';
  if (lower.includes('verify failed')) return 'Retry the flash with the same HEX.';
  if (lower.includes('disconnected') || lower.includes('closed')) return 'Reconnect USB and retry.';
  if (lower.includes('not supported')) return 'Use Chrome/Edge on desktop via localhost or HTTPS.';
  return 'Check the log, reconnect, and retry.';
}

function stepClass(done: boolean, active: boolean): string {
  if (done) return 'step step-done';
  if (active) return 'step step-active';
  return 'step';
}

function resetStrategyLabel(profile: HardwareProfile): string {
  if (profile.resetStrategy === 'wiring-dtr-toggle') return 'Wiring reset';
  return 'Arduino reset';
}

function DeviceUpgradeSteps() {
  return (
    <ol className="upgrade-steps">
      <li>At <strong>SCAN FOR PROJECTS?</strong>, press <strong>Load / Yes</strong> to scan the SD card, or <strong>Save / No</strong> to stop. Scanning only reads the card.</li>
      <li>Review the results (UPGRADE, UP TO DATE or CAN’T READ). At <strong>UPGRADE n PROJECTS?</strong>, press <strong>Load / Yes</strong> to convert them. Keep the device powered throughout conversion.</li>
      <li>When the display says <strong>NOW UPGRADE TO MCL 5.10</strong>, return to OS UPGRADE or serial mode and flash the MCL firmware from <strong>Latest stable</strong>.</li>
    </ol>
  );
}

export function App() {
  const [profileId, setProfileId] = useState(DEFAULT_PROFILE_ID);
  const profile = useMemo(() => getProfile(profileId), [profileId]);
  const [selectedPort, setSelectedPort] = useState<SerialPort | null>(null);
  const [portInfo, setPortInfo] = useState<SerialPortInfo | null>(null);
  const [firmwareFile, setFirmwareFile] = useState<File | null>(null);
  const [firmwareImage, setFirmwareImage] = useState<FirmwareImage | null>(null);
  const [hexError, setHexError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [progress, setProgress] = useState<FlashProgress>({ stage: 'idle', percent: 0, message: 'Select a device and firmware file to begin.' });
  const [busy, setBusy] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [midiOutputs, setMidiOutputs] = useState<MIDIOutput[]>([]);
  const [selectedMidiOutputId, setSelectedMidiOutputId] = useState('');
  const [midiBusy, setMidiBusy] = useState(false);
  const [midiMessage, setMidiMessage] = useState<string | null>(null);
  const [midiError, setMidiError] = useState<string | null>(null);
  const [downloads, setDownloads] = useState(MCL_REMOTE_HEX_FIRMWARE);
  const [awaitingDevice, setAwaitingDevice] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const fileReadIdRef = useRef(0);
  const logIdRef = useRef(1);

  const serialSupported = browserSupportsSerial();
  const midiSupported = browserSupportsMidi();
  const upgraderLoaded = !!firmwareFile && isProjectUpgraderFile(firmwareFile.name, downloads.upgrader);
  const controlsLocked = busy || awaitingDevice;
  const canFlash = Boolean(serialSupported && selectedPort && firmwareImage && !hexError && !controlsLocked);
  const summary = useMemo(() => (firmwareImage ? summarizeHex(firmwareImage, profile.pageSize) : null), [firmwareImage, profile.pageSize]);
  const diyProfile = profile.protocol === 'stk500v2';

  const log = useCallback((level: LogLevel, message: string): void => {
    const entry = createLogEntry(logIdRef.current, level, message);
    logIdRef.current += 1;
    setLogs((existing) => {
      const next = [...existing, entry];
      if (next.length <= MAX_LOG_ENTRIES) return next;
      return next.slice(next.length - MAX_LOG_ENTRIES);
    });
  }, []);

  useEffect(() => {
    if (!navigator.serial || !selectedPort) return undefined;

    const onDisconnect = (event: Event) => {
      const eventPort = event.target as SerialPort | null;
      if (eventPort && eventPort !== selectedPort) return;

      const message = busy
        ? 'Selected serial device disconnected during flashing.'
        : 'Selected serial device disconnected.';

      setSelectedPort(null);
      setPortInfo(null);
      setLastError(message);
      setProgress((current) => ({
        stage: busy ? 'error' : current.stage,
        percent: current.percent,
        message,
      }));
      log('warn', message);
    };

    navigator.serial.addEventListener('disconnect', onDisconnect);
    return () => navigator.serial?.removeEventListener('disconnect', onDisconnect);
  }, [busy, log, selectedPort]);

  useEffect(() => {
    let cancelled = false;

    getMclFirmwareDownloadOptions()
      .then((options) => {
        if (!cancelled) setDownloads(options);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        log('warn', `Using fallback firmware download links: ${message}`);
      });

    return () => {
      cancelled = true;
    };
  }, [log]);

  function applyProfile(nextProfile: HardwareProfile, reason?: string): void {
    setProfileId(nextProfile.id);
    if (reason) log('info', reason);
    if (firmwareFile) void handleFile(firmwareFile, nextProfile);
  }

  async function selectDevice(): Promise<void> {
    setLastError(null);
    if (!navigator.serial) {
      setLastError('Web Serial is not supported in this browser.');
      return;
    }

    try {
      const port = await navigator.serial.requestPort();
      const info = port.getInfo();
      setSelectedPort(port);
      setPortInfo(info);
      log('success', 'USB/serial device selected.');
      setProgress({ stage: 'idle', percent: firmwareImage ? 20 : 10, message: 'Device selected.' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const name = error instanceof DOMException ? error.name : '';
      if (name === 'NotFoundError' || message.toLowerCase().includes('user cancelled') || message.toLowerCase().includes('no port selected')) {
        log('warn', 'Device picker was cancelled.');
      } else {
        setLastError(message);
        log('error', message);
      }
    }
  }

  async function usePreviouslyAuthorisedDevice(): Promise<void> {
    setLastError(null);
    if (!navigator.serial) {
      setLastError('Web Serial is not supported in this browser.');
      return;
    }

    try {
      const ports = await navigator.serial.getPorts();
      if (ports.length === 0) {
        log('warn', 'No authorised serial devices.');
        return;
      }

      const port = ports[0];
      const info = port.getInfo();
      setSelectedPort(port);
      setPortInfo(info);
      log('success', `Using authorised serial device${ports.length > 1 ? ' (first available).' : '.'}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLastError(message);
      log('error', message);
    }
  }

  async function loadMidiOutputs(): Promise<void> {
    setMidiBusy(true);
    setMidiError(null);
    setMidiMessage(null);

    if (!navigator.requestMIDIAccess) {
      setMidiError('Web MIDI is not supported in this browser.');
      setMidiBusy(false);
      return;
    }

    try {
      const access = await navigator.requestMIDIAccess({ sysex: true });
      const outputs = [...access.outputs.values()].filter((output) => output.state !== 'disconnected');
      setMidiOutputs(outputs);
      setSelectedMidiOutputId((current) => {
        if (outputs.some((output) => output.id === current)) return current;
        return outputs[0]?.id ?? '';
      });

      if (outputs.length === 0) {
        setMidiError('No MIDI outputs were found. Connect the device over USB MIDI and try again.');
      } else {
        setMidiMessage('Choose the MegaCMD MIDI output, then send the serial-mode request. Select USB device again.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const name = error instanceof DOMException ? error.name : '';
      if (name === 'NotAllowedError') {
        setMidiError('MIDI SysEx permission was not granted.');
      } else if (name === 'SecurityError') {
        setMidiError('MIDI SysEx is blocked by this browser or page context. Use Chrome/Edge on localhost or HTTPS.');
      } else {
        setMidiError(message);
      }
    } finally {
      setMidiBusy(false);
    }
  }

  function sendMidiSerialModeRequest(): void {
    setMidiError(null);
    setMidiMessage(null);

    const output = midiOutputs.find((candidate) => candidate.id === selectedMidiOutputId);
    if (!output) {
      setMidiError('Choose a MIDI output first.');
      return;
    }

    try {
      output.send(MIDI_SERIAL_MODE_SYSEX);
      setMidiMessage('Serial-mode request sent. Wait a few seconds, then click Select USB device.');
      log('success', `Sent MIDI serial-mode request to ${output.name || 'selected MIDI output'}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setMidiError(message);
      log('error', `Could not send MIDI serial-mode request: ${message}`);
    }
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>): void {
    void handleFile(event.target.files?.[0] ?? null);
  }

  function onHexDragOver(event: React.DragEvent<HTMLLabelElement>): void {
    event.preventDefault();
    if (!controlsLocked) setDragActive(true);
  }

  function onHexDragLeave(event: React.DragEvent<HTMLLabelElement>): void {
    event.preventDefault();
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDragActive(false);
    }
  }

  function onHexDrop(event: React.DragEvent<HTMLLabelElement>): void {
    event.preventDefault();
    setDragActive(false);
    if (controlsLocked) return;

    const file = event.dataTransfer.files?.[0] ?? null;
    if (fileInputRef.current) fileInputRef.current.value = '';
    void handleFile(file);
  }

  async function handleFile(file: File | null, profileForValidation = profile): Promise<boolean> {
    const readId = fileReadIdRef.current + 1;
    fileReadIdRef.current = readId;

    setFirmwareFile(file);
    setFirmwareImage(null);
    setHexError(null);
    setLastError(null);

    if (!file) return false;

    if (!HEX_FILE_EXTENSION.test(file.name)) {
      const message = 'Choose a firmware file with a .hex extension.';
      setHexError(message);
      setLastError(message);
      setProgress({ stage: 'error', percent: selectedPort ? 35 : 20, message: 'HEX validation failed.' });
      log('error', `HEX validation failed: ${message}`);
      return false;
    }

    if (file.size === 0) {
      const message = 'The selected HEX file is empty.';
      setHexError(message);
      setLastError(message);
      setProgress({ stage: 'error', percent: selectedPort ? 35 : 20, message: 'HEX validation failed.' });
      log('error', `HEX validation failed: ${message}`);
      return false;
    }

    if (file.size > MAX_HEX_FILE_BYTES) {
      const message = `The selected file is ${formatBytes(file.size)}; the safety limit is ${formatBytes(MAX_HEX_FILE_BYTES)}.`;
      setHexError(message);
      setLastError(message);
      setProgress({ stage: 'error', percent: selectedPort ? 35 : 20, message: 'HEX validation failed.' });
      log('error', `HEX validation failed: ${message}`);
      return false;
    }

    try {
      const image = await readHexFile(file);
      if (readId !== fileReadIdRef.current) return false;
      if (image.maxAddressExclusive > profileForValidation.flashSize) {
        throw new Error(`HEX ends at ${formatHexAddress(image.maxAddressExclusive)}, beyond ${profileForValidation.mcu} flash size ${formatHexAddress(profileForValidation.flashSize)}.`);
      }
      setFirmwareImage(image);
      const fileSummary = summarizeHex(image, profileForValidation.pageSize);
      log('success', `Loaded ${file.name}: ${formatBytes(fileSummary.usedBytes)} used data, ${fileSummary.pageCount} page(s).`);
      setProgress({ stage: 'idle', percent: selectedPort ? 35 : 20, message: 'HEX loaded.' });
      return true;
    } catch (error) {
      if (readId !== fileReadIdRef.current) return false;
      const message = error instanceof Error ? error.message : String(error);
      setHexError(message);
      setLastError(message);
      log('error', `HEX validation failed: ${message}`);
      return false;
    }
  }

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!canFlash || !selectedPort || !firmwareImage || abortControllerRef.current) return;

    setBusy(true);
    setLastError(null);
    abortControllerRef.current = new AbortController();
    setLogs([]);
    logIdRef.current = 1;
    log('info', `Profile: ${profile.label}.`);
    log('info', 'Browser readback verification is disabled for this release; use the device boot result as the final confirmation.');

    try {
      await flashFirmware({
        port: selectedPort,
        profile,
        image: firmwareImage,
        verify: false,
        log,
        onProgress: setProgress,
        signal: abortControllerRef.current.signal,
      });
      if (upgraderLoaded) {
        setAwaitingDevice(true);
        setFirmwareFile(null);
        setFirmwareImage(null);
        if (fileInputRef.current) fileInputRef.current.value = '';
        setProgress({ stage: 'done', percent: 100, message: 'Project upgrader written. Continue on your device.' });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLastError(message);
      setProgress((current) => ({ stage: 'error', percent: current.percent, message }));
      log('error', message);
    } finally {
      abortControllerRef.current = null;
      setBusy(false);
    }
  }

  function cancelFlash(): void {
    abortControllerRef.current?.abort();
    log('warn', 'Cancel requested. Current serial command will finish or time out first.');
  }

  function finishDeviceStep(): void {
    setAwaitingDevice(false);
    setProgress({ stage: 'idle', percent: selectedPort ? 10 : 0, message: 'Load the Latest stable HEX, then flash MCL.' });
  }

  function downloadLog(): void {
    const suffix = new Date().toISOString().replace(/[:.]/g, '-');
    downloadTextFile(`avr-update-log-${suffix}.txt`, logEntriesToText(logs));
  }

  function clearAll(): void {
    fileReadIdRef.current += 1;
    setSelectedPort(null);
    setPortInfo(null);
    setFirmwareFile(null);
    setFirmwareImage(null);
    setHexError(null);
    setLastError(null);
    setLogs([]);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setProgress({ stage: 'idle', percent: 0, message: 'Ready.' });
  }

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Web Serial</p>
          <h1>MCL Hex Flasher</h1>
        </div>
        <div className="hero-card">
          <Cpu size={34} />
          <div>
            <strong>{profile.shortLabel}</strong>
            <span>{profile.mcu} / {profile.protocol.toUpperCase()} / {resetStrategyLabel(profile)} / {profile.baudRate}</span>
          </div>
        </div>
      </header>

      {!serialSupported && (
        <section className="notice notice-error">
          <AlertTriangle />
          <div>
            <strong>Browser not supported.</strong>
            <p>Use Chrome/Edge on desktop with localhost or HTTPS.</p>
          </div>
        </section>
      )}

      <section className="progress-card">
        <div className="progress-head">
          <div>
            <span className={`pill pill-${progress.stage}`}>{progress.stage}</span>
            <strong>{progress.message}</strong>
          </div>
          <span>{Math.round(progress.percent)}%</span>
        </div>
        <div className="bar" aria-label="Flash progress">
          <div style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }} />
        </div>
        {lastError && (
          <div className="error-box">
            <AlertTriangle size={18} />
            <div>
              <strong>{lastError}</strong>
              <span>{recoveryHint(lastError)}</span>
            </div>
          </div>
        )}
      </section>

      <form className="grid" onSubmit={onSubmit}>
        <section className="card span-7">
          <div className="card-title">
            <span className="circle">1</span>
            <div>
              <h2>Hardware</h2>
            </div>
          </div>

          <label className="field">
            <span>Device profile</span>
            <select
              value={profileId}
              disabled={controlsLocked}
              onChange={(event) => {
                const nextProfile = getProfile(event.target.value);
                applyProfile(nextProfile);
              }}
            >
              {HARDWARE_PROFILES.map((item) => (
                <option key={item.id} value={item.id}>{item.label}</option>
              ))}
            </select>
          </label>

          <details className="profile-note">
            <summary>{profile.description}</summary>
            <ul>
              {profile.help.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </details>

        </section>

        <section className="card span-5 checklist-card">
          <div className="card-title">
            <TerminalSquare />
            <div>
              <h2>Checklist</h2>
            </div>
          </div>
          <ol className="checklist">
            <li className={stepClass(!!selectedPort, !selectedPort)}>USB connected</li>
            <li className={stepClass(!!selectedPort, !selectedPort && diyProfile)}>{diyProfile ? 'OS UPGRADE / serial mode' : 'OS Upgrade ready'}</li>
            <li className={stepClass(!!firmwareImage, !!selectedPort && !firmwareImage)}>Hex loaded</li>
            <li className={stepClass(progress.stage === 'done', !!canFlash)}>Flash started</li>
          </ol>
        </section>

        <section className="card span-12 usb-card">
          <div className="card-title">
            <span className="circle">2</span>
            <div>
              <h2>USB device</h2>
            </div>
          </div>

          <div className="usb-row">
            <div className="usb-primary">
              <div className="button-row">
                <button type="button" className="secondary" onClick={selectDevice} disabled={!serialSupported || controlsLocked}>
                  <Usb size={18} /> Select USB device
                </button>
                <button type="button" onClick={usePreviouslyAuthorisedDevice} disabled={!serialSupported || controlsLocked}>
                  <PlugZap size={18} /> Use authorised
                </button>
              </div>

              <div className="info-panel">
                <span>Selected port</span>
                {selectedPort ? (
                  <strong>VID {formatUsbId(portInfo?.usbVendorId)} / PID {formatUsbId(portInfo?.usbProductId)}</strong>
                ) : (
                  <strong>No device selected</strong>
                )}
              </div>
            </div>

            <details className="rescue-panel">
              <summary>Device not showing as USB serial?</summary>
              <div className="button-row">
                <button type="button" onClick={loadMidiOutputs} disabled={!midiSupported || controlsLocked || midiBusy}>
                  {midiBusy ? 'Looking for MIDI...' : 'Choose MIDI output'}
                </button>
              </div>
              {!midiSupported && <div className="inline-error">Web MIDI SysEx is not supported in this browser.</div>}
              {midiOutputs.length > 0 && (
                <div className="midi-rescue-controls">
                  <label className="field">
                    <span>MIDI output</span>
                    <select value={selectedMidiOutputId} disabled={controlsLocked || midiBusy} onChange={(event) => setSelectedMidiOutputId(event.target.value)}>
                      {midiOutputs.map((output) => (
                        <option key={output.id} value={output.id}>
                          {output.name || output.manufacturer || 'Unnamed MIDI output'}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="button" className="secondary" onClick={sendMidiSerialModeRequest} disabled={controlsLocked || midiBusy || !selectedMidiOutputId}>
                    Send serial-mode request
                  </button>
                </div>
              )}
              {midiMessage && <div className="inline-success">{midiMessage}</div>}
              {midiError && <div className="inline-error">{midiError}</div>}
            </details>
          </div>
        </section>

        <section className="card span-12 firmware-card">
          <div className="card-title">
            <span className="circle">3</span>
            <div>
              <h2>Firmware HEX</h2>
            </div>
          </div>

          <div className="firmware-row">
            <label
              className={`drop-zone${dragActive ? ' drop-zone-active' : ''}`}
              onDragOver={onHexDragOver}
              onDragLeave={onHexDragLeave}
              onDrop={onHexDrop}
            >
              <FileCode2 size={28} />
              <span>{firmwareFile ? firmwareFile.name : dragActive ? 'Drop HEX file here' : 'Choose or drag .hex file'}</span>
              <input
                type="file"
                accept=".hex,text/plain"
                ref={fileInputRef}
                disabled={controlsLocked}
                onChange={onFileChange}
              />
            </label>

            <div className="remote-firmware">
              <div className="remote-firmware-head">
                <strong>Downloads</strong>
                <span>Official MCL HEX</span>
              </div>
              <div className="remote-firmware-list">
                {[downloads.stable, downloads.beta].map((item) => {
                  return (
                    <div className="remote-firmware-row" data-firmware-id={item.id} key={item.id}>
                      <div>
                        <strong>{item.label}</strong>
                        <span>{item.description}</span>
                        {item.releaseUrl && (
                          <a href={item.releaseUrl} target="_blank" rel="noreferrer">
                            Release notes
                          </a>
                        )}
                      </div>
                      {item.enabled && item.downloadUrl ? (
                        <a
                          className="firmware-download-button secondary"
                          href={item.downloadUrl}
                          target="_blank"
                          rel="noreferrer"
                          title={`Download ${item.filename}`}
                        >
                          <Download size={18} />
                          Download
                        </a>
                      ) : (
                        <button type="button" disabled title={item.unavailableReason}>
                          <Download size={18} />
                          Download
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              {downloads.upgrader?.downloadUrl && !awaitingDevice && (
                <details className="project-guide">
                  <summary>Projects from before MCL 5.00?</summary>
                  <p>Back up your SD card first. Download the one-time project upgrader, choose its HEX file on this page, then select <strong>Flash project upgrader</strong>. Projects created in MCL 5.00 or later can skip this step.</p>
                  <div className="upgrade-links">
                    <a href={downloads.upgrader.downloadUrl} target="_blank" rel="noreferrer">Download project upgrader</a>
                    {downloads.upgrader.releaseUrl && <a href={downloads.upgrader.releaseUrl} target="_blank" rel="noreferrer">Upgrader release notes</a>}
                  </div>
                  <DeviceUpgradeSteps />
                  <p>The device saves the results in <code>/Logs/upgrade.txt</code> on the SD card.</p>
                </details>
              )}
            </div>
          </div>

          {summary && (
            <div className="summary-grid">
              <div><span>Used</span><strong>{formatBytes(summary.usedBytes)}</strong></div>
              <div><span>Range</span><strong>{formatHexAddress(summary.minAddress)} - {formatHexAddress(summary.maxAddressExclusive)}</strong></div>
              <div><span>Pages</span><strong>{summary.pageCount}</strong></div>
              <div><span>Page size</span><strong>{profile.pageSize} B</strong></div>
            </div>
          )}

          {hexError && <div className="inline-error">{hexError}</div>}
          {awaitingDevice && (
            <section className="device-step" aria-label="Continue on your device">
              <h2>Continue on your device</h2>
              <DeviceUpgradeSteps />
              <p>The results are in <code>/Logs/upgrade.txt</code> on the SD card.</p>
              <button type="button" onClick={finishDeviceStep}>Device is ready for MCL</button>
            </section>
          )}
        </section>

        <section className="card span-12 action-card">
          <div>
            <h2>{upgraderLoaded ? 'Flash project upgrader' : 'Flash update'}</h2>
            <p className="verify-note">{upgraderLoaded ? 'Back up your SD card first. After flashing, follow the prompts on your device to convert older projects.' : 'Write-only browser flow. The device should reboot after a successful flash.'}</p>
          </div>
          <div className="action-buttons">
            {busy ? (
              <button type="button" className="danger" onClick={cancelFlash}>
                <AlertTriangle size={18} /> Cancel
              </button>
            ) : (
              <button type="submit" className="primary" disabled={!canFlash}>
                <CheckCircle2 size={18} /> {upgraderLoaded ? 'Flash project upgrader' : 'Flash'}
              </button>
            )}
            <button type="button" onClick={clearAll} disabled={controlsLocked}>
              <RotateCcw size={18} /> Reset
            </button>
            <button type="button" onClick={downloadLog} disabled={logs.length === 0}>
              <Download size={18} /> Log
            </button>
          </div>
        </section>
      </form>

      <details className="card log-card">
        <summary className="log-summary">
          <span>
            <TerminalSquare size={20} />
            <strong>Live log</strong>
          </span>
          <em>{logs.length === 0 ? 'No entries' : `${logs.length} entr${logs.length === 1 ? 'y' : 'ies'}`}</em>
        </summary>
        <div className="log-window" role="log" aria-live="polite">
          {logs.length === 0 ? (
            <span className="muted">No log entries yet.</span>
          ) : (
            logs.map((entry) => (
              <div key={entry.id} className={`log-line log-${entry.level}`}>
                <span>[{entry.time}]</span>
                <strong>{entry.level.toUpperCase()}</strong>
                <em>{entry.message}</em>
              </div>
            ))
          )}
        </div>
      </details>
      <footer className="site-footer">
        <a href="https://github.com/waftlord/mclhexflasher" target="_blank" rel="noreferrer">MCL Hex Flasher on GitHub</a>
      </footer>
    </main>
  );
}
