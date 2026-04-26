# TinyVU

A minimalist VU meter plugin built with the same JUCE + WebView (Vite / React / MUI) stack as the sister plugins (ZeroComp / ZeroLimit / ZeroEQ / TestTone). The audio path is fully pass-through — TinyVU only observes the signal and shows it on a classic analog-style VU meter that can be shrunk to almost any size.

Supported formats: **VST3 / AU / AAX / Standalone** (Windows / macOS) and **VST3 / LV2 / CLAP / Standalone** (Linux), plus a **WebAssembly browser demo**.  
https://tinyvu-demo.web.app/

<img width="612" height="468" alt="image" src="https://github.com/user-attachments/assets/34d0a9dc-639e-484d-8336-3b30b58c9519" />

## Features

- **Truly small footprint** — the plugin window can be resized down to 240 × 90, and the meter still stays readable.
- **Mono / stereo auto-switching** — single meter on a mono bus, side-by-side L/R on stereo. When the host window becomes more square-ish than the meter aspect ratio (5:3), the two meters automatically stack vertically so each one stays as large as possible.
- **Reference Level (-24..0 dBFS, 1 dB steps)** — drag-edit / wheel / click-to-type the value. The needle is calibrated for a sine wave so that a `-X dBFS` peak sine settles at 0 VU when reference is `-X`.
- **Light / Dark dial themes** — only the dial face flips; surrounding chrome stays consistent with the rest of the series.
- **Click-to-reset peak indicator** — the red peak lamp can be cleared with a single click while it's lit or fading.
- **Authentic 2nd-order ballistics** — IEC 60268-17 (T₉₉ ≈ 350 ms) critically-damped damping implemented as a closed-form analytical step, so there is no Euler-style overshoot. Asymmetric configurations were tried and rolled back; the current symmetric ballistics matches commercial VU plugins in feel.
- **Low-latency rendering** — the C++ side runs a 5 ms sliding-window RMS and a 120 Hz timer, the WebView side bypasses React state and writes the needle's `transform` directly to the DOM in `requestAnimationFrame`.

## Web demo

A browser demo lives alongside the plugin code. It uses **the same DSP**: `wasm/src/vu_meter.h` is the plugin's `VuMeter.cpp` ported to a JUCE-free namespace and compiled to WebAssembly via emscripten, then run inside an `AudioWorkletProcessor`. The audio source is a built-in sample with optional drag-and-drop file upload, and the visual is the exact same `VUMeter` React component as the plugin.

- Dev: `cd webui && npm run dev:web` → http://127.0.0.1:5174
- Build: `npm run build:web` → emits `webui/dist/`
- Deploy: `npm run deploy:web` (Firebase Hosting; project ID `tinyvu-demo` in `.firebaserc`)

The browser runs the same RMS, the same +3.01 dB sine calibration, the same ballistics — so the two implementations are visually indistinguishable.

## Requirements

- CMake 3.22+
- C++17 toolchain
  - Windows: Visual Studio 2022 (Desktop development with C++)
  - macOS: Xcode 14+
  - Linux: gcc 13+ / clang + the apt packages listed under [Building on Linux](#building-on-linux)
- Node.js 18+ and npm (for the WebUI build)
- JUCE (vendored as a git submodule)
- `clap-juce-extensions` (vendored as a git submodule, used only for Linux CLAP build)
- Optional: AAX SDK (Pro Tools — drop into `aax-sdk/`)
- Optional: Inno Setup 6 (for the Windows installer)
- Optional (for the web demo): emscripten / emsdk

## Getting started

```bash
# 1. Clone with submodules
git submodule update --init --recursive

# 2. Install WebUI dependencies
cd webui && npm install && cd ..

# 3. Build a release
# Windows
powershell -ExecutionPolicy Bypass -File build_windows.ps1 -Configuration Release
# macOS
./build_macos.zsh
# Linux (see "Building on Linux" below for required apt packages)
bash build_linux.sh
```

### Building on Linux

Tested on **WSL2 Ubuntu 24.04**, but should work on any modern glibc-based distro with `webkit2gtk-4.1` available.

Install the build dependencies:

```bash
sudo apt update
sudo apt install -y \
  build-essential pkg-config cmake ninja-build git \
  libasound2-dev libjack-jackd2-dev libcurl4-openssl-dev \
  libfreetype-dev libfontconfig1-dev \
  libx11-dev libxcomposite-dev libxcursor-dev libxext-dev \
  libxinerama-dev libxrandr-dev libxrender-dev \
  libwebkit2gtk-4.1-dev libglu1-mesa-dev mesa-common-dev libgtk-3-dev
```

Then:

```bash
git submodule update --init --recursive   # JUCE + clap-juce-extensions
bash build_linux.sh                        # Release build of VST3 / LV2 / CLAP / Standalone
```

Output:

- Build artefacts: `build-linux/plugin/TinyVU_artefacts/Release/{VST3,LV2,CLAP,Standalone}/`
- Auto-installed: `~/.vst3/TinyVU.vst3`, `~/.lv2/TinyVU.lv2`, `~/.clap/TinyVU.clap`
- Distribution zip: `releases/<VERSION>/TinyVU_<VERSION>_Linux_VST3_LV2_CLAP_Standalone.zip`

LV2 and CLAP are gated behind `if(UNIX AND NOT APPLE)` in CMake, so existing Windows / macOS release flows are unaffected. AU and AAX are skipped on Linux as expected.

### Manual CMake build (development)

```bash
# Windows
cmake -B build -G "Visual Studio 17 2022" -A x64
cmake --build build --config Debug --target TinyVU_VST3

# macOS
cmake -B build -G Xcode
cmake --build build --config Debug --target TinyVU_VST3
```

### Hot-reload dev mode

```bash
# Terminal A — Vite dev server for the WebUI
cd webui && npm run dev

# Terminal B — Standalone Debug build (loads the WebUI from 127.0.0.1:5173)
cmake --build build --config Debug --target TinyVU_Standalone
```

Debug builds load the UI from `http://127.0.0.1:5173`; Release builds embed the WebUI as zip resources via `juce_add_binary_data`.

### Building the WebAssembly DSP

```powershell
# Windows
& 'emsdk\emsdk_env.ps1'
cd TinyVU\wasm
Remove-Item -Recurse -Force build -ErrorAction SilentlyContinue
New-Item -ItemType Directory build | Out-Null
cd build
emcmake cmake .. -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build .
Copy-Item -Force dist\tinyvu_dsp.wasm ..\..\webui\public-web\wasm\
```

> If the C++ `VuMeter` ever changes, rebuild the WASM and copy the artifact into `webui/public-web/wasm/`. Otherwise the web demo will silently keep running the old DSP.

## Window sizing

| | Width | Height |
| ---- | ---- | ---- |
| Minimum | 240 | 90 |
| Default | 600 | 220 |
| Maximum | 32767 | 32767 (effectively unlimited) |

The plugin window has a corner resize grip and the host's native frame; both share the same constrainer. Below ~220 px tall or ~260 px wide the title row and reference / theme controls fold away automatically so the meters keep as much room as possible.

## Parameters (APVTS)

| ID                | Type    | Range                                       | Default      | Notes |
| ----------------- | ------- | ------------------------------------------- | ------------ | ----- |
| `REFERENCE_LEVEL` | float   | `-24..0` dBFS, integer step                 | `-18 dBFS`   | dBFS that maps to 0 VU. Click the input to type, or drag / wheel to scrub. |
| `THEME`           | choice  | `Dark` / `Light`                            | `Dark`       | Switches only the dial face; the surrounding plugin chrome stays in dark. |

## DSP

- **C++ side** (`plugin/src/dsp/VuMeter.{h,cpp}`)
  - `processBlock` does **not** modify the buffer; it only feeds samples to per-channel `VuMeter` instances.
  - 5 ms sliding-window RMS via a ring buffer of squared samples + an incremental `runningSum`. Recomputed in full at the end of each block to suppress numerical drift.
  - Output is converted to dBFS, clamped at -120 dBFS, and a **+3.0103 dB sine calibration offset** is added so a -X dBFS sine peak reads `-X` instead of `-X-3` (matching how engineers think about "0 VU = -X dBFS sine").
- **Bridge** — a 120 Hz `juce::Timer` reads the per-channel atomics and emits a `meterUpdate` event to the WebView. Channel layout changes are sent on `channelLayoutChanged`.
- **WebUI ballistics** (`webui/src/components/VUMeter.tsx`)
  - 2nd-order critically-damped step response with `T₉₉ = 0.35 s`
    `x(t) = target + (A + B·t)·e^(-ω·t)`,  `ω = 6.638 / T₉₉`
  - Solved analytically per `requestAnimationFrame` step so the result is bit-exact to the continuous-time solution; no integration overshoot.
  - The needle's CSS `transform` and the peak lamp's `backgroundColor` / `boxShadow` are written directly to the DOM (no `setState`), to keep visual latency on the order of one display frame.

## AAX / PACE signing

- The TinyVU-specific WrapGUID is **never committed**; it lives in the developer's local `.env` as `PACE_ORGANIZATION`. Use a sister repository's `.env` as a template and overwrite the GUID.
- Setting `PACE_USERNAME` / `PACE_PASSWORD` / `PACE_KEYPASSWORD` / `PACE_ORGANIZATION` plus a PFX certificate (`tinyvu-dev.pfx` in the project root, or path via `PACE_PFX_PATH`) makes both the Windows and macOS build scripts sign the AAX bundle automatically.
- If any of the above is missing, the build still succeeds with an unsigned AAX (suitable for CI / development).

### Generating the dev signing certificate (Windows)

For a fresh repo, create a self-signed code-signing PFX matching the password in `.env` (`PACE_KEYPASSWORD=dev-pass-123` for the Zero series). PowerShell:

```powershell
$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert -KeyUsage DigitalSignature `
  -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 `
  -NotAfter (Get-Date).AddYears(3) `
  -Subject "CN=TinyVU Dev" -FriendlyName "TinyVU Dev" `
  -CertStoreLocation Cert:\CurrentUser\My
Export-PfxCertificate -Cert $cert `
  -FilePath .\tinyvu-dev.pfx `
  -Password (ConvertTo-SecureString 'dev-pass-123' -Force -AsPlainText) | Out-Null
Remove-Item -Path "Cert:\CurrentUser\My\$($cert.Thumbprint)" -DeleteKey
```

#### ⚠ Gotcha: PFX must be re-encoded in legacy PKCS#12 format

Windows 11's `Export-PfxCertificate` writes PKCS#12 with **PBES2 / AES-256** key encryption. PACE wraptool's internal Windows code-signing wrapper (`ossignaturewin.cpp`) cannot extract the private key from this modern format and dies with:

```
Key file ... doesn't contain a valid signing certificate.
```

even though the very same PFX works with `signtool` and `Get-PfxCertificate`. **The fix is to re-encode the PFX with the legacy PBE-SHA1-3DES algorithm and SHA1 MAC** using OpenSSL right after exporting:

```powershell
$env:OPENSSL_MODULES = 'C:\Program Files\Git\mingw64\lib\ossl-modules'
$ossl = 'C:\Program Files\Git\mingw64\bin\openssl.exe'
$tmp = "$env:TEMP\dev.pem"

& $ossl pkcs12 -in tinyvu-dev.pfx -nodes -passin 'pass:dev-pass-123' -out $tmp
& $ossl pkcs12 -export -in $tmp -out tinyvu-dev.pfx -passout 'pass:dev-pass-123' `
    -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg SHA1 -legacy
Remove-Item $tmp
```

The `-legacy` flag requires `legacy.dll` to be loadable, hence `$env:OPENSSL_MODULES` pointing at Git for Windows' `ossl-modules`. The `C:\Program Files\OpenSSL-Win64\` distribution has a broken module search path on some installs, so use the OpenSSL bundled with Git for Windows instead. Output during signing of the form `Warning! ... doesn't have a trusted root in the system.` is expected for a self-signed dev cert and can be ignored.

## Directory layout

```
TinyVU/
├─ plugin/
│  ├─ src/
│  │  ├─ PluginProcessor.*    # APVTS + per-channel VuMeter; processBlock observes only
│  │  ├─ PluginEditor.*       # WebView init + 120 Hz meterUpdate emitter + ResizableCorner
│  │  ├─ ParameterIDs.h       # REFERENCE_LEVEL / THEME
│  │  ├─ KeyEventForwarder.*  # WebView → host key forwarding
│  │  └─ dsp/
│  │     └─ VuMeter.{h,cpp}   # 5 ms sliding-window RMS detector
│  └─ CMakeLists.txt
├─ webui/
│  ├─ src/
│  │  ├─ App.tsx                                # layout + Reference / Theme controls
│  │  ├─ components/
│  │  │  ├─ VUMeter.tsx                          # SVG dial + 2nd-order ballistics
│  │  │  ├─ NumericDragInput.tsx                 # drag/wheel/click-to-type number control
│  │  │  ├─ MaterialUISwitch.tsx                 # custom sun/moon theme switch
│  │  │  ├─ WebTransportBar.tsx                  # play / loop / seek / bypass / upload (web demo)
│  │  │  ├─ WebDemoMenu.tsx                      # sister-plugin links (web demo)
│  │  │  ├─ LicenseDialog.tsx, GlobalDialog.tsx
│  │  ├─ bridge/
│  │  │  ├─ juce.ts                              # plugin bridge (juce-framework-frontend-mirror)
│  │  │  └─ web/                                 # web demo bridge (alias-resolved at build time)
│  │  │     ├─ WebAudioEngine.ts
│  │  │     ├─ WebBridgeManager.ts
│  │  │     ├─ WebParamState.ts
│  │  │     ├─ juce-shim.ts
│  │  │     └─ web-juce.ts
│  │  └─ hooks/useJuceParam.ts                   # APVTS subscription hooks
│  ├─ public-web/                                # web-demo-only: sample.mp3, wasm, worklet
│  │  ├─ audio/sample.mp3
│  │  ├─ wasm/tinyvu_dsp.wasm
│  │  └─ worklet/dsp-processor.js
│  ├─ vite.config.ts          # plugin build (outputs ../plugin/ui/public)
│  ├─ vite.config.web.ts      # web demo build (outputs dist/)
│  ├─ index.html              # plugin entry
│  ├─ index.web.html          # web demo entry
│  ├─ firebase.json
│  ├─ .firebaserc             # project: tinyvu-demo
│  ├─ scripts/sync-web-demos.cjs
│  └─ package.json
├─ wasm/
│  ├─ src/vu_meter.h          # JUCE-free port of plugin VuMeter
│  ├─ src/wasm_exports.cpp    # C ABI exports
│  └─ CMakeLists.txt          # emscripten build config
├─ cmake/
├─ scripts/
├─ JUCE/                      # git submodule
├─ aax-sdk/                   # optional (AAX SDK)
├─ installer.iss              # Inno Setup script (Windows installer)
├─ build_windows.ps1
├─ build_macos.zsh
├─ VERSION
└─ LICENSE
```

## License

Plugin source is released under the terms in `LICENSE`. Third-party SDKs (JUCE / VST3 / AAX / WebView2 / etc.) are governed by their own licenses; the runtime dependencies are listed in the in-app Licenses dialog. The VU dial SVG and ballistics curve are ported from [vu-meter-react](https://github.com/jun-murakami/vu-meter-react) (same author, MIT licensed).

## Credits

Designed and developed by **Jun Murakami**. Built on the ZeroComp framework and the vu-meter-react component (same author).
