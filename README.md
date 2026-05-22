# Charon

Charon is a portable Windows desktop app for installing Steam manifests through the bundled Charon Database, fallback API sources, or manual ZIP import.

## Download

The current portable build is:

- Version: `1.0.9`
- File: `Charon-1.0.9.exe`
- SHA-256: `31b751f9a3d21fc2754c7527f0e8fddf418cc5203f9c373ee219ac2927ba98cf`

Upload the exe to a GitHub Release tagged `v1.0.9` with the asset name `Charon-1.0.9.exe`.

## Updates

Charon checks this public update manifest:

`https://raw.githubusercontent.com/BlissBlender/Charon/main/latest.json`

For every new release:

1. Build the portable exe.
2. Upload the exe to a GitHub Release, for example `v1.0.1`.
3. Update `latest.json` with the new version, download URL, release URL, SHA-256, notes, and publish time.
