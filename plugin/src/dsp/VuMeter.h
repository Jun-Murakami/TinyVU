// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jun Murakami
#pragma once

#include <juce_audio_basics/juce_audio_basics.h>
#include <atomic>
#include <vector>

namespace tv::dsp {

// 各チャンネル独立のスライディング RMS 検出器。
//  - サンプル単位で「自乗和」をリングバッファで保持し、ブロック処理ごとに dBFS を吐き出す。
//  - VU の応答（300ms 弾道）は WebView 側で行う。ここでは積分時間 ~50ms の RMS のみ扱う。
//  - dBFS の取り出しは UI スレッド（30Hz タイマー）からの atomic 読み取り。
class VuMeter {
public:
    // sampleRateHz: ホストからの実 sample rate。0 以下なら 48000 を仮定する。
    // integrationSeconds: スライディング RMS 窓長（秒）。VU 規格は 300ms 弾道だが、
    //  ここでは UI 側の弾道で吸収するため 50ms 前後で十分。
    void prepare(double sampleRateHz, double integrationSeconds = 0.05);

    void reset() noexcept;

    // 1 ブロック分の入力を取り込み、内部 RMS 状態を更新する。
    //  channelData が nullptr または numSamples<=0 の時は no-op。
    void processBlock(const float* channelData, int numSamples) noexcept;

    // 直近の RMS を dBFS で取得する（-INF は -120 にクランプ）。
    //  Audio スレッドからの書き込みと UI スレッドからの読み取りが衝突しないよう atomic で保持。
    float getLatestDbFS() const noexcept { return latestDbFS.load(std::memory_order_acquire); }

private:
    void publishLatestDbFS() noexcept;

    double sampleRate = 48000.0;
    int    windowSize = 2400; // 50ms @ 48kHz

    // リングバッファの各要素は「サンプルの 2 乗値」。合計を `runningSum` で保持し、
    //  古い値を引いて新しい値を足し込む形でインクリメンタル更新する。
    std::vector<float> ringSquares;
    int    writeIndex = 0;
    double runningSum = 0.0;

    // UI へ渡す最新 dBFS 値（RMS → 20*log10）。-120 でクランプ。
    std::atomic<float> latestDbFS { -120.0f };
};

} // namespace tv::dsp
