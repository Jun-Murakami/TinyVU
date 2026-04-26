/**
 * Web Audio API + WASM AudioWorklet マネージャ（TinyVU 版）。
 *
 * TinyVU は入力信号のレベルを測るメータープラグインなので、ここでは:
 *   - sample.mp3 / ユーザがアップロードしたオーディオファイルをデコード
 *   - BufferSource → AudioWorkletNode (WASM RMS) → AudioContext.destination
 *   - Worklet からの `meter-update` を `meterUpdate` イベント名で再送信
 *   - 再生 / Loop / Seek / Bypass の管理
 */

type EventCallback = (data: unknown) => void;

const SAMPLE_URL = '/audio/sample.mp3';
const WASM_URL = '/wasm/tinyvu_dsp.wasm';

export class WebAudioEngine {
  private audioContext: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private bypassGain: GainNode | null = null; // worklet ↔ destination の間に挟む（bypass 時はミュート）
  private throughGain: GainNode | null = null; // bypass 時の直結（dest）

  private sourceBuffer: AudioBuffer | null = null;
  private sourceNode: AudioBufferSourceNode | null = null;
  private sourceStartedAt = 0;       // ctx.currentTime 基準の再生開始時刻
  private pausedOffset = 0;          // pause 時に消費済みの時間
  private isPlaying = false;
  private loopEnabled = true;
  private bypass = false;

  private positionTimer: ReturnType<typeof setInterval> | null = null;

  private listeners = new Map<string, EventCallback>();
  private nextListenerId = 1;

  private initialized = false;
  private startPromise: Promise<void> | null = null;
  private initResolvers: Array<() => void> = [];

  /**
   * 初回起動。**必ずユーザタップ/クリックのハンドラから同期的に**呼ぶこと。
   */
  startFromUserGesture(): Promise<void> {
    if (this.startPromise) return this.startPromise;

    const ctx = new AudioContext();
    this.audioContext = ctx;
    const resumed = ctx.resume();

    // iOS unlock: 同フレームで無音 BufferSource start
    const silent = ctx.createBuffer(1, 128, ctx.sampleRate);
    const src = ctx.createBufferSource();
    src.buffer = silent;
    src.connect(ctx.destination);
    src.start(0);

    this.startPromise = (async () => {
      try { await resumed; } catch { /* ignore */ }
      await this.completeInit();
    })();
    return this.startPromise;
  }

  private async completeInit(): Promise<void> {
    const ctx = this.audioContext;
    if (!ctx) return;
    try {
      await ctx.audioWorklet.addModule('/worklet/dsp-processor.js');

      this.workletNode = new AudioWorkletNode(ctx, 'tinyvu-dsp-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      this.workletNode.port.onmessage = (e) => this.handleWorkletMessage(e.data);

      // worklet の出力 → bypassGain（直結）→ destination
      //  bypass=true の時は工程は未だスルーだが、見た目区別のために gain を持っておく。
      this.bypassGain = ctx.createGain();
      this.bypassGain.gain.value = 1.0;
      this.workletNode.connect(this.bypassGain);
      this.bypassGain.connect(ctx.destination);

      this.throughGain = ctx.createGain();
      this.throughGain.gain.value = 0.0;
      this.throughGain.connect(ctx.destination);

      // sample.mp3 の事前ロード
      try {
        const resp = await fetch(SAMPLE_URL);
        if (resp.ok) {
          const ab = await resp.arrayBuffer();
          this.sourceBuffer = await ctx.decodeAudioData(ab);
          this.emit('sourceLoaded', { name: 'sample.mp3', duration: this.sourceBuffer.duration });
        }
      } catch (e) {
        console.warn('[WebAudioEngine] sample preload failed:', e);
      }

      // WASM ロード → worklet へ送信
      const wasmResp = await fetch(WASM_URL);
      if (wasmResp.ok) {
        const bytes = await wasmResp.arrayBuffer();
        this.workletNode.port.postMessage({ type: 'init-wasm', wasmBytes: bytes }, [bytes]);
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('WASM init timeout')), 10000);
          this.initResolvers.push(() => { clearTimeout(t); resolve(); });
        });
      } else {
        console.warn('[WebAudioEngine] WASM not found at', WASM_URL);
      }

      this.startPositionTimer();
    } catch (err) {
      console.warn('[WebAudioEngine] init error:', err);
    }
    this.initialized = true;
  }

  isInitialized(): boolean { return this.initialized; }
  isStarted(): boolean { return this.startPromise !== null; }

  // ---------------- Listener ----------------

  addEventListener(event: string, callback: EventCallback): string {
    const id = `web_${this.nextListenerId++}`;
    this.listeners.set(`${event}:${id}`, callback);
    return `${event}:${id}`;
  }

  removeEventListener(key: string): void { this.listeners.delete(key); }

  private emit(event: string, data: unknown): void {
    this.listeners.forEach((cb, key) => { if (key.startsWith(`${event}:`)) cb(data); });
  }

  // ---------------- Worklet messages ----------------

  private handleWorkletMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'wasm-ready':
        this.initResolvers.forEach((r) => r());
        this.initResolvers = [];
        break;
      case 'wasm-error':
        console.warn('[WebAudioEngine] wasm error:', msg.error);
        break;
      case 'meter-update': {
        // App.tsx 側の meterUpdate ハンドラ仕様に合わせる
        this.emit('meterUpdate', {
          left: msg.left,
          right: msg.right,
          numChannels: msg.numChannels,
        });
        break;
      }
    }
  }

  // ---------------- Transport ----------------

  async play(): Promise<void> {
    const ctx = this.audioContext;
    if (!ctx || !this.sourceBuffer || !this.workletNode) return;
    if (ctx.state === 'suspended') await ctx.resume();

    if (this.sourceNode) this.stopCurrentSource();

    const src = ctx.createBufferSource();
    src.buffer = this.sourceBuffer;
    src.loop = this.loopEnabled;

    // source → worklet (analyser) → destination
    //  Bypass 時は worklet を経由せず throughGain で直接出す
    src.connect(this.workletNode);

    // 終了時の自動停止
    src.onended = () => {
      if (!this.loopEnabled) {
        this.isPlaying = false;
        this.pausedOffset = 0;
        this.emit('transportUpdate', { isPlaying: false, loopEnabled: this.loopEnabled });
      }
    };

    src.start(0, this.pausedOffset);
    this.sourceStartedAt = ctx.currentTime - this.pausedOffset;
    this.sourceNode = src;
    this.isPlaying = true;
    this.applyBypassRouting();
    this.emit('transportUpdate', { isPlaying: true, loopEnabled: this.loopEnabled });
  }

  pause(): void {
    if (!this.isPlaying || !this.sourceNode || !this.audioContext) return;
    const elapsed = this.audioContext.currentTime - this.sourceStartedAt;
    const dur = this.sourceBuffer?.duration ?? 0;
    this.pausedOffset = dur > 0 && this.loopEnabled ? (elapsed % dur) : Math.min(elapsed, dur);
    this.stopCurrentSource();
    this.isPlaying = false;
    this.emit('transportUpdate', { isPlaying: false, loopEnabled: this.loopEnabled });
  }

  seek(positionSec: number): void {
    const dur = this.sourceBuffer?.duration ?? 0;
    if (dur <= 0) return;
    const wasPlaying = this.isPlaying;
    this.pausedOffset = Math.max(0, Math.min(dur, positionSec));
    if (wasPlaying) {
      this.stopCurrentSource();
      this.play();
    }
  }

  setLoop(enabled: boolean): void {
    this.loopEnabled = enabled;
    if (this.sourceNode) this.sourceNode.loop = enabled;
    this.emit('transportUpdate', { isPlaying: this.isPlaying, loopEnabled: enabled });
  }

  setBypass(enabled: boolean): void {
    this.bypass = enabled;
    this.applyBypassRouting();
  }

  private applyBypassRouting(): void {
    if (!this.bypassGain || !this.throughGain) return;
    if (this.bypass) {
      this.bypassGain.gain.value = 0.0;
      this.throughGain.gain.value = 1.0;
    } else {
      this.bypassGain.gain.value = 1.0;
      this.throughGain.gain.value = 0.0;
    }
  }

  private stopCurrentSource(): void {
    if (!this.sourceNode) return;
    try { this.sourceNode.stop(); } catch { /* ignore */ }
    try { this.sourceNode.disconnect(); } catch { /* ignore */ }
    this.sourceNode = null;
  }

  async loadSampleFromFile(file: File): Promise<void> {
    const ctx = this.audioContext;
    if (!ctx) return;
    try {
      const ab = await file.arrayBuffer();
      const buf = await ctx.decodeAudioData(ab);
      this.sourceBuffer = buf;
      this.pausedOffset = 0;
      this.emit('sourceLoaded', { name: file.name, duration: buf.duration });
      if (this.isPlaying) {
        this.stopCurrentSource();
        this.play();
      }
    } catch (e) {
      console.warn('[WebAudioEngine] decode failed:', e);
    }
  }

  // ---------------- Position polling ----------------

  private startPositionTimer(): void {
    if (this.positionTimer) return;
    this.positionTimer = setInterval(() => {
      const ctx = this.audioContext;
      const dur = this.sourceBuffer?.duration ?? 0;
      let pos = this.pausedOffset;
      if (this.isPlaying && ctx) {
        const raw = ctx.currentTime - this.sourceStartedAt;
        pos = dur > 0 && this.loopEnabled ? (raw % dur) : Math.min(raw, dur);
      }
      this.emit('transportPositionUpdate', {
        position: pos,
        duration: dur,
        isPlaying: this.isPlaying,
      });
    }, 100);
  }
}

export const webAudioEngine = new WebAudioEngine();
