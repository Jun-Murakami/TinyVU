#include "VuMeter.h"

#include <algorithm>
#include <cmath>

namespace tv::dsp {

void VuMeter::prepare(double sampleRateHz, double integrationSeconds)
{
    sampleRate = (sampleRateHz > 0.0) ? sampleRateHz : 48000.0;
    const double secs = (integrationSeconds > 0.0) ? integrationSeconds : 0.05;

    // 32 サンプル未満は事故防止で 32 に切り上げ。極端に長い窓も上限で抑える。
    int desired = static_cast<int>(std::round(sampleRate * secs));
    desired = std::clamp(desired, 32, 1 << 16);
    windowSize = desired;

    ringSquares.assign(static_cast<size_t>(windowSize), 0.0f);
    writeIndex = 0;
    runningSum = 0.0;
    latestDbFS.store(-120.0f, std::memory_order_release);
}

void VuMeter::reset() noexcept
{
    std::fill(ringSquares.begin(), ringSquares.end(), 0.0f);
    writeIndex = 0;
    runningSum = 0.0;
    latestDbFS.store(-120.0f, std::memory_order_release);
}

void VuMeter::processBlock(const float* channelData, int numSamples) noexcept
{
    if (channelData == nullptr || numSamples <= 0 || ringSquares.empty()) return;

    const int N = static_cast<int>(ringSquares.size());

    // numerical drift を防ぐため、ブロック処理の最後に runningSum を再合算する。
    //  毎サンプル再計算より安いし、IEEE-754 の単精度誤差が積もるのを抑えられる。
    for (int i = 0; i < numSamples; ++i)
    {
        const float s = channelData[i];
        const float sq = s * s;

        // 古い値を引いて新しい値を足す。古い値は writeIndex の位置にある。
        runningSum -= ringSquares[static_cast<size_t>(writeIndex)];
        ringSquares[static_cast<size_t>(writeIndex)] = sq;
        runningSum += sq;

        if (++writeIndex >= N) writeIndex = 0;
    }

    publishLatestDbFS();
}

void VuMeter::publishLatestDbFS() noexcept
{
    if (ringSquares.empty()) return;

    // 数値ドリフト緩和: ブロック末尾で実際の合計を再計算
    double freshSum = 0.0;
    for (float v : ringSquares) freshSum += static_cast<double>(v);
    if (freshSum < 0.0) freshSum = 0.0; // 誤差で負にならないよう保険
    runningSum = freshSum;

    const double meanSquare = runningSum / static_cast<double>(ringSquares.size());
    const double rms = std::sqrt(std::max(0.0, meanSquare));

    // -INF 回避のため、-120 dBFS でクランプ
    constexpr double kFloorLin = 1.0e-6; // ≈ -120 dBFS
    // サインキャリブレーション補正: ユーザはテスト信号として
    //  「-X dBFS の sine（= peak が -X）」を流すため、RMS そのままだと -X-3.01 として読まれる。
    //  RMS に √2（= +3.0103 dB）を掛けて peak 相当の dBFS にして公開する。
    //  これで 0 dBFS の sine が 0 dBFS として届く（市販 DAW の peak meter / 多くの VU の慣例）。
    constexpr double kSineRmsToPeakDb = 3.0102999566398121; // 20*log10(sqrt(2))
    const double clipped = std::max(rms, kFloorLin);
    const double db = 20.0 * std::log10(clipped) + kSineRmsToPeakDb;
    latestDbFS.store(static_cast<float>(db), std::memory_order_release);
}

} // namespace tv::dsp
