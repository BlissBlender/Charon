# Charon

Charon is a portable Windows desktop app for installing Steam manifests through the bundled Charon Lua repository, fallback API sources, or manual ZIP import.

## Download

The current portable build is:

- Version: `1.0.6`
- File: `Charon-1.0.6.exe`
- SHA-256: `611e0da78383318611507ff2bfd0958a2e19cdcff20f8eb9d451c53d09025e8`

Upload the exe to a GitHub Release tagged `v1.0.6` with the asset name `Charon-1.0.6.exe`.

## Updates

Charon checks this public update manifest:

`https://raw.githubusercontent.com/BlissBlender/Charon/main/latest.json`

For every new release:

1. Build the portable exe.
2. Upload the exe to a GitHub Release, for example `v1.0.1`.
3. Update `latest.json` with the new version, download URL, release URL, SHA-256, notes, and publish time.
