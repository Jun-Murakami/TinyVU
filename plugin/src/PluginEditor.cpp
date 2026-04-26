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

std::vector<std::byte> streamToVector(juce::InputStream& stream)
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
                      // Standalone のみ "resizeTo" でウィンドウを動的リサイズできる。
                      //  プラグインホスト下では基本ホストが管理するため、無視するのが安全。
                      if (args.size() >= 3 && args[0].toString() == "resizeTo")
                      {
                          const int w = juce::jlimit(kMinWidth,  kMaxWidth,  static_cast<int>(args[1]));
                          const int h = juce::jlimit(kMinHeight, kMaxHeight, static_cast<int>(args[2]));
                          juce::Component::SafePointer<TinyVUAudioProcessorEditor> safeSelf { this };
                          juce::MessageManager::callAsync([safeSelf, w, h]()
                          {
                              if (safeSelf == nullptr) return;
                              safeSelf->setSize(w, h);
                          });
                          completion(juce::var{ true });
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
    setResizable(true, true);

    // Cubase 等は VST3 プラグインウィンドウの「独自最小高さ」（実測 ~105px）に縮めた
    //  サイズを保存・復元するため、ホスト保存値を信用せず APVTS state に独自保存した
    //  サイズで強制復元する。これは TinyVU が他シリーズより遥かに小さい（最小 265×90）
    //  ことに起因する固有のワークアラウンド。
    const auto apvtsState = audioProcessor.getState().state;
    const int savedW = static_cast<int>(apvtsState.getProperty("editorWidth",  kInitialWidth));
    const int savedH = static_cast<int>(apvtsState.getProperty("editorHeight", kInitialHeight));
    const int restoreW = juce::jlimit(kMinWidth,  kMaxWidth,  savedW);
    const int restoreH = juce::jlimit(kMinHeight, kMaxHeight, savedH);

    setSize(restoreW, restoreH);
    setResizeLimits(kMinWidth, kMinHeight, kMaxWidth, kMaxHeight);
    resizerConstraints.setSizeLimits(kMinWidth, kMinHeight, kMaxWidth, kMaxHeight);

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
    auto state = audioProcessor.getState().state;
    state.setProperty("editorWidth",  getWidth(),  nullptr);
    state.setProperty("editorHeight", getHeight(), nullptr);
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
    if (isShuttingDown.load(std::memory_order_acquire)) return;
    if (! webViewLifetimeGuard.isConstructed()) return;

   #if defined(JUCE_WINDOWS)
    pollAndMaybeNotifyDpiChange();
   #endif

    pollAndEmitChannelLayout();
    pushMeterUpdate();
}
