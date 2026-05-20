# Charon

Charon is a portable Windows desktop app for installing Steam manifests through the bundled Charon Database, fallback API sources, or manual ZIP import.

## Download

The current portable build is:

- Version: `1.0.8`
- File: `Charon-1.0.8.exe`
- SHA-256: `c3577b34af1d0c031d64fe07a8d31f586eca0a51762e2cee0d5ad896951f607b`

Upload the exe to a GitHub Release tagged `v1.0.8` with the asset name `Charon-1.0.8.exe`.

## Updates

Charon checks this public update manifest:

`https://raw.githubusercontent.com/BlissBlender/Charon/main/latest.json`

For every new release:

1. Build the portable exe.
2. Upload the exe to a GitHub Release, for example `v1.0.1`.
3. Update `latest.json` with the new version, download URL, release URL, SHA-256, notes, and publish time.
