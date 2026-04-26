import {
  type FC,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Box, Tooltip, Typography } from '@mui/material';

// 数値入力欄ですが、欄自体をドラッグ（縦）+ ホイールで値を変えられる小型コンポーネント。
//  - クリック（ドラッグせずに離す） → テキスト編集モード（type できる）
//  - 縦ドラッグ → pixelsPerStep px ごとに 1 step 増減（上=増、下=減）
//  - ホイール → 1 ノッチごとに 1 step 増減
//  - Ctrl/Cmd/Shift いずれかを押している間は fine adjust（fineStep を使う）
//  - 値が変えられることがわかるように右端に ▲▼ マーカーを表示
//  - 値の表示は format()、入力 parse() を上書きできる

export interface NumericDragInputProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  fineStep?: number;
  unit?: string;
  label?: string;
  /** 値を表示用の文字列に整える（既定: String(v)）。 */
  format?: (v: number) => string;
  /** ユーザ入力文字列を数値にパースする（既定: parseFloat、NaN→null）。 */
  parse?: (s: string) => number | null;
  /** 既定 4。1 step 動かすのに必要なドラッグ量（px）。 */
  pixelsPerStep?: number;
  onChange: (next: number) => void;
  /** Tooltip タイトル等で外側から制御したい時用。 */
  title?: string;
}

const isFineAdjustActive = (e: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }) =>
  Boolean(e.ctrlKey || e.metaKey || e.shiftKey);

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const snap = (v: number, step: number) => {
  if (!Number.isFinite(step) || step <= 0) return v;
  return Math.round(v / step) * step;
};

export const NumericDragInput: FC<NumericDragInputProps> = ({
  value,
  min,
  max,
  step = 1,
  fineStep,
  unit,
  label,
  format,
  parse,
  pixelsPerStep = 4,
  onChange,
  title,
}) => {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  // ドラッグ判定: pointerdown 時の Y / value を覚えておき、move ごとに「初期値 + delta」を計算する。
  const dragRef = useRef<{
    startY: number;
    startValue: number;
    moved: boolean;
  } | null>(null);

  // 値→表示文字列
  const fmt = useCallback(
    (v: number) => (format ? format(v) : Number.isInteger(v) ? String(v) : v.toString()),
    [format],
  );

  // テキスト→値（既定: parseFloat。"-" / 空 → null）
  const par = useCallback(
    (s: string): number | null => {
      if (parse) return parse(s);
      const t = s.trim().replace(/[^0-9eE+\-.]/g, '');
      if (t === '' || t === '-' || t === '+') return null;
      const n = parseFloat(t);
      return Number.isFinite(n) ? n : null;
    },
    [parse],
  );

  // 編集モードに入る時、現在値を初期テキストとしてセットして input を選択状態にする
  useEffect(() => {
    if (!editing) return;
    setEditText(fmt(value));
    // 次のフレームで全選択
    const id = requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.select();
      }
    });
    return () => cancelAnimationFrame(id);
  }, [editing, fmt, value]);

  const commitEdit = useCallback(
    (text: string) => {
      const parsed = par(text);
      if (parsed != null) {
        const stepUsed = isFineAdjustActive({}) ? (fineStep ?? step) : step;
        const next = clamp(snap(parsed, stepUsed), min, max);
        onChange(next);
      }
      setEditing(false);
    },
    [par, fineStep, step, min, max, onChange],
  );

  const cancelEdit = useCallback(() => {
    setEditing(false);
  }, []);

  // ===== Pointer drag =====
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (editing) return; // 編集モード中は drag ハンドルを通さない
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { startY: e.clientY, startValue: value, moved: false };
    },
    [editing, value],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      if ((e.buttons & 1) !== 1) return;

      const dy = drag.startY - e.clientY; // 上方向にドラッグで増加
      // 動きが小さい間はクリック扱い（テキスト編集に入るため）
      if (!drag.moved && Math.abs(dy) < 3) return;
      drag.moved = true;

      const stepUsed = isFineAdjustActive(e) ? (fineStep ?? step) : step;
      const stepsDelta = Math.trunc(dy / pixelsPerStep);
      const nextRaw = drag.startValue + stepsDelta * stepUsed;
      const next = clamp(snap(nextRaw, stepUsed), min, max);
      if (next !== value) onChange(next);
    },
    [pixelsPerStep, step, fineStep, min, max, value, onChange],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // capture を持っていなかった場合は無視
      }
      dragRef.current = null;
      // ドラッグせず離した場合は編集モードへ
      if (drag && !drag.moved) {
        setEditing(true);
      }
    },
    [],
  );

  // ===== Wheel =====
  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      if (editing) return;
      e.preventDefault();
      const stepUsed = isFineAdjustActive(e) ? (fineStep ?? step) : step;
      // deltaY 正 = 下にスクロール → 値を減らす
      const dir = e.deltaY > 0 ? -1 : e.deltaY < 0 ? 1 : 0;
      if (dir === 0) return;
      const next = clamp(snap(value + dir * stepUsed, stepUsed), min, max);
      if (next !== value) onChange(next);
    },
    [editing, fineStep, step, value, min, max, onChange],
  );

  const numericPart = editing ? (
    <input
      ref={inputRef}
      className='block-host-shortcuts'
      defaultValue={editText}
      onChange={(e) => setEditText(e.target.value)}
      onBlur={(e) => commitEdit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          (e.currentTarget as HTMLInputElement).blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancelEdit();
        }
      }}
      style={{
        // 値表示モードと同じ minWidth を使い、編集状態でも全体幅が変わらないようにする。
        width: '100%',
        flex: 1,
        minWidth: 0,
        height: 16,
        padding: '0 3px',
        margin: 0,
        border: '1px solid rgba(255,255,255,0.2)',
        borderRadius: 3,
        background: 'rgba(0,0,0,0.25)',
        color: 'inherit',
        fontFamily: 'inherit',
        fontSize: 'inherit',
        textAlign: 'right',
        outline: 'none',
      }}
    />
  ) : (
    <Typography
      component='span'
      sx={{
        fontSize: '0.7rem',
        fontWeight: 600,
        color: 'text.primary',
        minWidth: 22,
        textAlign: 'right',
        lineHeight: 1,
      }}
    >
      {fmt(value)}
    </Typography>
  );

  const inputRoot = (
    <Box
      role='spinbutton'
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.5,
        height: 20,
        // 編集モードと表示モードで内容幅が変わって右の Switch が押し出されないよう、絶対値で固定。
        width: 92,
        boxSizing: 'border-box',
        pl: 0.75,
        pr: 0.25,
        borderRadius: 0.75,
        border: '1px solid',
        borderColor: 'divider',
        // 親（title 行 = background.default）の色になじむトーン。
        backgroundColor: '#4d5961',
        fontSize: '0.7rem',
        cursor: editing ? 'text' : 'ns-resize',
        userSelect: 'none',
        touchAction: 'none',
        flexShrink: 0,
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onWheel={handleWheel}
    >
      {label && (
        <Typography
          component='span'
          sx={{ color: 'text.secondary', fontSize: '0.75rem', whiteSpace: 'nowrap', lineHeight: 1 }}
        >
          {label}
        </Typography>
      )}
      {numericPart}
      {unit && !editing && (
        <Typography
          component='span'
          sx={{ color: 'text.secondary', fontSize: '0.7rem', lineHeight: 1 }}
        >
          {unit}
        </Typography>
      )}
      {/* 値を変えられることが分かるように ▲▼ を縦に並べる */}
      <Box
        aria-hidden
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'text.secondary',
          fontSize: '0.55rem',
          lineHeight: 0.85,
          opacity: editing ? 0.3 : 0.7,
          ml: 0.25,
          userSelect: 'none',
          pointerEvents: 'none',
        }}
      >
        <span>▲</span>
        <span>▼</span>
      </Box>
    </Box>
  );

  // title が指定されたら MUI Tooltip でホバー情報を出す（他の操作子と同じスタイル）。
  //  Tooltip は子要素に ref を当てるため、Box 直下を子に指定する。編集中はツールチップを抑制。
  return title && !editing ? (
    <Tooltip title={title} arrow>{inputRoot}</Tooltip>
  ) : (
    inputRoot
  );
};
