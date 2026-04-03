# Build Tools

Bundled binaries for building .deb firmware packages on macOS.

## gnu-ar

GNU ar (binutils 2.34) for creating .deb archives.

**Why bundled:** macOS `/usr/bin/ar` is broken for .deb files (produces 96-byte files with only SYMDEF). MacPorts `gar` adds trailing slashes to member names. Only GNU ar from Homebrew binutils works correctly, but the path varies per installation.

**Used by:**
- `research/build_custom_firmware.sh`
- `research/build_ssh_key_firmware.sh`

**Platform:** macOS x86_64 (Mach-O). For other platforms, install `binutils` via your package manager — the scripts fall back to searching Homebrew/system paths if `tools/bin/gnu-ar` is not found.

## Windows

On Windows, use WSL (Windows Subsystem for Linux) or Git Bash with GNU binutils installed:
```
apt install binutils  # WSL/Debian
```
The build scripts will need adaptation for Windows paths — this is a TODO.
