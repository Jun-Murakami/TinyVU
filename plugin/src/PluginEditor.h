#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_extra/juce_gui_extra.h>
#include "PluginProcessor.h"
#include <atomic>
#include <memory>
#include <optional>

class TinyVUAudioProcessorEditor : public juce::AudioProcessorEditor,
                                   private juce::Timer
{
public:
    // 初期サイズはステレオ 2 メーターが余裕で並ぶ標準。
    //  最小サイズはステレオ並列でメーター本体だけを残せる 265×90。
    //  最大は実質無制限（任意のモニタ解像度より十分大きい値を入れておく）。
    static constexpr int kInitialWidth  = 600;
    static constexpr int kInitialHeight = 220;
    static constexpr int kMinWidth      = 265;
    static constexpr int kMinHeight     = 90;
    static constexpr int kMaxWidth      = 32767;
    static constexpr int kMaxHeight     = 32767;

    explicit TinyVUAudioProcessorEditor(TinyVUAudioProcessor&);
    ~TinyVUAudioProcessorEditor() override;

    void paint(juce::Graphics&) override;
    void resized() override;

private:
    void timerCallback() override;

    using Resource = juce::WebBrowserComponent::Resource;
    std::optional<Resource> getResource(const juce::String& url) const;

    void handleSystemAction(const juce::Array<juce::var>& args,
                            juce::WebBrowserComponent::NativeFunctionCompletion completion);

    TinyVUAudioProcessor& audioProcessor;

    // APVTS と WebView の双方向バインディング。
    //  REFERENCE_LEVEL は連続値（-24..0 dBFS）、THEME は choice（Dark/Light）。
    juce::WebSliderRelay   webRefLevelRelay;
    juce::WebComboBoxRelay webThemeRelay;

    juce::WebSliderParameterAttachment   refLevelAttachment;
    juce::WebComboBoxParameterAttachment themeAttachment;

    juce::WebControlParameterIndexReceiver controlParameterIndexReceiver;

    struct WebViewLifetimeGuard : public juce::WebViewLifetimeListener
    {
        std::atomic<bool> constructed{ false };
        void webViewConstructed(juce::WebBrowserComponent*) override { constructed.store(true, std::memory_order_release); }
        void webViewDestructed(juce::WebBrowserComponent*) override  { constructed.store(false, std::memory_order_release); }
        bool isConstructed() const { return constructed.load(std::memory_order_acquire); }
    } webViewLifetimeGuard;

    juce::WebBrowserComponent webView;

    // OS ウィンドウ枠 + 自前のコーナーグリップで両対応。
    //  WebView より前面に置き、ユーザがコーナーをドラッグして自由にリサイズできるようにする。
    std::unique_ptr<juce::ResizableCornerComponent> resizer;
    juce::ComponentBoundsConstrainer resizerConstraints;

    bool useLocalDevServer = false;
    std::atomic<bool> isShuttingDown { false };

    // ホストから渡されるバスレイアウト（mono / stereo）を WebView に通知する。
    //  -1 で初期化しておき、最初の有効値で必ず一度 emit する。
    int lastEmittedNumOutputChannels { -1 };
    void pollAndEmitChannelLayout();

    // 30Hz で L/R の最新 dBFS を WebView に push（VU の弾道計算は WebView 側で行う）。
    void pushMeterUpdate();

#if defined(JUCE_WINDOWS)
    double lastHwndScaleFactor { 0.0 };
    int    lastHwndDpi         { 0 };
    void   pollAndMaybeNotifyDpiChange();
#endif

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(TinyVUAudioProcessorEditor)
};
