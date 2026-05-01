// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jun Murakami
/**
 * juce-framework-frontend-mirror の Web 互換 shim（TinyVU 版）。
 * Vite エイリアスで本家モジュールの代わりにこれが解決される。
 *
 * TinyVU の APVTS パラメータ:
 *   REFERENCE_LEVEL (slider: -24..0 dB, integer step 1)
 *   THEME           (combo: Dark / Light)
 */

import {
  WebSliderState,
  WebToggleState,
  WebComboBoxState,
} from './WebParamState';

const sliderStates   = new Map<string, WebSliderState>();
const toggleStates   = new Map<string, WebToggleState>();
const comboBoxStates = new Map<string, WebComboBoxState>();

function makeLinearSlider(defaultScaled: number, min: number, max: number): WebSliderState {
  return new WebSliderState({
    defaultScaled,
    min,
    max,
    toScaled:   (n: number) => min + n * (max - min),
    fromScaled: (v: number) => (v - min) / (max - min),
  });
}

function registerDefaults(): void {
  // REFERENCE_LEVEL: -24..0 dBFS（plugin 側 createParameterLayout と一致）
  sliderStates.set('REFERENCE_LEVEL', makeLinearSlider(-18, -24, 0));

  // THEME: 0=Dark / 1=Light（plugin と一致）
  comboBoxStates.set('THEME', new WebComboBoxState(0, 2));
}

registerDefaults();

export function getSliderState(id: string): WebSliderState | undefined {
  return sliderStates.get(id);
}

export function getToggleState(id: string): WebToggleState | undefined {
  return toggleStates.get(id);
}

export function getComboBoxState(id: string): WebComboBoxState | undefined {
  return comboBoxStates.get(id);
}

// プラグイン版に合わせた no-op エクスポート
export function getNativeFunction(_name: string): undefined { return undefined; }
