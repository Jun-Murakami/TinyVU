#pragma once

// プラグイン側 plugin/src/dsp/VuMeter.cpp と同じアルゴリズムを WASM 用にミニマル移植。
//  - 全サンプル sliding window で sum-of-squares を更新
//  - publishLatestDbFS() で RMS → 20*log10 → +3.0103 dB sine 校正補正
//  - JUCE / std::atomic 依存なし（AudioWorklet は単一スレッドで動くため）

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <vector>

namespace tv_wasm {

class VuMeter {
public:
    void prepare(double sampleRateHz, double integrationSeconds = 0.005)
    {
        sampleRate = (sampleRateHz > 0.0) ? sampleRateHz : 48000.0;
        const double secs = (integrationSeconds > 0.0) ? integrationSeconds : 0.005;
        int desired = static_cast<int>(std::round(sampleRate * secs));
        desired = std::clamp(desired, 32, 1 << 16);
        windowSize = desired;

        ringSquares.assign(static_cast<size_t>(windowSize), 0.0f);
        writeIndex = 0;
        runningSum = 0.0;
        latestDbFS = -120.0f;
    }

    void reset()
    {
        std::fill(ringSquares.begin(), ringSquares.end(), 0.0f);
        writeIndex = 0;
        runningSum = 0.0;
        latestDbFS = -120.0f;
    }

    void processBlock(const float* channelData, int numSamples)
    {
        if (channelData == nullptr || numSamples <= 0 || ringSquares.empty()) return;
        const int N = static_cast<int>(ringSquares.size());

        for (int i = 0; i < numSamples; ++i)
        {
            const float s = channelData[i];
            const float sq = s * s;
            runningSum -= ringSquares[static_cast<size_t>(writeIndex)];
            ringSquares[static_cast<size_t>(writeIndex)] = sq;
            runningSum += sq;
            if (++writeIndex >= N) writeIndex = 0;
        }

        publishLatestDbFS();
    }

    float getLatestDbFS() const { return latestDbFS; }

private:
    void publishLatestDbFS()
    {
        if (ringSquares.empty()) return;

        // 数値ドリフト緩和: ブロック末尾で実際の合計を再計算（plugin 版と同じ）
        double freshSum = 0.0;
        for (float v : ringSquares) freshSum += static_cast<double>(v);
        if (freshSum < 0.0) freshSum = 0.0;
        runningSum = freshSum;

        const double meanSquare = runningSum / static_cast<double>(ringSquares.size());
        const double rms = std::sqrt(std::max(0.0, meanSquare));

        constexpr double kFloorLin = 1.0e-6; // ≈ -120 dBFS
        constexpr double kSineRmsToPeakDb = 3.0102999566398121; // 20*log10(sqrt(2))
        const double clipped = std::max(rms, kFloorLin);
        const double db = 20.0 * std::log10(clipped) + kSineRmsToPeakDb;
        latestDbFS = static_cast<float>(db);
    }

    double sampleRate = 48000.0;
    int    windowSize = 240;

    std::vector<float> ringSquares;
    int    writeIndex = 0;
    double runningSum = 0.0;

    float  latestDbFS = -120.0f;
};

} // namespace tv_wasm
