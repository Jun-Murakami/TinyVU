// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jun Murakami
import { Switch, type SwitchProps } from '@mui/material';
import { useTheme } from '@mui/material/styles';

// Dark/Light テーマ切替用の Switch（太陽 / 月のグリフ入り）。
//  Title 行（Paper 外枠＝`background.default`）に置く想定で、unchecked（ライト）時は明るい
//  サム背景、checked（ダーク）時は暗いサム背景にして、選択中のテーマがダーク/ライトのどちら
//  なのかひと目で分かるようにする。グリフ色はサム背景に対して打ち抜きで見えるように反転。

export const MaterialUISwitch = (props: SwitchProps) => {
  const theme = useTheme();
  const thumbBgOff = theme.palette.text.secondary;  // unchecked（太陽 / ライト選択中）: 明
  // checked（月 / ダーク選択中）: 周辺の gray-green (#606F77) をそのまま暗くしたトーン。
  //  純粋なグレーだと冷たく浮くので、外枠のグレーグリーンと同色相で濃い色に。
  const thumbBgOn = '#3a4347';
  const glyphColorOff = '#4d5961';                    // unchecked（太陽）のグリフ: 暗
  const glyphColorOn = theme.palette.text.secondary;  // checked（月）のグリフ: 中間グレー
  const railColor = '#4d5961';

  return (
    <Switch
      {...props}
      sx={{
        // 36×20 に縮小。`translate` (CSS) と `transform` を併用すると Y 方向が二重に効くため、
        //  すべて `transform` 一本に統一して translate(X, -50%) で thumb を縦中央に固定する。
        width: 36,
        height: 20,
        padding: 0,

        '& .MuiSwitch-switchBase': {
          padding: 0,
          top: '50%',
          // off 位置: 左端から 3px、Y は -50% で縦中央
          transform: 'translate(3px, -50%)',
          '&.Mui-checked': {
            color: thumbBgOn,
            // on 位置: 36 - 14(thumb) - 3(margin) = 19、Y は -50% で縦中央維持
            transform: 'translate(19px, -50%)',
            '& .MuiSwitch-thumb': {
              // ダーク選択時はサム背景を暗トーンに切替
              backgroundColor: thumbBgOn,
            },
            '& .MuiSwitch-thumb:before': {
              // 月（クレッセント）のみ。星/スパークルは小さくて意味が伝わらないので除去。
              //  内側 cutout 半径 4.8 で欠けを深めにしている。
              backgroundImage: `url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" height="14" width="14" viewBox="0 0 20 20"><path fill="${encodeURIComponent(
                glyphColorOn,
              )}" d="M19.2 10.8a6.7 6.7 0 11-6.6-6.6 4.8 4.8 0 006.6 6.6z"/></svg>')`,
            },
            '& + .MuiSwitch-track': {
              opacity: 1,
              backgroundColor: railColor,
            },
          },
        },
        '& .MuiSwitch-thumb': {
          backgroundColor: thumbBgOff,
          width: 14,
          height: 14,
          boxSizing: 'border-box',
          border: `1px solid ${theme.palette.divider}`,
          '&::before': {
            content: "''",
            position: 'absolute',
            width: '100%',
            height: '100%',
            left: 0,
            top: 0,
            backgroundRepeat: 'no-repeat',
            backgroundPosition: 'center',
            backgroundImage: `url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" height="14" width="14" viewBox="0 0 20 20"><path fill="${encodeURIComponent(
              glyphColorOff,
            )}" d="M9.305 1.667V3.75h1.389V1.667h-1.39zm-4.707 1.95l-.982.982L5.09 6.072l.982-.982-1.473-1.473zm10.802 0L13.927 5.09l.982.982 1.473-1.473-.982-.982zM10 5.139a4.872 4.872 0 00-4.862 4.86A4.872 4.872 0 0010 14.862 4.872 4.872 0 0014.86 10 4.872 4.872 0 0010 5.139zm0 1.389A3.462 3.462 0 0113.471 10a3.462 3.462 0 01-3.473 3.472A3.462 3.462 0 016.527 10 3.462 3.462 0 0110 6.528zM1.665 9.305v1.39h2.083v-1.39H1.666zm14.583 0v1.39h2.084v-1.39h-2.084zM5.09 13.928L3.616 15.4l.982.982 1.473-1.473-.982-.982zm9.82 0l-.982.982 1.473 1.473.982-.982-1.473-1.473zM9.305 16.25v2.083h1.389V16.25h-1.39z"/></svg>')`,
          },
        },
        '& .MuiSwitch-track': {
          opacity: 1,
          backgroundColor: railColor,
          borderRadius: 20 / 2,
          boxSizing: 'border-box',
          border: `1px solid ${theme.palette.divider}`,
        },
      }}
    />
  );
};
