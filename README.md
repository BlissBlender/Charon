# Charon

Charon is a portable Windows desktop app for installing Steam manifest packages through bundled API sources or manual ZIP import.

## Download

The current portable build is:

- Version: `1.0.5`
- File: `Charon-1.0.5.exe`
- SHA-256: `00662291f4615949bea43c9caae923bbd42a7c3e8ebf7279c6438a1e244ba498`

Upload the exe to a GitHub Release tagged `v1.0.5` with the asset name `Charon-1.0.5.exe`.

## Updates

Charon checks this public update manifest:

`https://raw.githubusercontent.com/BlissBlender/Charon/main/latest.json`

For every new release:

1. Build the portable exe.
2. Upload the exe to a GitHub Release, for example `v1.0.1`.
3. Update `latest.json` with the new version, download URL, release URL, SHA-256, notes, and publish time.
