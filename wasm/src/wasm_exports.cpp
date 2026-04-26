// JS 側（AudioWorklet）が呼ぶ C ABI。
// エンジン本体は vu_meter.h（plugin/src/dsp/VuMeter.cpp と同一アルゴリズム）。

#include "vu_meter.h"
#include <cstdlib>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#define WASM_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define WASM_EXPORT
#endif

// L/R 2 ch 分の独立メーター。モノラル時は左だけ更新。
static tv_wasm::VuMeter g_meterL;
static tv_wasm::VuMeter g_meterR;

extern "C" {

// ---------- 初期化 / 解放 ----------

WASM_EXPORT void dsp_init(double sampleRate, double integrationSeconds)
{
    g_meterL.prepare(sampleRate, integrationSeconds);
    g_meterR.prepare(sampleRate, integrationSeconds);
}

WASM_EXPORT void dsp_reset()
{
    g_meterL.reset();
    g_meterR.reset();
}

// ---------- メモリ（WASM heap 上にスクラッチを確保するため JS から呼ぶ）----------

WASM_EXPORT float* dsp_alloc_buffer(int numSamples)
{
    return static_cast<float*>(std::malloc(sizeof(float) * static_cast<size_t>(numSamples)));
}

WASM_EXPORT void dsp_free_buffer(float* p)
{
    std::free(p);
}

// ---------- 処理 ----------

// L のみ（モノラル）。
WASM_EXPORT void dsp_process_mono(const float* in, int numSamples)
{
    g_meterL.processBlock(in, numSamples);
}

// L / R を同時に処理。
WASM_EXPORT void dsp_process_stereo(const float* inL, const float* inR, int numSamples)
{
    g_meterL.processBlock(inL, numSamples);
    g_meterR.processBlock(inR, numSamples);
}

// ---------- 取得 ----------

WASM_EXPORT float dsp_get_dbfs_left()  { return g_meterL.getLatestDbFS(); }
WASM_EXPORT float dsp_get_dbfs_right() { return g_meterR.getLatestDbFS(); }

} // extern "C"
