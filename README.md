# The Editor

A Windows-first, local photography workflow for Capture the Chapter Studio. The Editor uses darktable as its non-destructive RAW engine and will coordinate shoot import, preview generation, culling, look approval, batch editing, watermarking, and dual exports.

## Current checkpoint

- Windows desktop application
- Detects the local darktable CLI
- Selects and scans a shoot folder
- Recognizes common RAW, JPEG, PNG, and TIFF formats
- Never writes to source photographs

## Run and package

```powershell
npm install
npm run dev
npm run dist
```

Local release artifacts are written to `release/` and intentionally excluded from Git.
