// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jun Murakami
import {
  type CSSProperties,
  type FC,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

// vu-meter-react (https://github.com/jun-murakami/vu-meter-react) のロジックを移植したコンポーネント。
//  - 入力は JUCE 側から push される dBFS（Latest Ref パターン）。Web Audio API は使わない。
//  - 親コンテナの実寸に追随してフルレスポンシブに描画する。
//  - 「Paper の中にパネルが埋まっている」印象を作るため、ケース + inset 影 + アスペクト固定の dial を持つ。

// ---------------------------------------------------------------------------
// 色変換ユーティリティ
// ---------------------------------------------------------------------------
interface RGBA { r: number; g: number; b: number; a: number }

function parseColor(color: string): RGBA {
  const rgbaMatch = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*(\d*\.?\d+))?\)/);
  if (rgbaMatch) {
    return {
      r: parseInt(rgbaMatch[1], 10),
      g: parseInt(rgbaMatch[2], 10),
      b: parseInt(rgbaMatch[3], 10),
      a: rgbaMatch[4] ? parseFloat(rgbaMatch[4]) : 1,
    };
  }
  const hexMatch = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(color);
  if (hexMatch) {
    return {
      r: parseInt(hexMatch[1], 16),
      g: parseInt(hexMatch[2], 16),
      b: parseInt(hexMatch[3], 16),
      a: 1,
    };
  }
  return { r: 0, g: 0, b: 0, a: 1 };
}

function colorToRgba(color: string, alpha?: number): string {
  const rgba = parseColor(color);
  return `rgba(${rgba.r}, ${rgba.g}, ${rgba.b}, ${alpha !== undefined ? alpha : rgba.a})`;
}

function adjustBrightness(color: string, factor: number): string {
  const rgba = parseColor(color);
  const adjust = (value: number) => Math.min(255, Math.max(0, Math.round(value * factor)));
  return `rgba(${adjust(rgba.r)}, ${adjust(rgba.g)}, ${adjust(rgba.b)}, ${rgba.a})`;
}

// ---------------------------------------------------------------------------
// テーマ（vu-meter-react と同じ "ヴィンテージ VU" の配色を維持）
// ---------------------------------------------------------------------------
export type VUMeterThemeName = 'dark' | 'light';

interface VUMeterTheme {
  needleColor: string;
  labelColor: string;
  backgroundColor: string;
  boxColor: string;
}

const darkTheme: VUMeterTheme = {
  needleColor: '#ff6b6b',
  labelColor: '#888888',
  backgroundColor: '#1a1a1a',
  boxColor: '#1a1a1a',
};

const lightTheme: VUMeterTheme = {
  needleColor: '#d32f2f',
  labelColor: '#444444',
  backgroundColor: '#faf3e0',
  boxColor: '#f5f5f5',
};

// ---------------------------------------------------------------------------
// VU 弾道（IEC 60268-17 由来の 2 次系 critically-damped、対称、解析解で更新）
//  運動方程式（ζ=1）:
//    ẍ + 2ω·ẋ + ω²·(x - target) = 0
//  ステップ応答: x(t) = target + (A + B·t)·e^(-ω·t)（A=x₀-target, B=v₀+ωA）
//  解析解で更新するので Euler の数値誤差オーバーシュートが起きない。
//
//  99% 到達条件: ω·T₉₉ ≈ 6.638
//  Attack / Release ともに同じ T₉₉ を使う対称弾道。スピードを変えたい時は T99_SECONDS
//  だけ調整すれば全体が均等にスケールする。
// ---------------------------------------------------------------------------
class VUBallistics {
  // 全体スピードのつまみ。値を小さくすると針の動きが速くなる。
  private static readonly T99_SECONDS = 0.35
  private static readonly OMEGA = 6.638 / VUBallistics.T99_SECONDS;
  private level = 0;
  private velocity = 0;

  process(inputLevel: number, deltaTime: number): number {
    const dt = Math.max(0, deltaTime);
    if (dt <= 0) return this.level;

    const omega = VUBallistics.OMEGA;
    const decay = Math.exp(-omega * dt);
    const A = this.level - inputLevel;
    const B = this.velocity + omega * A;
    this.level = inputLevel + (A + B * dt) * decay;
    this.velocity = (B * (1 - omega * dt) - omega * A) * decay;

    return this.level;
  }
}

// ---------------------------------------------------------------------------
// dBFS から針の角度（-25..+25 度）への区間線形補間（vu-meter-react と同じ実測カーブ）
// ---------------------------------------------------------------------------
function vuValueToAngle(vuValue: number): number {
  if (vuValue <= -20) return -23;
  if (vuValue <= -10) return -23 + ((vuValue + 20) / 10) * 7;
  if (vuValue <= -7) return -16 + ((vuValue + 10) / 3) * 4;
  if (vuValue <= -5) return -12 + ((vuValue + 7) / 2) * 4;
  if (vuValue <= -3) return -8 + ((vuValue + 5) / 2) * 5;
  if (vuValue <= -2) return -3 + ((vuValue + 3) / 1) * 3;
  if (vuValue <= -1) return 0 + ((vuValue + 2) / 1) * 3.5;
  if (vuValue <= 0) return 3.5 + ((vuValue + 1) / 1) * 4.5;
  if (vuValue <= 1) return 8 + (vuValue / 1) * 5;
  if (vuValue <= 2) return 13 + ((vuValue - 1) / 1) * 5;
  if (vuValue <= 3) return 18 + ((vuValue - 2) / 1) * 7;
  return 25;
}

// ---------------------------------------------------------------------------
// 1 メーター本体
// ---------------------------------------------------------------------------
export interface VUMeterDataSource {
  // チャンネルごとの最新 dBFS（C++ から push される値）。`null` のときは無音扱い。
  getDbFS: () => number | null;
}

export interface VUMeterOptions {
  theme?: VUMeterThemeName;
  needleColor?: string;
  labelColor?: string;
  backgroundColor?: string;
  boxColor?: string;
  fontFamily?: string;
  peakHoldMs?: number;
  peakFadeMs?: number;
  clipThresholdDeg?: number;
  // ピークランプの反対側（左上）に表示するチャンネルラベル（"L" / "R" など）。
  //  指定が無ければ非表示（モノラル時など）。
  channelLabel?: string;
}

interface SingleMeterProps {
  source: VUMeterDataSource;
  referenceLevel: number;
  width: number;
  height: number;
  options?: VUMeterOptions;
}

// メーター 1 個分の基準寸法。
//  - wrapper（visible meter box）: BASE_DIAL_WIDTH × BASE_DIAL_HEIGHT = 200 × 110
//  - SVG content area:             BASE_DIAL_WIDTH × BASE_SVG_HEIGHT = 200 × 120（vu-meter-react 由来の original）
//  - SVG を wrapper 上端から (BASE_SVG_HEIGHT - BASE_DIAL_HEIGHT) = 10 base px 突き出させて配置し、
//    `overflow: hidden` で上端のクリーム色の空白だけをクロップする。これで「中身（スケール弧 / 針 /
//    数字）は元のサイズのまま、wrapper の上端だけ 10 px 短く」という見た目が実現できる。
//  - 針の長さ・ピボット位置は wrapper でなく SVG コンテンツに対して固定する必要がある（wrapper を
//    縮めても針は元の長さ・元のピボットを保つ）。BASE_NEEDLE_LENGTH / BASE_NEEDLE_BOTTOM_OFFSET は
//    すべて scaleY に乗算して使う。
const BASE_DIAL_WIDTH = 200;
const BASE_DIAL_HEIGHT = 110;
const BASE_SVG_HEIGHT = 120;
const BASE_NEEDLE_BOTTOM_OFFSET = -90;
const BASE_NEEDLE_LENGTH = 1.3 * BASE_SVG_HEIGHT; // = 156（SVG コンテンツ高 × 130%）

const SingleMeter: FC<SingleMeterProps> = ({
  source,
  referenceLevel,
  width,
  height,
  options = {},
}) => {
  const gradientId = useId();

  // width × height がそのままダイヤルの大きさ（ラベル領域は持たない）。
  const scaleX = width / BASE_DIAL_WIDTH;
  const scaleY = height / BASE_DIAL_HEIGHT;
  const minScale = Math.min(scaleX, scaleY);

  const themeName = options.theme ?? 'dark';
  const baseTheme = themeName === 'dark' ? darkTheme : lightTheme;

  const colors = {
    needle: options.needleColor || baseTheme.needleColor,
    label: options.labelColor || baseTheme.labelColor,
    background: options.backgroundColor || baseTheme.backgroundColor,
    box: options.boxColor || baseTheme.boxColor,
  };

  // ライトテーマは Waves 風ヴィンテージの雰囲気を出すため、ラジアルグラデで
  //  「中央クリーム / 隅こげ茶」の vignette をかける。
  //  ダークテーマは従来どおりの軽い斜めグラデで陰影を作る。
  const wrapperBackground =
    themeName === 'light'
      ? // ellipse の中心を少し上に置いて、上から光が当たっているような立体感を演出。
        'radial-gradient(ellipse 110% 120% at 50% 35%, #faf3e0 0%, #f0dcae 38%, #b8895c 78%, #5a361e 95%, #36200f 100%)'
      : `linear-gradient(135deg, ${adjustBrightness(colors.background, 1.3)} 0%, ${colors.background} 50%, ${adjustBrightness(colors.background, 1.3)} 100%)`;

  const derivedColors = {
    peakLamp: colors.needle,
    peakLampGlow: colorToRgba(colors.needle, 0.5),
    scaleMain: colorToRgba(colors.label, 0.85),
    scaleSub: colorToRgba(colors.label, 0.65),
    labelMain: colors.label,
    labelSub: colorToRgba(colors.label, 0.6),
    vuLogo: colorToRgba(colors.label, 0.4),
    warningZone: colorToRgba(colors.needle, 0.35),
    plusLabel: colors.needle,
    boxShadowInset: themeName === 'dark' ? 'rgba(0,0,0,0.7)' : 'rgba(0,0,0,0.55)',
    boxShadow: themeName === 'dark' ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.25)',
    boxBorder: themeName === 'dark' ? '#2a2a2a' : '#3a2515',
    innerArcGuide: colorToRgba(colors.label, 0.5),
  };

  // SVG 座標系（vu-meter-react と同じ "20 20 160 100"）。SVG は wrapper より高い領域 (BASE_SVG_HEIGHT)
  //  に描画して上をクロップする。dialCenterY は SVG content 内部の y 座標（オリジナル 195）。
  const VIEWBOX_MIN_Y = 20;
  const VIEWBOX_HEIGHT = 100;
  const SVG_HEIGHT_PX = BASE_SVG_HEIGHT * scaleY;       // SVG content の実ピクセル高さ
  const SVG_TOP_PX = (BASE_DIAL_HEIGHT - BASE_SVG_HEIGHT) * scaleY; // wrapper top に対するオフセット（負）
  const NEEDLE_BOTTOM_OFFSET_PX = BASE_NEEDLE_BOTTOM_OFFSET * scaleY;
  const svgUnitsPerPxY = VIEWBOX_HEIGHT / Math.max(1, SVG_HEIGHT_PX);
  // 針の pivot を wrapper 座標系で求め、SVG content の上端からの相対距離に直す。
  const needlePivotFromTopPxInWrapper = BASE_DIAL_HEIGHT * scaleY + Math.abs(NEEDLE_BOTTOM_OFFSET_PX);
  const needlePivotFromSvgTopPx = needlePivotFromTopPxInWrapper - SVG_TOP_PX;
  const dialCenterY = VIEWBOX_MIN_Y + needlePivotFromSvgTopPx * svgUnitsPerPxY;

  // ballistics の出力は React state を介さず直接 DOM 書き換えする（再レンダー回避でレイテンシ削減）。
  //  針 / ピークランプの DOM への参照を ref で保持し、rAF コールバックで style を直接更新する。
  const needleRef = useRef<HTMLDivElement | null>(null);
  const peakLampRef = useRef<HTMLDivElement | null>(null);

  const animationFrameRef = useRef<number | undefined>(undefined);
  const ballisticsRef = useRef<VUBallistics | null>(null);
  const lastTimeRef = useRef<number>(0);
  const lastClipTimeMsRef = useRef<number | null>(null);

  const sourceRef = useRef(source);
  sourceRef.current = source;
  const referenceLevelRef = useRef(referenceLevel);
  referenceLevelRef.current = referenceLevel;

  // ピークランプの色はテーマに関わらず固定（dark テーマ寄り）。
  //  ライト時の周辺がクリーム色で明るいため、off 時は埋没しないよう中間グレーに振る。
  const LAMP_BASE = '#ff6b6b';   // active 時の赤
  const LAMP_OFF_BG = '#6a6a6a'; // off 時の中間グレー（明るめの周辺でも視認できる）
  const LAMP_BORDER = 'rgba(255, 255, 255, 0.45)'; // 円周のリング（明るめ）
  const lampColorsRef = useRef({ base: LAMP_BASE, border: LAMP_OFF_BG });
  lampColorsRef.current = { base: LAMP_BASE, border: LAMP_OFF_BG };
  // ピークランプ最後の状態（テーマ切替時に正しい色で再描画させる用）
  const lastIntensityRef = useRef(0);

  // ピークランプを押すと即座に消灯する（保持中・フェード中いずれも）。
  //  - lastClipTimeMsRef を null に戻して以後の rAF で intensity = 0 になるようにする
  //  - DOM も即時に消灯状態へ書き換える（次フレーム待ちで残光が見えるのを防ぐ）
  const handlePeakLampClick = () => {
    lastClipTimeMsRef.current = null;
    lastIntensityRef.current = 0;
    const lamp = peakLampRef.current;
    if (lamp) {
      lamp.style.backgroundColor = LAMP_OFF_BG;
      lamp.style.boxShadow = 'none';
    }
  };

  const peakHoldMs = options.peakHoldMs ?? 1000;
  const peakFadeMs = options.peakFadeMs ?? 5000;
  const clipThresholdDeg = options.clipThresholdDeg ?? 23;

  useEffect(() => {
    ballisticsRef.current = new VUBallistics();

    const animate = (currentTime: number) => {
      if (!lastTimeRef.current) lastTimeRef.current = currentTime;
      const deltaTime = (currentTime - lastTimeRef.current) / 1000;
      lastTimeRef.current = currentTime;

      const dbFS = sourceRef.current.getDbFS();
      const ref = referenceLevelRef.current;

      let angle: number;
      if (dbFS == null) {
        angle = -25;
      } else {
        const vuValue = dbFS - ref;
        if (vuValue <= -20) angle = -25;
        else if (vuValue >= 3) angle = 25;
        else angle = vuValueToAngle(vuValue);
      }

      const normalizedLevel = (angle + 25) / 50;
      const ballistics = ballisticsRef.current!;
      const smoothedLevel = ballistics.process(normalizedLevel, deltaTime);
      const directRotation = smoothedLevel * 50 - 25;

      // 針の角度を DOM に直接書き込む（React state を経由しない）
      const needle = needleRef.current;
      if (needle) {
        needle.style.transform = `translateX(-50%) rotate(${directRotation}deg)`;
      }

      if (directRotation >= clipThresholdDeg) {
        lastClipTimeMsRef.current = currentTime;
      }

      let intensity = 0;
      if (lastClipTimeMsRef.current != null) {
        const msSinceLastClip = currentTime - lastClipTimeMsRef.current;
        if (msSinceLastClip <= peakHoldMs) intensity = 1;
        else {
          const t = Math.min(1, (msSinceLastClip - peakHoldMs) / peakFadeMs);
          intensity = 1 - t;
        }
      }

      // ピークランプも DOM 直書き
      const lamp = peakLampRef.current;
      if (lamp) {
        const { base, border } = lampColorsRef.current;
        if (intensity <= 0.001) {
          lamp.style.backgroundColor = border;
          lamp.style.boxShadow = 'none';
        } else {
          lamp.style.backgroundColor = colorToRgba(base, 0.2 + intensity * 0.8);
          lamp.style.boxShadow = `0 0 ${10 + intensity * 6}px ${colorToRgba(base, 0.3 + intensity * 0.4)}`;
        }
        lastIntensityRef.current = intensity;
      }

      animationFrameRef.current = requestAnimationFrame(animate);
    };

    animationFrameRef.current = requestAnimationFrame(animate);
    return () => {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    };
  }, [peakHoldMs, peakFadeMs, clipThresholdDeg]);

  const styles = {
    // ダイヤル本体（針 / pivot をクリップする領域）。Paper に「埋め込まれているパネル」として
    //  inset 影を残し、自身が一段下がっているような立体感を作る。
    //  下部ラベルは持たないので、コンポーネント全体 ＝ このダイヤル領域。
    wrapper: {
      position: 'relative',
      width,
      height,
      background: wrapperBackground,
      borderRadius: 6 * minScale,
      boxShadow: `inset 0 2px 6px ${derivedColors.boxShadowInset}, inset 0 -1px 2px ${derivedColors.boxShadow}`,
      overflow: 'hidden',
      border: `1px solid ${derivedColors.boxBorder}`,
      fontFamily: options.fontFamily || '"Red Hat Mono", monospace',
    } as CSSProperties,
    // SVG は wrapper より縦に大きく描画して上端を wrapper の `overflow: hidden` でクロップする。
    //  height = BASE_SVG_HEIGHT / BASE_DIAL_HEIGHT、top = (BASE_DIAL_HEIGHT - BASE_SVG_HEIGHT) / BASE_DIAL_HEIGHT。
    //  これで「中身（スケール弧 / 針 / 数字）はオリジナルサイズのまま、wrapper の上 1/4 だけが切り取られる」
    //  という見た目になり、内容が一緒に縮まない。
    scale: {
      position: 'absolute',
      left: 0,
      width: '100%',
      height: `${(BASE_SVG_HEIGHT / BASE_DIAL_HEIGHT) * 100}%`,
      top: `${((BASE_DIAL_HEIGHT - BASE_SVG_HEIGHT) / BASE_DIAL_HEIGHT) * 100}%`,
    } as CSSProperties,
    needle: {
      position: 'absolute',
      bottom: `${NEEDLE_BOTTOM_OFFSET_PX}px`,
      left: '50%',
      width: Math.max(1, Math.round(1 * scaleX)),
      // 針の長さは SVG コンテンツサイズ基準で固定（wrapper でなく BASE_SVG_HEIGHT に対する 130%）。
      //  これで wrapper の上を切り取っても針は元の長さを保ち、スケール内縁まで届く。
      height: `${BASE_NEEDLE_LENGTH * scaleY}px`,
      backgroundColor: colors.needle,
      transformOrigin: 'bottom center',
      transition: 'none',
      boxShadow: `0 0 6px ${derivedColors.peakLampGlow}`,
      willChange: 'transform',
    } as CSSProperties,
    peakLamp: {
      position: 'absolute' as const,
      top: 12 * scaleY,
      right: 12 * scaleX,
      width: 10 * minScale,
      height: 10 * minScale,
      borderRadius: '50%' as const,
      // backgroundColor / boxShadow は rAF が直接書き換える。ここでは「消灯」相当の初期値だけ渡す。
      //  色はテーマ非依存（ダーク/ライトとも同じスタイル）。
      backgroundColor: LAMP_OFF_BG,
      boxShadow: 'none',
      transition: 'none' as const,
      border: `1px solid ${LAMP_BORDER}`,
      zIndex: 10,
      cursor: 'pointer' as const,
    } as CSSProperties,
  };

  // SVG ヘルパ
  const polarToCartesian = (cx: number, cy: number, r: number, angleDeg: number) => {
    const rad = (angleDeg * Math.PI) / 180;
    return { x: cx + Math.sin(rad) * r, y: cy - Math.cos(rad) * r };
  };
  const arcPath = (cx: number, cy: number, r: number, start: number, end: number) => {
    const startPt = polarToCartesian(cx, cy, r, start);
    const endPt = polarToCartesian(cx, cy, r, end);
    const largeArc = Math.abs(end - start) > 180 ? 1 : 0;
    return `M ${startPt.x} ${startPt.y} A ${r} ${r} 0 ${largeArc} 1 ${endPt.x} ${endPt.y}`;
  };
  const ringSectorPath = (cx: number, cy: number, rInner: number, rOuter: number, start: number, end: number) => {
    const p1 = polarToCartesian(cx, cy, rOuter, start);
    const p2 = polarToCartesian(cx, cy, rOuter, end);
    const p3 = polarToCartesian(cx, cy, rInner, end);
    const p4 = polarToCartesian(cx, cy, rInner, start);
    const largeArc = Math.abs(end - start) > 180 ? 1 : 0;
    return `M ${p1.x} ${p1.y} A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${p2.x} ${p2.y} L ${p3.x} ${p3.y} A ${rInner} ${rInner} 0 ${largeArc} 0 ${p4.x} ${p4.y} Z`;
  };

  const innerArcRadius = 124;
  const innerArcPath = arcPath(100, dialCenterY, innerArcRadius, -25, 25);
  const positiveBand = ringSectorPath(100, dialCenterY, 124, 132, 8, 25);

  return (
    <div style={styles.wrapper}>
      <svg style={styles.scale} viewBox="20 20 160 100">
          <title>VU Meter</title>
          <defs>
            <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#4CAF50" />
              <stop offset="70%" stopColor="#FFC107" />
              <stop offset="100%" stopColor={colors.needle} />
            </linearGradient>
          </defs>
          <path d={positiveBand} fill={derivedColors.warningZone} stroke="none" />
          <path d={innerArcPath} fill="none" stroke={derivedColors.innerArcGuide} strokeWidth={1.5} />

          <text
            x={100}
            y={210}
            fill={derivedColors.vuLogo}
            fontSize={18}
            // V と U の advance width を揃えるため、wrapper の既定（Red Hat Mono、等幅）を継承する。
            //  Jost のようなプロポーショナル書体だと U が V より細く見える問題を回避。
            fontFamily='"Red Hat Mono", ui-monospace, Menlo, Consolas, monospace'
            textAnchor="middle"
            letterSpacing={2}
            transform={'scale(1, 0.5)'}
          >
            VU
          </text>

          {/* チャンネルラベル（L / R）。VU 表記と同じ書体（縦潰し + 同色 + 同 letterSpacing）、
              気持ち大きめのサイズで「ピークランプの反対側＝左上」に配置。
              天井からの距離はピークランプ（CSS の top: 12*scaleY）と揃うよう、scale(1,0.5)
              適用後のグリフ上端が SVG y≈30（=描画 y 12px）になる位置に baseline を置く。 */}
          {options.channelLabel && (
            // scale(1, 0.5) 後のグリフ上端が wrapper 上端から ~12 px に来るよう baseline を y=90 に置く。
            //  ピークランプ（CSS top: 12 * scaleY）と視覚的に揃う位置。
            <text
              x={26}
              y={90}
              fill={derivedColors.vuLogo}
              fontSize={20}
              fontFamily='"Jost", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
              textAnchor="start"
              letterSpacing={2}
              transform={'scale(1, 0.5)'}
            >
              {options.channelLabel}
            </text>
          )}

          {/* スケールマーク */}
          {[
            { vu: -25, angle: -25, main: true },
            { vu: -20, angle: -23, main: false },
            { vu: -10, angle: -16, main: false },
            { vu: -7, angle: -12, main: false },
            { vu: -5, angle: -8, main: false },
            { vu: -3, angle: -3, main: false },
            { vu: -2, angle: 0, main: false },
            { vu: -1, angle: 3.5, main: false },
            { vu: 0, angle: 8, main: true },
            { vu: 1, angle: 13, main: false },
            { vu: 2, angle: 18, main: false },
            { vu: 3, angle: 25, main: true },
          ].map((mark) => {
            const length = mark.main ? 18 : 12;
            const radius = 137;
            const x1 = 100 + Math.sin((mark.angle * Math.PI) / 180) * radius;
            const y1 = dialCenterY - Math.cos((mark.angle * Math.PI) / 180) * radius;
            const x2 = 100 + Math.sin((mark.angle * Math.PI) / 180) * (radius - length);
            const y2 = dialCenterY - Math.cos((mark.angle * Math.PI) / 180) * (radius - length);
            return (
              <line
                key={`mark-${mark.vu}`}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke={mark.vu <= 0 ? derivedColors.scaleSub : derivedColors.plusLabel}
                strokeWidth={mark.main ? 1.5 : 1}
              />
            );
          })}

          {/* 数値ラベル */}
          {[
            { vu: -20, angle: -23, main: true },
            { vu: -10, angle: -16, main: true },
            { vu: -7, angle: -12, main: false },
            { vu: -5, angle: -8, main: false },
            { vu: -3, angle: -3, main: false },
            { vu: -2, angle: 0, main: true },
            { vu: -1, angle: 3.5, main: false },
            { vu: 0, angle: 8, main: true },
            { vu: 1, angle: 13, main: false },
            { vu: 2, angle: 18, main: false },
            { vu: 3, angle: 25, main: true },
          ].map((label) => {
            const labelRadius = 137;
            const cy = dialCenterY + 20;
            const x = 100 + Math.sin((label.angle * Math.PI) / 180) * labelRadius;
            const y = cy - Math.cos((label.angle * Math.PI) / 180) * labelRadius - 22;
            return (
              <text
                key={`label-${label.vu}`}
                x={x}
                y={y}
                fill={label.vu <= 0 ? derivedColors.labelMain : derivedColors.plusLabel}
                fontSize={label.vu === 0 ? '10' : '9'}
                fontFamily='"Jost", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
                textAnchor="middle"
              >
                {Math.abs(label.vu).toString()}
              </text>
            );
          })}

          {/* +/- 記号 */}
          {(() => {
            const cy = dialCenterY + 10;
            const signRadius = 145;
            const minus = polarToCartesian(100, cy, signRadius, -28);
            const plus = polarToCartesian(100, cy, signRadius, 28);
            return (
              <>
                <text x={minus.x} y={minus.y} fill={derivedColors.labelMain} fontSize="12" textAnchor="middle">
                  -
                </text>
                <text x={plus.x} y={plus.y} fill={derivedColors.plusLabel} fontSize="12" textAnchor="middle">
                  +
                </text>
              </>
            );
          })()}
        </svg>

        <div
          ref={needleRef}
          style={{
            ...styles.needle,
            // 初期角度（rAF が走り始めるまでのフレーム用）。以後は rAF が style.transform を直書き。
            transform: 'translateX(-50%) rotate(-25deg)',
          }}
        />
      <div
        ref={peakLampRef}
        style={styles.peakLamp}
        onClick={handlePeakLampClick}
        title='Click to reset peak indicator'
      />
    </div>
  );
};

// ---------------------------------------------------------------------------
// 親 VUMeter（mono / stereo 切替 + コンテナ追従）
// ---------------------------------------------------------------------------
export interface VUMeterProps {
  leftSource: VUMeterDataSource;
  rightSource?: VUMeterDataSource;
  mono?: boolean;
  referenceLevel: number;
  options?: VUMeterOptions;
}

const ASPECT = BASE_DIAL_WIDTH / BASE_DIAL_HEIGHT; // 5:3 ≈ 1.667（ラベル無し、ダイヤル単体）

export const VUMeter: FC<VUMeterProps> = ({
  leftSource,
  rightSource,
  mono = false,
  referenceLevel,
  options,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerSize, setContainerSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setContainerSize({
        w: Math.max(0, Math.floor(rect.width)),
        h: Math.max(0, Math.floor(rect.height)),
      });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 横並び / 縦積みそれぞれで「メーター 1 個分」の最大寸法を試算し、大きい方を採用する。
  //  - 横並び: 幅を 2 等分してメーターをアスペクトフィット
  //  - 縦積み: 高さを 2 等分してメーターをアスペクトフィット
  //  - モノラルは比較不要。コンテナ全域を 1 個のスロットとして使う（半分にしないので余白が出ない）。
  const computeFit = (vertical: boolean) => {
    const w = containerSize.w;
    const h = containerSize.h;
    if (w <= 0 || h <= 0) return { mw: 0, mh: 0, gap: 0 };
    const g = vertical
      ? Math.max(2, Math.min(12, Math.round(h * 0.03)))
      : Math.max(2, Math.min(12, Math.round(w * 0.03)));
    const slotW = vertical ? w : Math.max(0, (w - g) / 2);
    const slotH = vertical ? Math.max(0, (h - g) / 2) : h;
    let mw = slotW;
    let mh = mw / ASPECT;
    if (mh > slotH) {
      mh = slotH;
      mw = mh * ASPECT;
    }
    return { mw, mh, gap: g };
  };

  // モノラルはコンテナ全域を 1 メーターに割り当てる。
  const computeMonoFit = () => {
    const w = containerSize.w;
    const h = containerSize.h;
    if (w <= 0 || h <= 0) return { mw: 0, mh: 0, gap: 0 };
    let mw = w;
    let mh = mw / ASPECT;
    if (mh > h) {
      mh = h;
      mw = mh * ASPECT;
    }
    return { mw, mh, gap: 0 };
  };

  let fit: { mw: number; mh: number; gap: number };
  let isVerticalStack = false;
  if (mono) {
    fit = computeMonoFit();
  } else {
    const horizontalFit = computeFit(false);
    const verticalFit = computeFit(true);
    // 縦積みの方が「メーターが大きく表示できる」場合に縦積みへ切替える。
    isVerticalStack = verticalFit.mw > horizontalFit.mw;
    fit = isVerticalStack ? verticalFit : horizontalFit;
  }

  const gap = mono ? 0 : fit.gap;
  const mw = Math.max(0, Math.floor(fit.mw));
  const mh = Math.max(0, Math.floor(fit.mh));

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: isVerticalStack ? 'column' : 'row',
        gap,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      {mw > 0 && mh > 0 && (
        <>
          <SingleMeter
            source={leftSource}
            referenceLevel={referenceLevel}
            width={mw}
            height={mh}
            // ステレオ時のみ "L" を表示。モノラルではラベルを出さない。
            options={mono ? options : { ...options, channelLabel: 'L' }}
          />
          {!mono && rightSource && (
            <SingleMeter
              source={rightSource}
              referenceLevel={referenceLevel}
              width={mw}
              height={mh}
              options={{ ...options, channelLabel: 'R' }}
            />
          )}
        </>
      )}
    </div>
  );
};
