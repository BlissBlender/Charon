# Charon

Charon is a portable Windows desktop app for installing Steam manifest packages through bundled API sources or manual ZIP import.

## Download

The current portable build is:

- Version: `1.0.1`
- File: `Charon-1.0.1.exe`
- SHA-256: `cc709bc4fa6bcf7d0af0c01ca044948ed5385da22e1a979f874ae25da43cebb2`

Upload the exe to a GitHub Release tagged `v1.0.1` with the asset name `Charon-1.0.1.exe`.

## Updates

Charon checks this public update manifest:

`https://raw.githubusercontent.com/BlissBlender/Charon/main/latest.json`

For every new release:

1. Build the portable exe.
2. Upload the exe to a GitHub Release, for example `v1.0.1`.
3. Update `latest.json` with the new version, download URL, release URL, SHA-256, notes, and publish time.
