必ず日本語で回答すること。

## TinyVU 開発用 ルール（AGENTS）

この文書は JUCE + WebView（Vite/React/MUI）構成で「シンプルかつ極小サイズ表示にも耐える VU メーター」を実装するための合意ルールです。開発時の意思決定や PR レビューの基準として用います。
ベースは ZeroComp / TestTone の構成をそのまま継承しているため、ビルド設定・テーマ・コンポーネント基盤・スクリプトの構造はシリーズの他プラグインとほぼ同じです。

### 目的とスコープ

- **目的**: 古典的な VU メーター（Bell Labs / IEC 60268-17 系）のシンプルな実装。放送 / 配信 / ミックス時の体感ラウドネスのリファレンスに使う。
  - 音響経路は完全パススルー（音は変えない）。
  - フルレスポンシブ。プラグインウィンドウを縦横自由にリサイズでき、極小サイズでも針が見える。
  - モノラルバスでは 1 つだけ、ステレオバスでは L / R 並列で 2 つ表示する。
- **対象フォーマット**: VST3 / AU / AAX / Standalone（Windows / macOS）+ VST3 / LV2 / CLAP / Standalone（Linux）
- **設定項目（最小限）**:
  - Reference Level: 0VU として扱う dBFS 基準。`-9 / -12 / -14 / -16 / -18 / -20 / -22 / -24` dBFS の choice、既定 -18 dBFS。
  - Theme: `Dark` / `Light`。既定 Dark。

### アーキテクチャ

- **C++/JUCE**:
  - `PluginProcessor` (`TinyVUAudioProcessor`) が APVTS を保持し、`processBlock` で各チャンネルの `tv::dsp::VuMeter` に samples を流す。
  - `tv::dsp::VuMeter` はチャンネル独立のスライディング RMS 検出器（既定 50ms 窓）。
    リングバッファ + インクリメンタル更新で `getLatestDbFS()` を atomic に公開する。
  - `processBlock` は **buffer を一切書き換えず**、ただ監視する（メータープラグインなので）。
  - 30Hz の `juce::Timer`（`PluginEditor`）が L/R の最新 dBFS を WebView に push する。
- **WebUI**:
  - `components/VUMeter.tsx` が vu-meter-react のロジックを移植したコンポーネント。
    - Web Audio API ではなく、JUCE 側から push される dBFS（Latest Ref パターン）を入力にする。
    - 親要素のサイズに応じて 1 メーター / 2 メーター並列を切替えつつ、アスペクト比（217:190）を維持する。
    - VU 弾道（300ms attack/release）と +VU 警告ゾーン、ピークランプは vu-meter-react と同じ実装。
  - `App.tsx` がレイアウト責務を持つ:
    - ルート要素を `ResizeObserver` で監視し、極小サイズではタイトル行や Reference / Theme のコントロール行を自動的に隠す。
    - `meterUpdate` / `channelLayoutChanged` イベントを購読し、mono / stereo 表示を切替える。

### オーディオスレッド原則

- `processBlock` 内でのメモリ確保・ロック・ファイル I/O は禁止。
- メーター値は `std::atomic<float>` で audio → UI に受け渡し（`processBlock` 末尾で 1 回 store）。
- パラメータの読み取りは `getRawParameterValue(...)->load()` を使用し、`AudioProcessorValueTreeState::Listener` は使わない（UI スレッドからのコールバック発生を避ける）。

### UI/UX 原則

- ダークテーマ既定。MUI v7、`@fontsource/jost` をデフォルトフォントに使用。
- フルレスポンシブ。プラグインウィンドウは `(min, init, max) = (110×80, 300×220, 1200×800)`。
- モノラル時は単独メーター、ステレオ時は L/R 並列メーター。バスレイアウトは `channelLayoutChanged` で動的に検知。
- 極小サイズ時の段階的な情報削減:
  - `compact` (host 高さ < 160 / 幅 < 200): "by Jun Murakami" の表記を隠す。
  - `ultraCompact` (host 高さ < 120 / 幅 < 150): タイトル行ごと隠してメーター本体だけ表示。
  - メーター内部も縦が 110px 未満になるとチャンネルラベルと "0VU = X dBFS" を非表示にする。
- 数値入力欄には必要に応じて `block-host-shortcuts` クラスを付与（DAW へのキーイベント転送を抑制）。

### ブリッジ / メッセージ設計

- JS → C++（コマンド系、`callNative` 経由）:
  - `system_action("ready")` — 初期化完了通知
  - `system_action("forward_key_event", payload)` — キー転送
  - `open_url(url)` — 外部 URL の起動
  - `window_action("resizeTo", w, h)` — Standalone 用リサイズ（プラグインホスト下では基本無視）
- C++ → JS（イベント系、30Hz スロットル）:
  - `meterUpdate`: `{ left: <dBFS>, right?: <dBFS>, numChannels: <int> }`
  - `channelLayoutChanged`: `{ numChannels: <int> }`
  - `dpiScaleChanged`: `{ scale, dpi }`（Windows のみ）

### パラメータ一覧（APVTS）

- `REFERENCE_LEVEL`: choice [`-9 dBFS`, `-12 dBFS`, `-14 dBFS`, `-16 dBFS`, `-18 dBFS`, `-20 dBFS`, `-22 dBFS`, `-24 dBFS`]、既定 `-18 dBFS`（index 4）。
- `THEME`: choice [`Dark`, `Light`]、既定 `Dark`（index 0）。

### React 設計方針

- 外部ストア購読は `useSyncExternalStore`（`hooks/useJuceParam.ts`）。tearing-free で StrictMode 安全。
- メーター値のような高頻度更新は React state ではなく `ref` に書き込み、`requestAnimationFrame` 内で `getDbFS()` を呼ぶ Latest Ref パターンに統一する。
- `useEffect` は最小限。

### コーディング規約（C++）

- 明示的な型、早期 return、2 段以上の深いネスト回避。
- 例外は原則不使用。戻り値でエラー伝搬。
- コメントは「なぜ」を中心に要点のみ。
- 新規 DSP クラスは `plugin/src/dsp/` 配下、`namespace tv::dsp` で統一。
- 名前空間 `tv`（TinyVU）と `tv::dsp` を共通プレフィクスとして使う。

### コーディング規約（Web）

- TypeScript 必須。`any` 型は禁止。
- ESLint + Prettier。コンポーネントは疎結合・小さく。
- MUI テーマはダーク優先。

### ビルド

- Dev: WebView は `http://127.0.0.1:5173`（Vite dev server）。
- Prod: `webui build` を zip 化 → `juce_add_binary_data` で埋め込み。
- AAX SDK は `aax-sdk/` 配下に配置された場合のみ自動的に有効化。
- Windows 配布ビルド: `powershell -File build_windows.ps1 -Configuration Release`
  - 成果物: `releases/<VERSION>/Windows/...` と `TinyVU_<VERSION>_Windows_Setup.exe`（Inno Setup 6 必須）。
  - AAX 署名は `.env` に PACE 情報がある場合のみ自動実行。
  - WrapGUID は **`.env` の `PACE_ORGANIZATION` に書く**（スクリプト / ドキュメントに生 GUID をハードコードしない）。姉妹リポジトリの `.env` を雛形にして、当該プラグインの GUID に差し替える運用。
- Linux 配布ビルド: `bash build_linux.sh`（WSL2 Ubuntu 24.04 で動作確認）
  - 成果物: `releases/<VERSION>/TinyVU_<VERSION>_Linux_VST3_LV2_CLAP_Standalone.zip`。VST3 / LV2 / CLAP / Standalone を同梱。
  - 自動インストール先: `~/.vst3/TinyVU.vst3`, `~/.lv2/TinyVU.lv2`, `~/.clap/TinyVU.clap`（VST3 / LV2 は JUCE の `COPY_PLUGIN_AFTER_BUILD`、CLAP は `build_linux.sh` 側で明示コピー）。
  - LV2 / CLAP は **Linux ビルドでのみ** 有効化（`if(UNIX AND NOT APPLE)` で条件分岐）。Windows / macOS の既存リリース経路には影響させない。
  - LV2URI: `https://junmurakami.com/plugins/tinyvu`（`plugin/CMakeLists.txt` の `juce_add_plugin` 内）。LV2 規約上 stable な URI 必須なのでバージョンを跨いで変更しない。
  - CLAP: `clap-juce-extensions` を submodule として取り込み、`clap_juce_extensions_plugin(... CLAP_ID "com.junmurakami.tinyvu" CLAP_FEATURES analyzer)` を呼ぶ。
  - 必要 apt パッケージ: `build-essential pkg-config cmake ninja-build git libasound2-dev libjack-jackd2-dev libcurl4-openssl-dev libfreetype-dev libfontconfig1-dev libx11-dev libxcomposite-dev libxcursor-dev libxext-dev libxinerama-dev libxrandr-dev libxrender-dev libwebkit2gtk-4.1-dev libglu1-mesa-dev mesa-common-dev libgtk-3-dev`。
  - WSL2 上で GUI 検証するときは Carla / Bitwig を `pw-jack` 経由で起動する（PipeWire の libjack を使わせる）。WSLg PulseAudio へは PipeWire の `module-pulse-tunnel` で sink を作る。

### AAX 署名用 PFX（Windows）

`<plugin>-dev.pfx` をリポジトリ直下に配置する（`build_windows.ps1` が最初に見るパス）。`.env` の
`PACE_KEYPASSWORD=dev-pass-123` と必ずパスワードを揃える（既存 Zero シリーズ統一値）。

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

#### ⚠ 落とし穴: PFX は **必ず** 旧形式 (PBE-SHA1-3DES + SHA1 MAC) に詰め直す

Windows 11 の `Export-PfxCertificate` は **PBES2 / AES-256** で PKCS#12 を書き出すが、PACE wraptool
内部の OS コード署名 API（`ossignaturewin.cpp`）はこの新形式から鍵を取り出せず、

```
Key file ... doesn't contain a valid signing certificate.
```

で落ちる（症状: PowerShell の `Get-PfxCertificate` や Windows 純正 `signtool` は同 PFX で問題なく
動くのに PACE だけ落ちる、というのが特徴）。エクスポート直後に **OpenSSL で旧形式に変換**:

```powershell
$env:OPENSSL_MODULES = 'C:\Program Files\Git\mingw64\lib\ossl-modules'
$ossl = 'C:\Program Files\Git\mingw64\bin\openssl.exe'
$tmp = "$env:TEMP\dev.pem"

& $ossl pkcs12 -in tinyvu-dev.pfx -nodes -passin 'pass:dev-pass-123' -out $tmp
& $ossl pkcs12 -export -in $tmp -out tinyvu-dev.pfx -passout 'pass:dev-pass-123' `
    -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg SHA1 -legacy
Remove-Item $tmp
```

`-legacy` には `OPENSSL_MODULES` で `legacy.dll` のあるディレクトリを指す必要あり。
`C:\Program Files\OpenSSL-Win64\` 同梱の openssl だと `legacy.dll` の探索パスが壊れている
ことがあるので、Git for Windows 同梱の openssl を使うのが安全。署名後に出る
`Warning! ... doesn't have a trusted root in the system.` は自己署名 dev cert なので想定通り、無視可。

### Web デモ

ZeroComp と異なり、TinyVU のリポジトリには現状 Web デモ（WASM / Vite Web 設定 / Firebase）を含めていない。
将来 Web デモを作る場合は ZeroComp の `wasm/`, `webui/vite.config.web.ts`, `webui/index.web.html`, `webui/.firebaserc`, `webui/firebase.json`, `webui/scripts/sync-web-demos.cjs`, `webui/public-web/` を参考にする。

### バージョン管理

- `VERSION` ファイルで一元管理。CMake と `build_windows.ps1` がここから読む。
- `webui/package.json` の `version` も手動で同期する。
- コミットは**ユーザが明示的に指示しない限り行わない**。

### デフォルト挙動メモ

- 新規インスタンス時は Reference Level = -18 dBFS（index 4）、Theme = Dark で立ち上がる。
- モノラルバスが見えた瞬間に L 単独メーター（"MONO" ラベル）に切替わる。ステレオに戻ると L/R 並列に戻る。
- メーター値は audio スレッドの 50ms 窓 RMS → 30Hz で UI に push → UI 側で 300ms VU 弾道を適用、という二段の平滑化を経る。
