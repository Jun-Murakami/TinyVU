// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jun Murakami
#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>

#include "ParameterIDs.h"
#include "dsp/VuMeter.h"

#include <array>
#include <atomic>

class TinyVUAudioProcessor : public juce::AudioProcessor
{
public:
    TinyVUAudioProcessor();
    ~TinyVUAudioProcessor() override;

    const juce::String getName() const override;
    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;
    bool isBusesLayoutSupported(const juce::AudioProcessor::BusesLayout& layouts) const override;
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;

    bool hasEditor() const override;
    juce::AudioProcessorEditor* createEditor() override;

    double getTailLengthSeconds() const override;
    bool acceptsMidi() const override;
    bool producesMidi() const override;
    bool isMidiEffect() const override;

    int getNumPrograms() override;
    int getCurrentProgram() override;
    void setCurrentProgram(int) override;
    const juce::String getProgramName(int) override;
    void changeProgramName(int, const juce::String&) override;
    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;

    juce::AudioProcessorValueTreeState& getState() { return parameters; }

    // UI（30Hz）から読み出される L/R の最新 RMS dBFS。
    //  メーター以外の音響経路は完全パススルー。Standalone ではマイク入力ゲインを切るため
    //  Standalone 時に限り JUCE 既定の入力経路は無効化（PluginProcessor 自体は触らない）。
    float getLatestDbFS(int channel) const noexcept
    {
        if (channel < 0 || channel >= static_cast<int>(meters.size())) return -120.0f;
        return meters[static_cast<size_t>(channel)].getLatestDbFS();
    }

    // ホストからのバスレイアウト（モノラル=1 / ステレオ=2）を UI に通知する用途で公開。
    int getActiveOutputChannels() const noexcept { return activeOutputChannels.load(std::memory_order_acquire); }

private:
    juce::AudioProcessorValueTreeState parameters;
    static juce::AudioProcessorValueTreeState::ParameterLayout createParameterLayout();

    // L/R の 2 系統だけ持つ。実バスがモノラルでも L 系統だけ更新される。
    std::array<tv::dsp::VuMeter, 2> meters {};

    std::atomic<int> activeOutputChannels { 2 };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(TinyVUAudioProcessor)
};
