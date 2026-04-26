#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

namespace tv::id {
    // TinyVU — シンプルな VU メーター（モノラル / ステレオ自動対応）
    //  - REFERENCE_LEVEL: choice。0VU として扱う dBFS 基準。一般的な放送 / 制作の値を選択肢として用意。
    //  - THEME:           choice [Dark, Light]、既定 Dark
    const juce::ParameterID REFERENCE_LEVEL { "REFERENCE_LEVEL", 1 };
    const juce::ParameterID THEME           { "THEME",           1 };
}  // namespace tv::id
