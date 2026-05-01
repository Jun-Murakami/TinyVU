// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jun Murakami
#include "PluginProcessor.h"
#include "PluginEditor.h"

#include <memory>
#include <vector>

TinyVUAudioProcessor::TinyVUAudioProcessor()
    : AudioProcessor(BusesProperties()
                         .withInput ("Input",  juce::AudioChannelSet::stereo(), true)
                         .withOutput("Output", juce::AudioChannelSet::stereo(), true)),
      parameters(*this, nullptr, juce::Identifier("TinyVU"), createParameterLayout())
{
}

TinyVUAudioProcessor::~TinyVUAudioProcessor() = default;

juce::AudioProcessorValueTreeState::ParameterLayout TinyVUAudioProcessor::createParameterLayout()
{
    std::vector<std::unique_ptr<juce::RangedAudioParameter>> params;

    // REFERENCE_LEVEL: 0VU = X dBFS の基準。-24..0 dBFS、1 dB step。既定 -18 dBFS。
    //  既定値は EBU R128 / AES17 系の broadcast / mix 制作で広く使われる値。
    params.push_back(std::make_unique<juce::AudioParameterFloat>(
        tv::id::REFERENCE_LEVEL,
        "Reference Level",
        juce::NormalisableRange<float>(-24.0f, 0.0f, 1.0f),
        -18.0f,
        juce::AudioParameterFloatAttributes().withLabel("dBFS")));

    // THEME: Dark / Light の 2 択。既定 Dark（シリーズ既定に合わせる）。
    params.push_back(std::make_unique<juce::AudioParameterChoice>(
        tv::id::THEME,
        "Theme",
        juce::StringArray{ "Dark", "Light" },
        0));

    return { params.begin(), params.end() };
}

const juce::String TinyVUAudioProcessor::getName() const { return JucePlugin_Name; }
bool TinyVUAudioProcessor::acceptsMidi() const           { return false; }
bool TinyVUAudioProcessor::producesMidi() const          { return false; }
bool TinyVUAudioProcessor::isMidiEffect() const          { return false; }
double TinyVUAudioProcessor::getTailLengthSeconds() const{ return 0.0; }

int TinyVUAudioProcessor::getNumPrograms() { return 1; }
int TinyVUAudioProcessor::getCurrentProgram() { return 0; }
void TinyVUAudioProcessor::setCurrentProgram(int) {}
const juce::String TinyVUAudioProcessor::getProgramName(int) { return {}; }
void TinyVUAudioProcessor::changeProgramName(int, const juce::String&) {}

void TinyVUAudioProcessor::prepareToPlay(double sampleRate, int /*samplesPerBlock*/)
{
    // 5ms 積分の RMS。VU 風の smoothing は WebView 側の 2 次系弾道（T₉₉=400ms）が担う。
    //  ここはほぼピーク追従に近い短窓にして、検出のグループ遅延（≈窓長の半分）を最小化する。
    //  1 kHz 以上の校正信号なら 5ms 窓でも 5 周期以上含むので RMS 推定は十分精度が出る。
    for (auto& m : meters) m.prepare(sampleRate, 0.005);
}

void TinyVUAudioProcessor::releaseResources()
{
    for (auto& m : meters) m.reset();
}

bool TinyVUAudioProcessor::isBusesLayoutSupported(const juce::AudioProcessor::BusesLayout& layouts) const
{
    const auto& mainOut = layouts.getMainOutputChannelSet();
    if (mainOut.isDisabled()) return false;
    // mono / stereo を許可。それ以外（5.1 等）は受けない。
    if (mainOut != juce::AudioChannelSet::mono()
     && mainOut != juce::AudioChannelSet::stereo()) return false;
    const auto& mainIn = layouts.getMainInputChannelSet();
    return mainIn.isDisabled() || mainIn == mainOut;
}

void TinyVUAudioProcessor::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& /*midi*/)
{
    juce::ScopedNoDenormals noDenormals;

    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    if (numSamples <= 0 || numChannels <= 0) return;

    // 監視のみ。音は完全パススルー（buffer は触らない）。
    //  L=ch0, R=ch1。モノラルの時は L 側のメーターだけ更新する。
    if (numChannels >= 1)
        meters[0].processBlock(buffer.getReadPointer(0), numSamples);
    if (numChannels >= 2)
        meters[1].processBlock(buffer.getReadPointer(1), numSamples);

    activeOutputChannels.store(numChannels, std::memory_order_release);
}

bool TinyVUAudioProcessor::hasEditor() const { return true; }

juce::AudioProcessorEditor* TinyVUAudioProcessor::createEditor()
{
    return new TinyVUAudioProcessorEditor(*this);
}

void TinyVUAudioProcessor::getStateInformation(juce::MemoryBlock& destData)
{
    if (auto xml = parameters.copyState().createXml())
        copyXmlToBinary(*xml, destData);
}

void TinyVUAudioProcessor::setStateInformation(const void* data, int sizeInBytes)
{
    if (auto xml = getXmlFromBinary(data, sizeInBytes))
    {
        if (xml->hasTagName(parameters.state.getType()))
            parameters.replaceState(juce::ValueTree::fromXml(*xml));
    }
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new TinyVUAudioProcessor();
}
