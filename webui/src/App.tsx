import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  Box,
  Paper,
  ThemeProvider,
  Tooltip,
  Typography,
} from '@mui/material';
import { CssBaseline, createTheme } from '@mui/material';
import { juceBridge } from './bridge/juce';
import { useJuceComboBoxIndex, useJuceSliderState } from './hooks/useJuceParam';
import { NumericDragInput } from './components/NumericDragInput';
import { MaterialUISwitch } from './components/MaterialUISwitch';
import { useHostShortcutForwarding } from './hooks/useHostShortcutForwarding';
import { useGlobalZoomGuard } from './hooks/useGlobalZoomGuard';
import { GlobalDialog } from './components/GlobalDialog';
import LicenseDialog from './components/LicenseDialog';
import { VUMeter, type VUMeterDataSource, type VUMeterThemeName } from './components/VUMeter';
import { WebTransportBar } from './components/WebTransportBar';
import { WebDemoMenu, MENU_WIDE_QUERY, MENU_DRAWER_WIDTH } from './components/WebDemoMenu';
import { useMediaQuery } from '@mui/material';
import './App.css';

const IS_WEB_MODE = import.meta.env.VITE_RUNTIME === 'web';

// REFERENCE_LEVEL のレンジ（dBFS）。C++ 側 createParameterLayout と一致させる。
const REF_LEVEL_MIN = -24;
const REF_LEVEL_MAX = 0;
const REF_LEVEL_STEP = 1;
const REF_LEVEL_DEFAULT = -18;

// プラグイン全体の MUI テーマは「シリーズ共通の dark 1 つだけ」で固定する。
//  THEME パラメータは VU メーター内部の配色（dial / 針 / scale）の切替にのみ使い、
//  Paper / タイトル / 操作子周りは Light に切替えても見た目が変わらないようにする。
const pluginTheme = createTheme({
  palette: {
    mode: 'dark',
    primary: { main: '#4fc3f7', light: '#8bf6ff', dark: '#0093c4' },
    secondary: { main: '#ffab00' },
    background: { default: '#606F77', paper: '#252525' },
    text: { primary: '#e0e0e0', secondary: '#a0a0a0' },
    // dark default は薄すぎて title 行の #606F77 上で見えないため、明るめのグレーに。
    divider: 'rgba(255, 255, 255, 0.3)',
  },
  typography: {
    fontFamily:
      '"Jost",-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    h6: { fontSize: '1.1rem', fontWeight: 500 },
  },
  shape: { borderRadius: 8 },
  components: {
    MuiButton: {
      styleOverrides: {
        root: { textTransform: 'none', fontWeight: 500 },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: { backgroundImage: 'none' },
      },
    },
  },
});

function App() {
  useHostShortcutForwarding();
  useGlobalZoomGuard();

  // REFERENCE_LEVEL: 連続値（-24..0 dBFS、1 dB step）。クリックすると縦フェーダーがポップアップ。
  //  juce-framework-frontend-mirror の `getScaledValue` がバージョン依存で normalised をそのまま
  //  返してしまうケースがあり、正規化値ベースで自前に dBFS を計算する方式に統一する。
  const refLevelState = useJuceSliderState('REFERENCE_LEVEL');
  const subscribeRefLevel = useCallback(
    (onChange: () => void) => {
      if (!refLevelState) return () => {};
      const id = refLevelState.valueChangedEvent.addListener(onChange);
      return () => refLevelState.valueChangedEvent.removeListener(id);
    },
    [refLevelState],
  );
  const getRefLevelNorm = useCallback(() => {
    if (!refLevelState) {
      return (REF_LEVEL_DEFAULT - REF_LEVEL_MIN) / (REF_LEVEL_MAX - REF_LEVEL_MIN);
    }
    return refLevelState.getNormalisedValue();
  }, [refLevelState]);
  const refLevelNorm = useSyncExternalStore(subscribeRefLevel, getRefLevelNorm);

  // 表示用 / 子コンポーネント用に dBFS（整数 dB スナップ）として取り出す。
  const referenceLevel = Math.round(REF_LEVEL_MIN + refLevelNorm * (REF_LEVEL_MAX - REF_LEVEL_MIN));

  const setReferenceLevelDb = useCallback(
    (db: number) => {
      if (!refLevelState) return;
      const clamped = Math.max(REF_LEVEL_MIN, Math.min(REF_LEVEL_MAX, db));
      const norm = (clamped - REF_LEVEL_MIN) / (REF_LEVEL_MAX - REF_LEVEL_MIN);
      refLevelState.setNormalisedValue(norm);
    },
    [refLevelState],
  );

  // THEME: 0=Dark / 1=Light
  const { index: themeIdx, setIndex: setThemeIdx } = useJuceComboBoxIndex('THEME');
  const meterTheme: VUMeterThemeName = themeIdx === 1 ? 'light' : 'dark';

  // C++ から push される最新 dBFS とチャンネル数。
  //  ref に直接書き込み、VU メーター側は rAF 内で getDbFS() で読みに来る（再レンダー不要）。
  const leftDbFSRef = useRef<number | null>(null);
  const rightDbFSRef = useRef<number | null>(null);
  const [numChannels, setNumChannels] = useState<number>(2);

  useEffect(() => {
    const meterId = juceBridge.addEventListener('meterUpdate', (data: unknown) => {
      const obj = data as { left?: number; right?: number; numChannels?: number } | null;
      if (!obj) return;
      if (typeof obj.left === 'number') leftDbFSRef.current = obj.left;
      if (typeof obj.right === 'number') rightDbFSRef.current = obj.right;
      else rightDbFSRef.current = null;
      if (typeof obj.numChannels === 'number') {
        setNumChannels(obj.numChannels > 0 ? obj.numChannels : 2);
      }
    });
    const layoutId = juceBridge.addEventListener('channelLayoutChanged', (data: unknown) => {
      const obj = data as { numChannels?: number } | null;
      const n = typeof obj?.numChannels === 'number' ? obj.numChannels : 2;
      setNumChannels(n > 0 ? n : 2);
    });
    return () => {
      juceBridge.removeEventListener(meterId);
      juceBridge.removeEventListener(layoutId);
    };
  }, []);

  // ネイティブへの "ready" 通知。
  useEffect(() => {
    juceBridge.whenReady(() => {
      juceBridge.callNative('system_action', 'ready');
    });
  }, []);

  // 右クリック抑制（DAW 操作の邪魔をしない）。Select などの内蔵 input は除外。
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (t.closest('input, textarea, select, [contenteditable="true"], .allow-contextmenu')) return;
      if (import.meta.env.DEV) return;
      e.preventDefault();
    };
    window.addEventListener('contextmenu', onContextMenu, { capture: true });
    return () => window.removeEventListener('contextmenu', onContextMenu, { capture: true });
  }, []);

  const [licenseOpen, setLicenseOpen] = useState(false);

  const isMono = numChannels <= 1;

  // メーター用 DataSource。getter を毎フレーム呼んで最新値を取り出す。
  const leftSource: VUMeterDataSource = useMemo(() => ({ getDbFS: () => leftDbFSRef.current }), []);
  const rightSource: VUMeterDataSource = useMemo(() => ({ getDbFS: () => rightDbFSRef.current }), []);

  // プラグインウィンドウの実寸を見て、極小サイズのときだけ余白を畳む。
  //  通常サイズでは ZeroComp / TestTone と完全に同じ p:2 / px:2 py:2 gap:2 で動かす。
  const [hostSize, setHostSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      setHostSize({ w: r.width, h: r.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // タイトル / 操作子を畳む極小モードに入るしきい値。
  //  「これらを隠した方が、残った領域でメーター本体を大きく見せられる」体感に合わせて
  //  早めに切替える。Web デモ時はカードが固定サイズ（600×220）なので発火させない。
  const ultraCompact = !IS_WEB_MODE && (hostSize.h < 150 || hostSize.w < 380);

  // Web デモ時、画面が広ければサイドにデモメニューを常時表示（drawer 幅ぶん右パディングを確保）
  const wideDrawerDocked = useMediaQuery(MENU_WIDE_QUERY) && IS_WEB_MODE;

  // リサイズハンドル（右下コーナー）。WebView 上に置いて見える ::after スタイルを当てつつ、
  //  ドラッグで `window_action.resizeTo` を native にコールしてウィンドウを伸縮させる。
  //  最小サイズは native（PluginEditor.h kMinWidth/kMinHeight）と同期。
  const dragState = useRef<{ startX: number; startY: number; startW: number; startH: number } | null>(null);
  const resizeRAFRef = useRef<number>(0);
  const onResizeDragStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      startW: window.innerWidth,
      startH: window.innerHeight,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);
  const onResizeDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragState.current) return;
    const dx = e.clientX - dragState.current.startX;
    const dy = e.clientY - dragState.current.startY;
    // 最小サイズは PluginEditor.h の kMinWidth/kMinHeight と同期
    const w = Math.max(240, dragState.current.startW + dx);
    const h = Math.max(90, dragState.current.startH + dy);
    if (!resizeRAFRef.current) {
      resizeRAFRef.current = requestAnimationFrame(() => {
        resizeRAFRef.current = 0;
        juceBridge.callNative('window_action', 'resizeTo', w, h);
      });
    }
  }, []);
  const onResizeDragEnd = useCallback(() => {
    dragState.current = null;
  }, []);

  return (
    <ThemeProvider theme={pluginTheme}>
      <CssBaseline />
      <style>{`
        html, body, #root {
          -webkit-user-select: none;
          -ms-user-select: none;
          user-select: none;
        }
        input, textarea, select, [contenteditable="true"], .allow-selection {
          -webkit-user-select: text !important;
          -ms-user-select: text !important;
          user-select: text !important;
          caret-color: auto;
        }
        /* 右下リサイズハンドル — primary 色で 4 つの斜めドットを描く（シリーズ共通の見た目） */
        #resizeHandle::after {
          content: '';
          position: absolute;
          right: 4px;
          top: 8px;
          width: 2px;
          height: 2px;
          background: rgba(79, 195, 247, 1);
          border-radius: 1px;
          pointer-events: none;
          box-shadow:
            -4px 4px 0 0 rgba(79, 195, 247, 1),
            -8px 8px 0 0 rgba(79, 195, 247, 1),
            -1px 7px 0 0 rgba(79, 195, 247, 1);
        }
      `}</style>

      {/* Web モード時はページ全域を outer container で包み、上下中央 + 横方向はカードを mx:auto で
          中央寄せ、drawer ドック時は outer の pr で右に余白を確保する。 */}
      <Box
        sx={IS_WEB_MODE
          ? {
              minHeight: '100vh',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              py: 4,
              pl: 2,
              pr: wideDrawerDocked ? `${MENU_DRAWER_WIDTH + 16}px` : 2,
              gap: 1.5,
            }
          : { display: 'contents' }
        }
      >
        {/* Input transport bar（Web のみ） */}
        {IS_WEB_MODE && (
          <Box sx={{ width: 600, maxWidth: '100%' }}>
            <Typography
              variant='caption'
              sx={{
                display: 'block',
                px: 1.5,
                color: 'text.secondary',
                fontWeight: 600,
                letterSpacing: 1,
                textTransform: 'uppercase',
                fontSize: '0.65rem',
                mb: 0.25,
              }}
            >
              Input
            </Typography>
            <WebTransportBar />
          </Box>
        )}

      <Box
        ref={rootRef}
        sx={IS_WEB_MODE
          ? {
              // Web デモ時はプラグインの "ウィンドウ" をそのまま再現したフローティングカード。
              //  サイズはプラグインデフォルト (kInitialWidth × kInitialHeight = 600×220)。
              width: 600,
              maxWidth: '100%',
              height: 220,
              flexShrink: 0, // outer flex で縦方向に潰されない
              display: 'flex',
              flexDirection: 'column',
              borderRadius: 2,
              boxShadow: 8,
              backgroundColor: 'background.default',
              position: 'relative',
              overflow: 'hidden',
              // 中身の padding はプラグインモードと同じ（タイトル行は pt:0、四方は p:2）。
              p: 2,
              pt: 0,
            }
          : {
              height: '100vh',
              display: 'flex',
              flexDirection: 'column',
              p: ultraCompact ? 0.75 : 2,
              pt: ultraCompact ? 0.75 : 0,
              overflow: 'hidden',
            }
        }
      >
        {/* タイトル行（Paper の外） — タイトル / クレジットは両端、操作子は絶対配置で
            プラグインウィンドウ全体の中央に固定する（両端要素の幅差で中央がブレないように）。 */}
        {!ultraCompact && (
          <Box
            sx={{
              position: 'relative',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              px: 1,
              py: 0.25,
              gap: 1,
              minHeight: 0,
            }}
          >
            <Typography
              variant='body2'
              component='div'
              sx={{ color: 'primary.main', fontWeight: 600, cursor: 'pointer', flexShrink: 0 }}
              onClick={() => setLicenseOpen(true)}
              title='Licenses'
            >
              TinyVU
            </Typography>

            {/* 中央: Reference + Theme スイッチ。親要素の中央 (50%) に絶対配置 */}
            <Box
              sx={{
                position: 'absolute',
                left: '50%',
                top: '50%',
                transform: 'translate(-50%, -50%)',
                display: 'flex',
                alignItems: 'center',
                gap: 0.5,
                pointerEvents: 'auto',
              }}
            >
              <NumericDragInput
                value={referenceLevel}
                min={REF_LEVEL_MIN}
                max={REF_LEVEL_MAX}
                step={REF_LEVEL_STEP}
                fineStep={REF_LEVEL_STEP}
                label='Ref'
                unit='dB'
                onChange={setReferenceLevelDb}
                title='Reference Level (0VU = dBFS) — drag, wheel, or click'
              />
              <Tooltip
                title={meterTheme === 'dark' ? 'Switch to Light theme' : 'Switch to Dark theme'}
                arrow
              >
                <MaterialUISwitch
                  checked={meterTheme === 'dark'}
                  onChange={(_, checked) => setThemeIdx(checked ? 0 : 1)}
                />
              </Tooltip>
            </Box>

            <Typography
              variant='caption'
              color='text.secondary'
              onClick={() => setLicenseOpen(true)}
              sx={{ cursor: 'pointer', flexShrink: 0 }}
              title='Licenses'
            >
              by Jun Murakami
            </Typography>
          </Box>
        )}

        {/* Paper — メーター本体のみ。
            このプラグイン特有のレイアウト: 下 / 左右の外枠マージンを揃え、上だけタイトル行で広い。
            内側 padding は対称にして（py: 1.5）、メーターが Paper の上下中央に来るようにする。 */}
        <Paper
          elevation={2}
          sx={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            py: ultraCompact ? 0.75 : 1.5,
            px: ultraCompact ? 0.75 : 2,
            // mb は付けない（外枠の下マージンは Outer Box の `p: 2` の pb と同じ 16px に統一）。
            overflow: 'hidden',
          }}
        >
          <Box sx={{ flex: 1, minHeight: 0 }}>
            <VUMeter
              leftSource={leftSource}
              rightSource={isMono ? undefined : rightSource}
              mono={isMono}
              referenceLevel={referenceLevel}
              options={{ theme: meterTheme }}
            />
          </Box>
        </Paper>

        {/* 右下リサイズハンドル — Web デモ時は不要（ブラウザがリサイズを担う）。 */}
        {!IS_WEB_MODE && (
          <div
            id='resizeHandle'
            onPointerDown={onResizeDragStart}
            onPointerMove={onResizeDrag}
            onPointerUp={onResizeDragEnd}
            onPointerCancel={onResizeDragEnd}
            style={{
              position: 'fixed',
              right: 0,
              bottom: 0,
              width: 24,
              height: 24,
              cursor: 'nwse-resize',
              zIndex: 2147483647,
              backgroundColor: 'transparent',
              touchAction: 'none',
            }}
            title='Resize'
          />
        )}
      </Box>

      {/* Web モード時のみ: カード下にキャプション（日 / 英） */}
      {IS_WEB_MODE && (
        <Box sx={{ width: 600, maxWidth: '100%', textAlign: 'center', mt: 1, color: 'text.secondary' }}>
          <Typography
            variant='body2'
            sx={{ display: 'block', fontSize: '0.85rem', lineHeight: 1.6 }}
          >
            限界までサイズを小さくできる省スペースな VU メーターです。
          </Typography>
          <Typography
            variant='caption'
            sx={{ display: 'block', fontSize: '0.75rem', opacity: 0.8 }}
          >
            A space-saving VU meter that can be shrunk all the way down.
          </Typography>
        </Box>
      )}
      </Box>

      <LicenseDialog open={licenseOpen} onClose={() => setLicenseOpen(false)} />
      <GlobalDialog />
      {IS_WEB_MODE && <WebDemoMenu />}
    </ThemeProvider>
  );
}

export default App;
