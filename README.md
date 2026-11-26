# MCL Hex Flasher

MCL Hex Flasher is a browser-based Intel HEX firmware updater for the ATmega2560 on MegaCommand DIY and MegaCMD hardware. It programs the main microcontroller through its serial bootloader using Web Serial.

[Open MCL Hex Flasher](https://wftlrd.uk/mclhexflasher/)

## Requirements

- Desktop Chrome or Edge with Web Serial support. Serve the app over HTTPS or run it on `localhost`.
- A device with a supported serial bootloader and a firmware image for its ATmega2560.

| Hardware profile | Serial bootloader | Speed |
| --- | --- | --- |
| MegaCommand DIY | Wiring / STK500v2 | 115200 baud |
| MegaCMD | STK500v1 | 115200 baud |

USB controller firmware requires a separate DFU tool. An Intel HEX file does not identify the chip it targets. Confirm the image is for the main ATmega2560 before flashing.

## Run from source

Use Node.js 20.19 or later in the 20.x line, or Node.js 22.12 or later.

```sh
npm ci
npm run dev
```

Open the local address printed by Vite. To build and preview the static site, run `npm run build` followed by `npm run preview`. The build output is in `dist/`.

## Update firmware

1. Select the hardware profile and put the device in **OS UPGRADE** or serial bootloader mode. With MCL installed, hold **PAGE** at power-on to open the boot menu.
2. Choose **Select USB device** and select the device's serial port. On compatible MegaCommand DIY USB firmware, the app can also send a serial-mode request to the selected MIDI output using Web MIDI SysEx.
3. Choose **Load MCL** in **Firmware HEX**, or open a local `.hex` file. The flasher checks the bundled image against its published SHA-256 checksum before loading it. Newer releases without a bundled image offer a download from [upstream MCL releases](https://github.com/jmamma/MCL/releases).
4. Select **Flash** and wait for the result before disconnecting the device. The browser workflow writes flash without reading it back.

### Projects created before MCL 5.00

Back up the SD card. In **Firmware HEX**, open **Projects from before MCL 5.00?** and choose **Load project upgrader**. Select **Flash project upgrader** when ready. Both hardware profiles use the same file.

On the device, **Load / Yes** scans the card, then a second **Load / Yes** confirms conversion. Keep power connected until the device says **NOW UPGRADE TO MCL 5.10**. Return the device to OS UPGRADE or serial mode, then select **Device ready — load MCL** and **Flash**. The device writes its report to `/Logs/upgrade.txt`.

Projects created in MCL 5.00–5.02 open directly in MCL 5.10. [MCL 5.10 release notes](https://github.com/jmamma/MCL/releases/tag/5.10)

## License

Original code is available under the [MIT License](LICENSE). See [Third-party notices](THIRD_PARTY_NOTICES.md) for upstream references and license terms.
