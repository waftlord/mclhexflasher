# MCL Hex Flasher

MCL Hex Flasher is a browser-based Intel HEX firmware updater for the ATmega2560 on MegaCommand DIY and MegaCMD hardware. It programs the main microcontroller through its serial bootloader using Web Serial.

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
3. Load a `.hex` file for the selected device. MCL update images are available from [upstream MCL releases](https://github.com/jmamma/MCL/releases) and linked in the app.
4. Select **Flash** and wait for the result before disconnecting the device. The browser workflow writes flash without reading it back.

## License

Original code is available under the [MIT License](LICENSE). See [Third-party notices](THIRD_PARTY_NOTICES.md) for upstream references and license terms.
