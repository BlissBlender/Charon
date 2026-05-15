# Charon

Charon is a portable Windows desktop app for installing Steam manifest packages through bundled API sources or manual ZIP import.

## Download

The current portable build is:

- Version: `1.0.0`
- File: `Charon-1.0.0.exe`
- SHA-256: `ca8ed984dfa9fea0256c34f9cbf1ab9773218d670a2e6b87ae047a1e8de3b083`

Upload the exe to a GitHub Release tagged `v1.0.0` with the asset name `Charon-1.0.0.exe`.

## Updates

Charon checks this public update manifest:

`https://raw.githubusercontent.com/BlissBlender/Charon/main/latest.json`

For every new release:

1. Build the portable exe.
2. Upload the exe to a GitHub Release, for example `v1.0.1`.
3. Update `latest.json` with the new version, download URL, release URL, SHA-256, notes, and publish time.
