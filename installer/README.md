# OpenNova Installer

[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/rvbcrs)

A cross-platform Electron desktop app that builds **and writes** a ready-to-run
OpenNova SD card: it downloads the latest stock Raspberry Pi OS Lite 64-bit,
bakes an OpenNova first-boot configuration into the image's boot partition,
writes the result straight to your microSD card, and then helps you find the
booted Pi and open its `/admin` setup wizard.

## How it writes the card without Full Disk Access

Writing a raw disk on macOS normally requires the app to hold **Full Disk
Access** (a TCC grant) — it fails with `EPERM` even as root otherwise. For an
unsigned, self-distributed tool that is unworkable. Two things sidestep it.
First, the config is baked into the image **file** (no card, no mount, no
elevation) by editing its FAT boot partition with mtools. Second, the card write
uses the OS's own privileged opener instead of Full Disk Access: on macOS the
bundled `fdwrite` helper runs `authopen -stdoutpipe -w <device>` (the same
Apple-entitled technique Raspberry Pi Imager uses), on Linux `pkexec`, and on
Windows an elevated PowerShell write via UAC. The user sees one password prompt
at write time and nothing else; no Full Disk Access and no code signing are
required just to run the app.

## How it works

1. Collect the user's settings (hostname, network, timezone, connection path, SSH).
2. Download the **latest** Raspberry Pi OS Lite 64-bit (the `_latest` endpoint)
   and verify it against the published `.sha256` sidecar. Download is atomic
   (verify-then-rename) and cached.
3. Decompress the `.img.xz` to a working `.img` (via `@napi-rs/lzma`, N-API so it
   loads in the Electron main process).
4. Patch the image's FAT boot partition with `firstrun.sh`, an empty `ssh`
   sentinel, and an idempotent `cmdline.txt` append — the documented Raspberry Pi
   first-boot mechanism. On first boot the Pi runs `firstrun.sh` once, installs
   Docker, and brings up the OpenNova container. When SSH is enabled (default),
   `firstrun.sh` also creates the login account (username + password and/or an
   authorized public key) — modern Pi OS ships no default `pi` user, so without
   this `sshd` would run with no way in. The `ssh` sentinel is omitted when SSH is
   turned off.
5. Write the patched image to the chosen **removable** card (never the system
   disk) with one elevation prompt — `fdwrite`/`authopen` on macOS, `pkexec` on
   Linux, UAC on Windows — streaming write progress to the UI.
6. "Find my Pi" once it has booted (mDNS) and deep-link to
   `http://opennova.local/admin`. A manual-IP box covers networks without mDNS.

## Architecture

- **Main process** (`src/main/`):
  - `configModel.ts` — turns `InstallerConfig` into `firstrun.sh`, `.env`,
    `docker-compose.yml`, and the `cmdline.txt` append.
  - `imageSource.ts` — streaming download, sha256 verify, and xz decompression.
  - `imagePatcher.ts` — write the boot files into the image's FAT boot partition
    with **mtools** (`mcopy`/`mtype`) at a byte offset (`image.img@@<offset>`),
    no mount / root / Full Disk Access. One code path on macOS/Linux/Windows;
    the small mtools binaries are bundled under `vendor/mtools/` (see its README).
  - `bootInject.ts` — `writeBootFiles` (the idempotent boot-partition writes).
  - `drives.ts` — enumerate SAFE removable cards (never the system disk).
  - `flashDisk.ts` + `flashMac.ts` / `flashLinux.ts` / `flashWindows.ts` — write
    the image to the card with a per-OS privileged writer (authopen / pkexec /
    UAC) and stream progress.
  - `discovery.ts` — poll the health endpoint until the Pi answers `running`.
  - `ipc.ts` + `preload.ts` — typed, context-isolated bridge on
    `window.installer` exposing the `InstallerApi` (`buildImage`, `scanDrives`,
    `startFlash`/`cancelFlash`, `checkHostname`, `findPi`, `openExternal`, …).
- **Renderer** (`src/renderer/`): React + Tailwind wizard
  (welcome, config, build, flash, finish). `wizard.ts` is a pure, unit-tested
  step state machine.
- **Shared** (`src/shared/`): the IPC contract (`types.ts`) and the Pi OS release
  descriptor (`piOsRelease.ts`, always-latest).

## Development

```bash
cd installer
npm install

npm run build:main       # main process (TypeScript -> dist/main)
npm run build:renderer   # renderer (Vite -> dist/renderer)
npm run build            # both
npm test                 # unit + integration tests (Vitest)
```

To run the app against the live Vite dev server, start the renderer
(`npm run dev:renderer`) and launch Electron with `OPENNOVA_DEV_SERVER_URL` set
to the dev server URL. Without that variable the window loads the built
`dist/renderer/index.html`.

## Packaging

```bash
npm run pack    # build + electron-builder --dir (unpacked app, fast, for testing)
npm run dist    # build + electron-builder (dmg / nsis / AppImage)
```

The app writes the card with the OS's own privileged opener (macOS `authopen`
via the bundled `fdwrite`, Linux `pkexec`, Windows UAC), so it needs **no Full
Disk Access** on macOS — only the one password prompt at write time. Code
signing / notarization is still recommended so macOS Gatekeeper opens the app
without a warning, but it is not required to run. Unsigned builds open via
right-click → Open.

## The Raspberry Pi OS image (always latest)

`src/shared/piOsRelease.ts` holds the `_latest` endpoint URL. At build time the
app resolves it to the current dated image and verifies it against the published
`.img.xz.sha256` sidecar, so there is no pinned hash to maintain and no new
release needed when Raspberry Pi publishes a new image. The `cmdline.txt` token
sequence in `configModel.ts` is the documented Raspberry Pi OS first-boot
mechanism.

## End-to-end verification (manual)

The unit and integration tests cover the pure logic (config generation, sha256
verify + sidecar parse, the wizard state machine). The items below cover the
parts only a real card and Pi can prove.

### Build (each host OS)

The patcher uses mtools, so the code path is identical per OS; what differs is
the bundled `mcopy`/`mtype` binary (`vendor/mtools/<platform>-<arch>/`).

- [ ] **macOS**: build an image, confirm the output `.img` exists and its FAT
      boot partition contains `firstrun.sh`, `ssh`, and the patched
      `cmdline.txt`, and that `fsck_msdos` reports the partition clean. (Verified
      end-to-end on macOS 26, arm64.)
- [ ] **Linux / Windows**: add the platform's mtools binary (see
      `vendor/mtools/README.md`), then run the same build + `fsck.vfat` check.

### First boot (real hardware)

- [ ] Write the card in the app, boot a real
      **Raspberry Pi 4** and **5**: confirm first boot auto-installs Docker and
      OpenNova, then `http://opennova.local/api/setup/health` returns
      `server: "running"`.
- [ ] Confirm `firstrun.sh` runs exactly once and
      `/var/log/opennova-firstrun.log` shows a clean install.

### Network + connection paths

- [ ] **Ethernet** and **Wi-Fi** (SSID, password, country) both come up.
- [ ] **OpenNova app** (default): `ENABLE_DNS` NOT set, reachable via
      `opennova.local`. **Original Novabot app**: `ENABLE_DNS: "true"` set.

### Discovery and handoff

- [ ] "Find my Pi" resolves `opennova.local` and "Open admin" opens
      `http://opennova.local/admin`; the manual-IP fallback works without mDNS.
