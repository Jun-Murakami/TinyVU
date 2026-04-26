# TinyVU — AGENTS

このリポジトリで作業する AI コーディングエージェント向けの要点サマリです。詳細は [CLAUDE.md](./CLAUDE.md) を参照してください。

## プロジェクト

- JUCE + WebView（Vite/React/MUI）のシンプルな VU メータープラグイン
- ベースは ZeroComp / TestTone（同シリーズ）の構成をそのまま継承（ビルド設定 / テーマ / ライブラリ）
- 音響経路は完全パススルー。設定項目は **Reference Level** と **Theme（Dark/Light）** の 2 つだけ
- 肝はフルレスポンシブ。プラグインウィンドウは縦横自由にリサイズ可能で、極小サイズでも針が見える
- モノラルバスでは 1 メーター、ステレオバスでは L/R 並列の 2 メーター

## ディレクトリ概観

- `plugin/src/` — JUCE プラグイン本体（C++）
  - `PluginProcessor.*` — APVTS と `tv::dsp::VuMeter` のホルダ。`processBlock` は buffer を一切書き換えず監視のみ
  - `PluginEditor.*` — 30Hz の `juce::Timer` で `meterUpdate` イベントを WebView に push。リサイズ可
  - `ParameterIDs.h` — `REFERENCE_LEVEL` (choice) と `THEME` (choice) の 2 つだけ
  - `dsp/VuMeter.*` — チャンネル独立のスライディング RMS 検出器（既定 50ms 窓）
  - `KeyEventForwarder.*` — WebView → DAW ホストのキーイベント転送
- `webui/src/` — Vite + React 19 + MUI v7 フロントエンド
  - `App.tsx` — タイトル行（Reference / Theme 切替）+ メーター本体。`ResizeObserver` で極小サイズ時の段階的非表示を制御
  - `components/VUMeter.tsx` — vu-meter-react ライブラリのロジック移植版（SVG ベース、300ms VU 弾道、+VU 警告ゾーン、ピークランプ）
  - `components/LicenseDialog.tsx`, `components/GlobalDialog.tsx` — ダイアログ基盤
  - `hooks/useJuceParam.ts` — APVTS 購読の React フック（`useSyncExternalStore` ベース）

## 作業するうえでの原則

1. オーディオスレッド上では確保 / ロック / I/O を行わない
2. メーター値は `std::atomic<float>` で audio → UI に受け渡し、UI 側は 30Hz の `juce::Timer` で読み出す
3. メーター値の高頻度購読は React state ではなく `ref` に書き、`requestAnimationFrame` で読む（Latest Ref パターン）
4. パラメータは APVTS に集約、UI との双方向同期は `WebComboBoxRelay` + `WebComboBoxParameterAttachment` で行う
5. TypeScript は `any` 禁止。購読系は `useSyncExternalStore`、`useEffect` は最小限
6. 新規 DSP クラスは `plugin/src/dsp/` に置き、`namespace tv::dsp` に統一、`plugin/CMakeLists.txt` の `target_sources` に登録

## ビルド

- Windows（本番配布）: `powershell -File build_windows.ps1 -Configuration Release` — WebUI ビルド → VST3 / AAX / Standalone コンパイル → AAX 署名（`.env` に PACE 情報あれば）→ ZIP 梱包 → Inno Setup インストーラ生成
- Windows（開発）: `cmake -B build -G "Visual Studio 17 2022" -A x64 && cmake --build build --config Debug --target TinyVU_VST3`
- macOS: `./build_macos.zsh`
- Linux（WSL2 Ubuntu 24.04 で動作確認）: `bash build_linux.sh` — VST3 / LV2 / CLAP / Standalone をビルドし `releases/<VERSION>/TinyVU_<VERSION>_Linux_VST3_LV2_CLAP_Standalone.zip` を生成。LV2 / CLAP は `if(UNIX AND NOT APPLE)` で条件付き有効化されるので Win/Mac リリース経路には影響しない
- WebUI dev: `cd webui && npm install && npm run dev`
- 型チェックのみ: `cd webui && npx tsc --noEmit`

## よく使う拡張ポイント

- 新規 APVTS パラメータ追加: `ParameterIDs.h` に ID 追加 → `createParameterLayout()` で登録 → `PluginEditor` に Web*Relay / Attachment 追加 → `.withOptionsFrom()` に追加 → WebUI 側 hook で購読
- メーター見た目変更: `webui/src/components/VUMeter.tsx` の `darkTheme` / `lightTheme` 定数とスケールマーク / ラベル定義
- メーター応答変更: `processBlock` の `VuMeter::prepare` の `integrationSeconds`（積分時間）と、WebView 側 `VUBallistics` の attack/release（300ms）
- 新規 DAW 互換対応: `KeyEventForwarder.cpp` の `resolveHostWindowForForwarding` / `handleDefaultPostMessage`

## AAX / PACE

- TinyVU 固有の WrapGUID は **`.env` の `PACE_ORGANIZATION` に書く**（生 GUID はスクリプトにもドキュメントにもハードコードしない）。姉妹リポジトリの `.env` を雛形にして本プラグインの GUID に差し替える運用
