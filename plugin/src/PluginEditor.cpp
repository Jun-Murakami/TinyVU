// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jun Murakami
#include "PluginEditor.h"
#include "PluginProcessor.h"
#include "ParameterIDs.h"
#include "Version.h"
#include "KeyEventForwarder.h"

#include <unordered_map>
#include <cmath>

#if defined(JUCE_WINDOWS)
 #include <windows.h>
#endif

#if __has_include(<WebViewFiles.h>)
#include <WebViewFiles.h>
#endif

#ifndef LOCAL_DEV_SERVER_ADDRESS
#define LOCAL_DEV_SERVER_ADDRESS "http://127.0.0.1:5173"
#endif

namespace {

[[maybe_unused]] std::vector<std::byte> streamToVector(juce::InputStream& stream)
{
    const auto sizeInBytes = static_cast<size_t>(stream.getTotalLength());
    std::vector<std::byte> result(sizeInBytes);
    stream.setPosition(0);
    [[maybe_unused]] const auto bytesRead = stream.read(result.data(), result.size());
    jassert(static_cast<size_t>(bytesRead) == sizeInBytes);
    return result;
}

#if !TINYVU_DEV_MODE && __has_include(<WebViewFiles.h>)
static const char* getMimeForExtension(const juce::String& extension)
{
    static const std::unordered_map<juce::String, const char*> mimeMap = {
        {{"htm"},   "text/html"},
        {{"html"},  "text/html"},
        {{"txt"},   "text/plain"},
        {{"jpg"},   "image/jpeg"},
        {{"jpeg"},  "image/jpeg"},
        {{"svg"},   "image/svg+xml"},
        {{"ico"},   "image/vnd.microsoft.icon"},
        {{"json"},  "application/json"},
        {{"png"},   "image/png"},
        {{"css"},   "text/css"},
        {{"map"},   "application/json"},
        {{"js"},    "text/javascript"},
        {{"woff2"}, "font/woff2"}};

    if (const auto it = mimeMap.find(extension.toLowerCase()); it != mimeMap.end())
        return it->second;

    jassertfalse;
    return "";
}

#ifndef ZIPPED_FILES_PREFIX
#error "You must provide the prefix of zipped web UI files' paths via ZIPPED_FILES_PREFIX compile definition"
#endif

std::vector<std::byte> getWebViewFileAsBytes(const juce::String& filepath)
{
    juce::MemoryInputStream zipStream{ webview_files::webview_files_zip,
                                       webview_files::webview_files_zipSize,
                                       false };
    juce::ZipFile zipFile{ zipStream };

    const auto fullPath = ZIPPED_FILES_PREFIX + filepath;
    if (auto* zipEntry = zipFile.getEntry(fullPath))
    {
        const std::unique_ptr<juce::InputStream> entryStream{ zipFile.createStreamForEntry(*zipEntry) };
        if (entryStream == nullptr) { jassertfalse; return {}; }
        return streamToVector(*entryStream);
    }
    return {};
}
#else
[[maybe_unused]] static std::vector<std::byte> getWebViewFileAsBytes(const juce::String& filepath)
{
    juce::ignoreUnused(filepath);
    return {};
}
#endif

#if defined(JUCE_WINDOWS)
// HWND 基準の DPI をスケール係数へ変換。Per-Monitor V2 対応。
static void queryWindowDpi(HWND hwnd, int& outDpi, double& outScale)
{
    outDpi = 0;
    outScale = 1.0;
    if (hwnd == nullptr) return;

    HMODULE user32 = ::GetModuleHandleW(L"user32.dll");
    if (user32 != nullptr)
    {
        using GetDpiForWindowFn = UINT (WINAPI*)(HWND);
        auto pGetDpiForWindow = reinterpret_cast<GetDpiForWindowFn>(::GetProcAddress(user32, "GetDpiForWindow"));
        if (pGetDpiForWindow != nullptr)
        {
            const UINT dpi = pGetDpiForWindow(hwnd);
            if (dpi != 0)
            {
                outDpi = static_cast<int>(dpi);
                outScale = static_cast<double>(dpi) / 96.0;
                return;
            }
        }
    }

    HMODULE shcore = ::LoadLibraryW(L"Shcore.dll");
    if (shcore != nullptr)
    {
        using GetDpiForMonitorFn = HRESULT (WINAPI*)(HMONITOR, int, UINT*, UINT*);
        auto pGetDpiForMonitor = reinterpret_cast<GetDpiForMonitorFn>(::GetProcAddress(shcore, "GetDpiForMonitor"));
        if (pGetDpiForMonitor != nullptr)
        {
            HMONITOR mon = ::MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            UINT dpiX = 0, dpiY = 0;
            if (SUCCEEDED(pGetDpiForMonitor(mon, 0 /*MDT_EFFECTIVE_DPI*/, &dpiX, &dpiY)))
            {
                outDpi = static_cast<int>(dpiX);
                outScale = static_cast<double>(dpiX) / 96.0;
            }
        }
        ::FreeLibrary(shcore);
    }
}
#endif

} // namespace

// WebView2/Chromium の起動前に追加のコマンドライン引数を渡すためのヘルパー。
//  ProTools(AAX, Windows) は AAX ラッパー時に DPI 非対応モードで動作することが多く、
//  WebView2 の自動スケーリングがかかると UI が本来の意図より大きく表示されるため
//  --force-device-scale-factor=1 を環境変数経由で注入する。
static juce::WebBrowserComponent::Options makeWebViewOptionsWithPreLaunchArgs(const juce::AudioProcessor& /*processor*/)
{
   #if defined(JUCE_WINDOWS)
    if (juce::PluginHostType().isProTools()
        && juce::PluginHostType::getPluginLoadedAs() == juce::AudioProcessor::WrapperType::wrapperType_AAX)
    {
        const char* kEnvName = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
        const char* kArg     = "--force-device-scale-factor=1";

        char*  existing = nullptr;
        size_t len = 0;
        if (_dupenv_s(&existing, &len, kEnvName) == 0 && existing != nullptr)
        {
            std::string combined(existing);
            free(existing);
            if (combined.find("--force-device-scale-factor") == std::string::npos)
            {
                if (! combined.empty()) combined += ' ';
                combined += kArg;
                _putenv_s(kEnvName, combined.c_str());
            }
        }
        else
        {
            _putenv_s(kEnvName, kArg);
        }
    }
   #endif
    return juce::WebBrowserComponent::Options{};
}

//==============================================================================

TinyVUAudioProcessorEditor::TinyVUAudioProcessorEditor(TinyVUAudioProcessor& p)
    : AudioProcessorEditor(&p),
      audioProcessor(p),
      webRefLevelRelay { tv::id::REFERENCE_LEVEL.getParamID() },
      webThemeRelay    { tv::id::THEME.getParamID() },
      refLevelAttachment { *p.getState().getParameter(tv::id::REFERENCE_LEVEL.getParamID()), webRefLevelRelay, nullptr },
      themeAttachment    { *p.getState().getParameter(tv::id::THEME.getParamID()),           webThemeRelay,    nullptr },
      webView{
          makeWebViewOptionsWithPreLaunchArgs(p)
              .withBackend(juce::WebBrowserComponent::Options::Backend::webview2)
              .withWinWebView2Options(
                  juce::WebBrowserComponent::Options::WinWebView2{}
                      .withBackgroundColour(juce::Colour(0xFF606F77))
                      .withUserDataFolder(juce::File::getSpecialLocation(
                          juce::File::SpecialLocationType::tempDirectory)))
              .withWebViewLifetimeListener(&webViewLifetimeGuard)
              .withNativeIntegrationEnabled()
              .withInitialisationData("vendor", "TinyVU")
              .withInitialisationData("pluginName", "TinyVU")
              .withInitialisationData("pluginVersion", TINYVU_VERSION_STRING)
              .withOptionsFrom(controlParameterIndexReceiver)
              .withOptionsFrom(webRefLevelRelay)
              .withOptionsFrom(webThemeRelay)
              .withNativeFunction(
                  juce::Identifier{"system_action"},
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion completion)
                  { handleSystemAction(args, std::move(completion)); })
              .withNativeFunction(
                  juce::Identifier{"window_action"},
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion completion)
                  {
                      const auto action = args.size() >= 1 ? args[0].toString() : juce::String();

                      // ドラッグ開始時に CSS px → 論理 px の換算比率を 1 回だけ確定する（MixCompare 方式）。
                      //  ratio = getWidth()/innerWidth ≒ devicePixelRatio/ホスト総スケール。これが無いと
                      //  分数スケーリング環境でハンドル(CSS px)とウィンドウ(論理px)がズレる。
                      if (action == "resizeBegin" && args.size() >= 3)
                      {
                          const double cssW = static_cast<double>(args[1]);
                          const double cssH = static_cast<double>(args[2]);
                          webResizeRatioW = (cssW > 0.0) ? static_cast<double>(getWidth())  / cssW : 1.0;
                          webResizeRatioH = (cssH > 0.0) ? static_cast<double>(getHeight()) / cssH : 1.0;
                          completion(juce::var{ true });
                          return;
                      }

                      // WebUI 読込完了時に呼ばれる。innerWidth/innerHeight(CSS px) から ratio を確定し、
                      //  初回だけ初期ウィンドウを「設計/保存 CSS px × ratio」に合わせる（MixCompare 方式）。
                      //  これが無いと分数スケーリング環境で初期サイズが設計より小さく見える。
                      if (action == "apply_layout" && args.size() >= 3)
                      {
                          const double cssW = static_cast<double>(args[1]);
                          const double cssH = static_cast<double>(args[2]);
                          webResizeRatioW = (cssW > 0.0) ? static_cast<double>(getWidth())  / cssW : 1.0;
                          webResizeRatioH = (cssH > 0.0) ? static_cast<double>(getHeight()) / cssH : 1.0;
                        #if JUCE_LINUX || JUCE_BSD
                          // constrainer の min/max も ratio 換算で論理 px に合わせる。VST3 は onSize→
                          //  setBoundsConstrained で constrainer を適用するため、論理 px のままの min/max だと
                          //  ハンドルリサイズの下限/上限が CSS 設計値とズレる（min が大きすぎると中身がはみ出す）。
                          resizerConstraints.setSizeLimits(juce::roundToInt(kMinWidth  * webResizeRatioW),
                                                           juce::roundToInt(kMinHeight * webResizeRatioH),
                                                           juce::roundToInt(kMaxWidth  * webResizeRatioW),
                                                           juce::roundToInt(kMaxHeight * webResizeRatioH));
                          // Linux のみ初期サイズを ratio 換算で確定（Windows/macOS は ratio≒1 かつ
                          //  WebView2/WKWebView が DPI を処理するため従来の ctor サイズに任せる）。
                          //  ※ 保存サイズ(論理 px)から復元した場合は上書きしない。保存値は既に論理 px で
                          //    正しいので、ここで × ratio すると二重適用になり巨大化する。初回(fresh)のみ。
                          if (!initialLayoutApplied)
                          {
                              initialLayoutApplied = true;
                              if (!restoredFromSavedSize)
                                  setSize(juce::roundToInt(designTargetW * webResizeRatioW),
                                          juce::roundToInt(designTargetH * webResizeRatioH));
                          }
                        #endif
                          completion(juce::var{ true });
                          return;
                      }

                      if (action == "resizeTo" && args.size() >= 3)
                      {
                          // args は CSS px。先に CSS(設計)空間でクランプし、固定比率を掛けて論理 px へ。
                          //  同期的にリサイズしてから completion を返すことで WebUI のバックプレッシャが機能する。
                          //  Linux ではさらにホストの echo 待ち＋落ち着き後の再同期で齟齬を収束（applyWindowResize 内）。
                          const double cssW = juce::jlimit<double>(kMinWidth,  kMaxWidth,  static_cast<double>(args[1]));
                          const double cssH = juce::jlimit<double>(kMinHeight, kMaxHeight, static_cast<double>(args[2]));
                          applyWindowResize(juce::roundToInt(cssW * webResizeRatioW),
                                            juce::roundToInt(cssH * webResizeRatioH),
                                            std::move(completion));
                          return;
                      }
                      completion(juce::var{ false });
                  })
              .withNativeFunction(
                  juce::Identifier{"open_url"},
                  [](const juce::Array<juce::var>& args,
                     juce::WebBrowserComponent::NativeFunctionCompletion completion)
                  {
                      if (args.size() > 0)
                      {
                          const auto url = args[0].toString();
                          juce::URL(url).launchInDefaultBrowser();
                      }
                      completion(juce::var{ true });
                  })
              .withResourceProvider([this](const juce::String& url) { return getResource(url); })
      }
{
   #if TINYVU_DEV_MODE
    useLocalDevServer = true;
   #else
    useLocalDevServer = false;
   #endif

    addAndMakeVisible(webView);

    // フルレスポンシブ。OS ウィンドウ枠 / 自前コーナーグリップ / WebUI オーバーレイで
    //  すべて同じ最小・最大サイズを共有する（window_action 側のクランプもこの定数を参照）。
#if JUCE_LINUX || JUCE_BSD
    // Linux: Bitwig 等はホスト枠ドラッグをプラグインへ転送せず、枠を広げても黒余白が増えるだけ
    //  なので「ユーザーによる枠リサイズは不可」とホストへ申告する（canResize/guiCanResize=false）。
    //  リサイズは自前 WebUI ハンドル経由のみ。サイズ制限は独自 constrainer で管理（下記参照）。
    //  ※ setResizable(false) は setConstrainer の「後」で呼ぶ必要がある（setConstrainer が
    //    constrainer の min≠max を見て resizableByHost=true に戻すため）。下の setConstrainer 直後で確定する。
#else
    setResizable(true, true);
#endif

    // Cubase 等は VST3 プラグインウィンドウの「独自最小高さ」（実測 ~105px）に縮めた
    //  サイズを保存・復元するため、ホスト保存値を信用せず APVTS state に独自保存した
    //  サイズで強制復元する。これは TinyVU が他シリーズより遥かに小さい（最小 265×90）
    //  ことに起因する固有のワークアラウンド。
    const auto apvtsState = audioProcessor.getState().state;
    // 保存サイズ(論理 px)があれば同一ディスプレイで正しいのでそのまま復元する。無ければ設計値。
    restoredFromSavedSize = apvtsState.hasProperty("editorWidth") && apvtsState.hasProperty("editorHeight");
    const int savedW = static_cast<int>(apvtsState.getProperty("editorWidth",  kInitialWidth));
    const int savedH = static_cast<int>(apvtsState.getProperty("editorHeight", kInitialHeight));
    const int restoreW = juce::jlimit(kMinWidth,  kMaxWidth,  savedW);
    const int restoreH = juce::jlimit(kMinHeight, kMaxHeight, savedH);

    // designTarget は設計 CSS px。保存値が無い初回のみ apply_layout で × ratio して使う。
    designTargetW = kInitialWidth;
    designTargetH = kInitialHeight;
    setSize(restoreW, restoreH);
    resizerConstraints.setSizeLimits(kMinWidth, kMinHeight, kMaxWidth, kMaxHeight);
#if JUCE_LINUX || JUCE_BSD
    // setResizeLimits は min≠max で resizableByHost を true に戻すため使わず、独自 constrainer を設定。
    setConstrainer(&resizerConstraints);
    // ★ setConstrainer は constrainer の min≠max を見て resizableByHost=true に戻すので、
    //   枠リサイズ無効化(false)は必ず setConstrainer の「後」で確定する（MixCompare と同じ順序）。
    setResizable(false, false);
#else
    setResizeLimits(kMinWidth, kMinHeight, kMaxWidth, kMaxHeight);
#endif

    // コーナーグリップ。WebView より前面に置いて確実にドラッグできるようにする。
    resizer.reset(new juce::ResizableCornerComponent(this, &resizerConstraints));
    addAndMakeVisible(resizer.get());
    resizer->setAlwaysOnTop(true);

    if (auto* hostConstrainer = getConstrainer())
    {
        hostConstrainer->setSizeLimits(kMinWidth, kMinHeight, kMaxWidth, kMaxHeight);
        hostConstrainer->setMinimumOnscreenAmounts(50, 50, 50, 50);
    }

    if (useLocalDevServer)
        webView.goToURL(LOCAL_DEV_SERVER_ADDRESS);
    else
        webView.goToURL(juce::WebBrowserComponent::getResourceProviderRoot());

    // ホスト（特に Cubase）はコンストラクタ中の setSize を上書きし、独自に持っている
    //  プラグインウィンドウ最小高さ（~105px）に丸めた値で resized() を呼ぶことがある。
    //  次のメッセージループで APVTS 保存サイズへ強制復帰させる。
    juce::Component::SafePointer<TinyVUAudioProcessorEditor> safeSelf { this };
    juce::MessageManager::callAsync([safeSelf, restoreW, restoreH]()
    {
        if (safeSelf == nullptr) return;
        if (safeSelf->getWidth() != restoreW || safeSelf->getHeight() != restoreH)
            safeSelf->setSize(restoreW, restoreH);
    });

    // 120Hz で メーター値を WebView に push する（VU 弾道は WebView 側で計算）。
    //  WebView の rAF が 60Hz でも、120Hz push なら直近のフレームで読まれる atomic 値が
    //  最大 ~8ms 古い状態になり、60Hz push（最大 ~16.7ms 古い）より追従感が良い。
    //  チャンネル構成変化と DPI 変化のポーリングもここで行う。
    startTimerHz(120);
}

TinyVUAudioProcessorEditor::~TinyVUAudioProcessorEditor()
{
    isShuttingDown.store(true, std::memory_order_release);
    stopTimer();

#if JUCE_LINUX || JUCE_BSD
    // 保留中のリサイズ ack completion は呼ばずに破棄（破棄中の WebView へのコールバックを避ける）。
    resizeAckPending = false;
    pendingResizeCompletion = {};
#endif

    // WebView を明示的に teardown してから破棄する。これをしないと Linux + NVIDIA で
    //  Standalone 終了時に WebKit/EGL のクリーンアップ順序が崩れ、libEGL_nvidia の atexit で
    //  SEGV する（MixCompare はこの手順があるためクラッシュしない）。about:blank へ遷移して
    //  ページと GPU リソースを解放 → stop → 非表示 → 親から切り離し、の順。
    if (webViewLifetimeGuard.isConstructed())
    {
        webView.goToURL("about:blank");
        webView.stop();
        webView.setVisible(false);
    }
    removeChildComponent(&webView);
}

void TinyVUAudioProcessorEditor::paint(juce::Graphics& g)
{
    g.fillAll(juce::Colour(0xFF606F77));
}

void TinyVUAudioProcessorEditor::resized()
{
    webView.setBounds(getLocalBounds());
    if (resizer)
    {
        const int gripperSize = 24;
        resizer->setBounds(getWidth() - gripperSize, getHeight() - gripperSize, gripperSize, gripperSize);
        resizer->toFront(true);
    }

    // 編集サイズを APVTS state に保存しておき、次回オープン時にホスト保存値ではなく
    //  この値で復元する（Cubase の最小高さ丸め回避）。property は parameter ID と
    //  衝突しない名前なので APVTS の listener には影響しない。
    //  保存は論理 px。同一ディスプレイで開き直す限りこの値で正しく復元できる（apply_layout は
    //  保存値がある場合は上書きしないので二重 ratio にならない）。
    auto state = audioProcessor.getState().state;
    state.setProperty("editorWidth",  getWidth(),  nullptr);
    state.setProperty("editorHeight", getHeight(), nullptr);

#if JUCE_LINUX || JUCE_BSD
    // ホスト主導の resized()（= guiSetSize/onSize の echo）が着地したら保留 resizeTo を確定。
    //  自分の setSize 起因（resizeSelfDriven）はホスト確定ではないので無視する。
    if (resizeAckPending && !resizeSelfDriven)
        resolveResizeAck();
#endif
}

void TinyVUAudioProcessorEditor::resolveResizeAck()
{
    if (!resizeAckPending)
        return;
    resizeAckPending = false;
    auto completion = std::move(pendingResizeCompletion);
    pendingResizeCompletion = {};
    if (completion)
        completion(juce::var{ true });
}

void TinyVUAudioProcessorEditor::applyWindowResize(
    int targetW, int targetH, juce::WebBrowserComponent::NativeFunctionCompletion completion)
{
#if JUCE_LINUX || JUCE_BSD
    // Linux 限定の「真のバックプレッシャ」: completion を即返さず、ホストが実際にリサイズし終える
    //  （resized() が再発火する）まで保留する。JS は往復1件ずつ送るようになり、高頻度送信で
    //  ホストがリクエストを取りこぼす齟齬（黒残り/見切れ）を防ぐ。
    resolveResizeAck();  // 以前の保留が残っていれば先に解決（安全策）
    lastResizeActivityMs = juce::Time::getMillisecondCounter();
    settleReconcileDone = false;

    if (getWidth() != targetW || getHeight() != targetH)
    {
        pendingResizeCompletion = std::move(completion);
        resizeAckPending = true;
        resizeAckStartMs = juce::Time::getMillisecondCounter();
        const juce::ScopedValueSetter<bool> selfDriven(resizeSelfDriven, true);
        setSize(targetW, targetH);
        // ホストが echo を返さない場合は timerCallback の安全タイムアウトで確定。
    }
    else
    {
        completion(juce::var{ true });  // サイズ不変なら往復不要
    }
#else
    // Windows / macOS: 従来どおり即時 setSize + 即完了。
    setSize(targetW, targetH);
    completion(juce::var{ true });
#endif
}

std::optional<TinyVUAudioProcessorEditor::Resource>
TinyVUAudioProcessorEditor::getResource(const juce::String& url) const
{
   #if TINYVU_DEV_MODE
    juce::ignoreUnused(url);
    return std::nullopt;
   #else
    #if __has_include(<WebViewFiles.h>)
    const auto cleaned = url.startsWith("/") ? url.substring(1) : url;
    const auto resourcePath = cleaned.isEmpty() ? juce::String("index.html") : cleaned;
    const auto bytes = getWebViewFileAsBytes(resourcePath);
    if (bytes.empty())
        return std::nullopt;

    const auto extension = resourcePath.fromLastOccurrenceOf(".", false, false);
    return Resource{ std::move(bytes), juce::String(getMimeForExtension(extension)) };
    #else
    juce::ignoreUnused(url);
    return std::nullopt;
    #endif
   #endif
}

void TinyVUAudioProcessorEditor::handleSystemAction(const juce::Array<juce::var>& args,
                                                     juce::WebBrowserComponent::NativeFunctionCompletion completion)
{
    if (args.size() > 0)
    {
        const auto action = args[0].toString();
        if (action == "ready")
        {
            juce::DynamicObject::Ptr init{ new juce::DynamicObject{} };
            init->setProperty("pluginName", "TinyVU");
            init->setProperty("version", TINYVU_VERSION_STRING);
            completion(juce::var{ init.get() });
            return;
        }
        if (action == "forward_key_event" && args.size() >= 2)
        {
            const bool forwarded = tv::KeyEventForwarder::forwardKeyEventToHost(args[1], this);
            completion(juce::var{ forwarded });
            return;
        }
    }
    completion(juce::var{});
}

#if defined(JUCE_WINDOWS)
void TinyVUAudioProcessorEditor::pollAndMaybeNotifyDpiChange()
{
    auto* peer = getPeer();
    if (peer == nullptr) return;

    HWND hwnd = (HWND) peer->getNativeHandle();
    int dpi = 0;
    double scale = 1.0;
    queryWindowDpi(hwnd, dpi, scale);
    if (dpi <= 0) return;

    const bool scaleChanged = std::abs(lastHwndScaleFactor - scale) >= 0.01;
    const bool dpiChanged   = lastHwndDpi != dpi;
    if (! (scaleChanged || dpiChanged)) return;

    lastHwndScaleFactor = scale;
    lastHwndDpi = dpi;

    juce::DynamicObject::Ptr payload{ new juce::DynamicObject{} };
    payload->setProperty("scale", scale);
    payload->setProperty("dpi", dpi);
    webView.emitEventIfBrowserIsVisible("dpiScaleChanged", payload.get());

    const int w = getWidth();
    const int h = getHeight();
    setSize(w + 1, h + 1);
    setSize(w, h);
}
#endif

void TinyVUAudioProcessorEditor::pollAndEmitChannelLayout()
{
    // ホスト由来のバス構成（mono=1 / stereo=2）を WebView に通知する。
    //  ホストはランタイムにバス構成を切替えることがある（Pro Tools の trackChannelChange 等）ため、
    //  単発ではなく毎フレームでポーリングして変化時にだけ emit する。
    const int n = audioProcessor.getMainBusNumOutputChannels();
    if (n == lastEmittedNumOutputChannels) return;
    lastEmittedNumOutputChannels = n;

    juce::DynamicObject::Ptr payload{ new juce::DynamicObject{} };
    payload->setProperty("numChannels", n);
    webView.emitEventIfBrowserIsVisible("channelLayoutChanged", payload.get());
}

void TinyVUAudioProcessorEditor::pushMeterUpdate()
{
    // L/R の最新 RMS dBFS を WebView に渡す。VU の 300ms 弾道とゲージマッピングは
    //  WebView 側で計算する（vu-meter-react のロジックを移植）。
    //  numChannels が 1 の場合は L のみ送る（WebView 側で mono 表示にする）。
    const int n = audioProcessor.getActiveOutputChannels();
    juce::DynamicObject::Ptr payload { new juce::DynamicObject{} };
    payload->setProperty("left",  audioProcessor.getLatestDbFS(0));
    if (n >= 2)
        payload->setProperty("right", audioProcessor.getLatestDbFS(1));
    payload->setProperty("numChannels", n);
    webView.emitEventIfBrowserIsVisible("meterUpdate", payload.get());
}

void TinyVUAudioProcessorEditor::timerCallback()
{
#if JUCE_LINUX || JUCE_BSD
    // リサイズ ack の安全タイムアウト: ホストが echo を返さない場合でも保留 completion を必ず
    //  解決し、JS のバックプレッシャがフリーズしないようにする（~45ms = 最低 ~22fps を保証）。
    if (resizeAckPending
        && (juce::Time::getMillisecondCounter() - resizeAckStartMs) > 45)
        resolveResizeAck();
#endif

    if (isShuttingDown.load(std::memory_order_acquire)) return;
    if (! webViewLifetimeGuard.isConstructed()) return;

#if JUCE_LINUX || JUCE_BSD
    // リサイズ落ち着き後の強制再同期（2 tick に分割した 1px ジグル）。editor が既に最終サイズだと
    //  resized() が発火せず、ホストのコンテナ窓が中間サイズで取り残されても再同期されない。
    //  1px だけ変えて戻すことで guiRequestResize/webView.setBounds を再発火させ収束。2 tick に
    //  分けるのは、同期連続 setBounds が WebKitGTK の描画を固める不具合を避けるため。
    if (resyncStep2Pending)
    {
        resyncStep2Pending = false;
        const juce::ScopedValueSetter<bool> selfDriven(resizeSelfDriven, true);
        setSize(resyncTargetW, resyncTargetH);
    }
    else if (!settleReconcileDone
        && !resizeAckPending
        && isVisible()
        && (juce::Time::getMillisecondCounter() - lastResizeActivityMs) > 120)
    {
        settleReconcileDone = true;
        resyncTargetW = getWidth();
        resyncTargetH = getHeight();
        resyncStep2Pending = true;
        const juce::ScopedValueSetter<bool> selfDriven(resizeSelfDriven, true);
        setSize(resyncTargetW, juce::jmax(1, resyncTargetH - 1));
    }
#endif

   #if defined(JUCE_WINDOWS)
    pollAndMaybeNotifyDpiChange();
   #endif

    pollAndEmitChannelLayout();
    pushMeterUpdate();
}
