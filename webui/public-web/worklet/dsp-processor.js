/**
 * TinyVU WASM AudioWorkletProcessor.
 *
 * 役割:
 *   - 入力（128 frames × N ch）を WASM 側へコピー
 *   - dsp_process_stereo / dsp_process_mono を呼んでスライディング RMS を更新
 *   - 計算後に dsp_get_dbfs_left / right を読み、~120Hz でメインスレッドに postMessage
 *   - 出力にはスルーで入力をコピーする（ユーザがオーディオを聞けるように）
 *
 * メッセージ:
 *   in:  init-wasm
 *   out: wasm-ready, wasm-error, meter-update { left, right, numChannels }
 */

const METER_PUSH_INTERVAL_FRAMES = 0; // 毎ブロック push（= ~344Hz @ 128 frame, 48k）
//  実質メインスレッド側で rAF 受けなのでここは間引かなくても問題ない。
//  必要に応じて後でスロットルする。

class DspProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.wasm = null;
    this.wasmReady = false;
    this.wasmMemory = null;
    this.heapF32 = null;

    this.bufLPtr = 0;
    this.bufRPtr = 0;
    this.bufFrames = 0;

    this.framesSinceLastPush = 0;

    this.port.onmessage = (e) => this.handleMessage(e.data);
  }

  handleMessage(msg) {
    if (msg.type === 'init-wasm') this.initWasm(msg.wasmBytes);
  }

  async initWasm(wasmBytes) {
    try {
      const module = await WebAssembly.compile(wasmBytes);
      const importObject = { env: { emscripten_notify_memory_growth: () => {} } };
      const instance = await WebAssembly.instantiate(module, importObject);
      if (instance.exports._initialize) instance.exports._initialize();

      this.wasm = instance.exports;
      this.wasmMemory = instance.exports.memory;

      // 5ms 積分窓で初期化（plugin と同じ）
      this.wasm.dsp_init(sampleRate, 0.005);

      // 標準的な 128 frame ブロック分のスクラッチ確保
      this.ensureBuffers(2048);
      this.refreshHeapView();

      this.wasmReady = true;
      this.port.postMessage({ type: 'wasm-ready' });
    } catch (err) {
      this.port.postMessage({ type: 'wasm-error', error: String(err) });
    }
  }

  refreshHeapView() {
    if (!this.wasmMemory) return false;
    if (!this.heapF32 || this.heapF32.buffer !== this.wasmMemory.buffer) {
      this.heapF32 = new Float32Array(this.wasmMemory.buffer);
    }
    return true;
  }

  ensureBuffers(frames) {
    if (!this.wasm || frames <= this.bufFrames) return this.refreshHeapView();
    if (this.bufLPtr) this.wasm.dsp_free_buffer(this.bufLPtr);
    if (this.bufRPtr) this.wasm.dsp_free_buffer(this.bufRPtr);
    this.bufLPtr = this.wasm.dsp_alloc_buffer(frames);
    this.bufRPtr = this.wasm.dsp_alloc_buffer(frames);
    this.bufFrames = frames;
    return this.refreshHeapView();
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    // 入力が無ければ出力もサイレンス、メーターも止める。
    if (!input || input.length === 0 || !input[0]) {
      if (output && output.length > 0) {
        for (let ch = 0; ch < output.length; ++ch) output[ch].fill(0);
      }
      return true;
    }

    const numCh = input.length;
    const numFrames = input[0].length;

    // 入力 → 出力スルー
    if (output && output.length > 0) {
      for (let ch = 0; ch < output.length; ++ch) {
        const src = input[Math.min(ch, numCh - 1)];
        output[ch].set(src);
      }
    }

    // WASM へ流して RMS を更新
    if (this.wasmReady && this.ensureBuffers(numFrames)) {
      const heap = this.heapF32;
      const lOff = this.bufLPtr >> 2;
      const rOff = this.bufRPtr >> 2;

      heap.set(input[0], lOff);
      if (numCh >= 2) {
        heap.set(input[1], rOff);
        this.wasm.dsp_process_stereo(this.bufLPtr, this.bufRPtr, numFrames);
      } else {
        this.wasm.dsp_process_mono(this.bufLPtr, numFrames);
      }

      this.framesSinceLastPush += numFrames;
      if (this.framesSinceLastPush >= METER_PUSH_INTERVAL_FRAMES) {
        this.framesSinceLastPush = 0;
        const left = this.wasm.dsp_get_dbfs_left();
        const right = numCh >= 2 ? this.wasm.dsp_get_dbfs_right() : null;
        this.port.postMessage({
          type: 'meter-update',
          left,
          right,
          numChannels: numCh,
        });
      }
    }

    return true;
  }
}

registerProcessor('tinyvu-dsp-processor', DspProcessor);
