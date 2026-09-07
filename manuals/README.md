# OpenNova manuals

[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/rvbcrs)

End-user manuals (HTML + PDF) and the tooling that generates their screenshots.
Each manual folder is self-contained — open the `.html` in a browser or the
`.pdf` directly, or run `build-pdf.sh` to regenerate the PDF from the HTML.

## Contents

### `OpenNova/` — the mobile app manual
- `OpenNova-Manual.html` / `.pdf` — the manual (16 app screens, English).
- `img/` — the screenshots used by the manual (sRGB, colour-corrected).
- `source/` — the raw screenshots (incl. hand-supplied real-device shots).
- `fastlane/` — the screenshot **generator** (fastlane snapshot). It drives the
  app at `../../app`; see `fastlane/README-snapshots.md`. A few required source
  edits live in the app itself (gated behind `EXPO_PUBLIC_SNAPSHOT`, off in
  normal builds) and are listed in that README.
- `build-pdf.sh` — re-render the PDF from the HTML (headless Chrome).

### `admin-manual/` — the server admin-panel manual
- `OpenNova-Admin-Manual.html` / `.pdf` — the manual (11 admin screens, English).
- `img/` — screenshots used (sRGB). `source/` — raw browser screenshots.
- `screenshots/` — the Playwright admin-screenshot harness (`admin.mjs`).
- `build-pdf.sh` — re-render the PDF.

## Regenerating a PDF

```bash
cd manuals/OpenNova        # or manuals/admin-manual
./build-pdf.sh
```

## Regenerating the app screenshots

```bash
cd manuals/OpenNova
ruby fastlane/setup_snapshot.rb   # once, and after every `expo prebuild`
fastlane snapshot
```

Real iPhone/Mac screenshots are HDR (Display P3 / PQ) and look washed out in a
PDF — convert to sRGB before embedding:

```bash
sips --matchTo "/System/Library/ColorSync/Profiles/sRGB Profile.icc" in.png --out out.png
```
