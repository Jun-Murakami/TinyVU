// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jun Murakami
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

    // --- Linux 限定のウィンドウ制御（[[linux-dpi-resize-scaling]] と同方針）---
    //  Bitwig 等はホスト枠ドラッグをプラグインへ転送しないため、Linux では枠リサイズを無効化し
    //  （setResizable(false)）、自前ハンドルのみ許可する。高頻度リサイズで取り残された黒残り/
    //  見切れは、ホストの echo 待ち（バックプレッシャ）と落ち着き後の 1px ジグル再同期で収束。
    //  Windows/macOS は従来どおり。
    void applyWindowResize(int targetW, int targetH,
                           juce::WebBrowserComponent::NativeFunctionCompletion completion);
    void resolveResizeAck();
    bool   resizeAckPending { false };
    bool   resizeSelfDriven { false };
    juce::uint32 resizeAckStartMs { 0 };
    juce::WebBrowserComponent::NativeFunctionCompletion pendingResizeCompletion;
    juce::uint32 lastResizeActivityMs { 0 };
    bool   settleReconcileDone { true };
    bool   resyncStep2Pending { false };
    int    resyncTargetW { 0 };
    int    resyncTargetH { 0 };
    // CSS px → 論理 px の換算比率（= getWidth()/innerWidth ≒ devicePixelRatio/ホスト総スケール）。
    //  ドラッグ開始時の window_action.resizeBegin で 1 回だけ確定し、resizeTo で適用する。
    //  これが無いと分数スケーリング環境でハンドル(CSS px)とウィンドウ(論理px)がズレる（MixCompare 方式）。
    double webResizeRatioW { 1.0 };
    double webResizeRatioH { 1.0 };
    // 初期サイズを「設計 CSS px × ratio」に合わせる（MixCompare の apply_layout 方式）。
    //  分数スケーリング環境で初期ウィンドウの CSS ビューポートが設計より小さくなるのを防ぐ。
    //  ※ 保存サイズ(APVTS)は従来どおり論理 px で持つ。保存値がある場合は ctor の復元値が同一
    //    ディスプレイで正しいので apply_layout では上書きしない（二重に ratio を掛けないため）。
    //    上書きするのは保存値が無い初回(fresh)だけ。designTarget* は ctor で確定した CSS(設計) px。
    bool   initialLayoutApplied { false };
    bool   restoredFromSavedSize { false };
    int    designTargetW { kInitialWidth };
    int    designTargetH { kInitialHeight };

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
