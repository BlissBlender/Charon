# Charon

Charon is a portable Windows desktop app for installing Steam manifests through the bundled Charon Lua repository, fallback API sources, or manual ZIP import.

## Download

The current portable build is:

- Version: `1.0.7`
- File: `Charon-1.0.7.exe`
- SHA-256: `851340883a2afa873c9d5220b67678ab25fb7e55cd6eedf2d9ef1fa5182e939b`

Upload the exe to a GitHub Release tagged `v1.0.7` with the asset name `Charon-1.0.7.exe`.

## Updates

Charon checks this public update manifest:

`https://raw.githubusercontent.com/BlissBlender/Charon/main/latest.json`

For every new release:

1. Build the portable exe.
2. Upload the exe to a GitHub Release, for example `v1.0.1`.
3. Update `latest.json` with the new version, download URL, release URL, SHA-256, notes, and publish time.
