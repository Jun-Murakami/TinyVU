/**
 * `juceBridge` の Web 互換版。プラグイン版（juce.ts）と同じ I/F を提供する。
 *  - addEventListener / removeEventListener: WebAudioEngine のリスナーに丸投げ
 *  - callNative: system_action / window_action / open_url のハンドリング
 *  - whenReady / ensureStarted: AudioContext のユーザジェスチャ起動を一元管理
 */

import { webAudioEngine } from './WebAudioEngine';

type EventCallback = (data: unknown) => void;

class WebBridgeManager {
  private readyCallbacks: Array<() => void> = [];
  private isReady = true; // Web 環境では常に Ready（初期パラメータの読み出しはすぐ可能）

  whenReady(callback: () => void): void {
    if (this.isReady) callback();
    else this.readyCallbacks.push(callback);
  }

  /** 初回タップ時に呼ぶ（AudioContext 起動 + WASM ロード）。同期的呼び出しを保証。 */
  ensureStarted(): Promise<void> {
    return webAudioEngine.startFromUserGesture();
  }

  isStarted(): boolean { return webAudioEngine.isStarted(); }

  // プラグイン版と同じ系列のメソッド名
  async callNative(funcName: string, ..._args: unknown[]): Promise<unknown> {
    if (funcName === 'system_action') {
      // ready / forward_key_event は Web では何もしない
      return null;
    }
    if (funcName === 'window_action') {
      // Web ではウィンドウサイズはブラウザ依存なので no-op
      return false;
    }
    if (funcName === 'open_url') {
      const url = String(_args[0] ?? '');
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
      return true;
    }
    return null;
  }

  addEventListener(event: string, callback: EventCallback): string {
    return webAudioEngine.addEventListener(event, callback);
  }

  removeEventListener(key: string): void {
    webAudioEngine.removeEventListener(key);
  }

  emitEvent(_event: string, _data: unknown): void {
    // Web 側からネイティブへは送らない
  }
}

export const webBridge = new WebBridgeManager();
