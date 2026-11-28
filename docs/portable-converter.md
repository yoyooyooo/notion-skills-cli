# Offline portable archive conversion

Normal import and export use portable manifest v2. A v1 manifest returns `PORTABLE_UPGRADE_REQUIRED`; current commands do not enable historical decoding. The separately built converter accepts an explicitly selected local file tree or ZIP and changes its v1 metadata to v2.

## Build the independent tool

```sh
bun scripts/build-portable-converter.ts /absolute/new-package-directory
```

Install that directory’s exact dependencies with npm and run its `ntn-skills-portable-convert.js` with a supported Node runtime. The converter is excluded from the normal CLI build and package file list.

## Convert selected current files

```sh
node /absolute/new-package-directory/ntn-skills-portable-convert.js offline \
  --input /absolute/current-files-or.zip \
  --output /absolute/new-converted-directory \
  --kind skill
```

`--kind` accepts `skill`, `router` or `prompt`. Omitting it selects `skill` and records that default in the output inventory. The input must contain one valid v1 manifest and the complete files selected as current content. Conversion validates paths, duplicate entries, the main file and the resulting v2 archive. File bytes, including binary resources, remain unchanged.

An old `projection` or authored/generated materialization is not an instruction to choose current content. Such input returns `PORTABLE_CURRENT_SELECTION_REQUIRED`. Explicitly select the desired current file tree before converting; the converter does not infer which retained copy should win. Normal v2 imports also reject extra projection fields.

The output directory must be new and outside the input. It receives `converted.zip` and `audit.json`, which records input/output paths, each file’s byte length and SHA-256, and the selected kind. Validation completes before output creation. Original input files are never overwritten. This inventory documents the local conversion; it does not create Notion versions or a recovery journal.

This tool has one `offline` subcommand. It performs no Notion reads or writes and has no remote planning, publication-proof conversion, apply, resume or reconciliation operation. Import the resulting current files through the normal current CLI when ready.
