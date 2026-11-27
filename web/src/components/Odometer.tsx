// 電視台式的滾輪數字：每一位數字是一條 0–9 的直條，數字改變時像里程表一樣滾到新的值。
// 滾動完全由 CSS transform 完成（顯示卡處理），不需要每一格畫面重新計算，十幾個數字同時滾也很順。
import { createContext, useContext, useEffect, useState } from 'react';
import { reducedMotion } from '../motion';

/** 在「正在離場」的畫面裡設為 true：數字直接顯示，不再從 0 滾起。 */
export const FrozenContext = createContext(false);

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

function Digit({ d, k }: { d: number; k: number }) {
  return (
    <span className="odo-digit" aria-hidden="true" style={{ ['--k' as string]: k }}>
      <span className="odo-strip" style={{ transform: `translateY(${-d * 10}%)` }}>
        {DIGITS.map((x) => (
          <span key={x}>{x}</span>
        ))}
      </span>
    </span>
  );
}

/**
 * @param text   已排版好的數字文字，例如「35,616」「53.11」「4067」
 * @param rollIn 第一次出現時是否從 0 滾上來
 */
export function Odometer({ text, rollIn = false, className }: { text: string; rollIn?: boolean; className?: string }) {
  const frozen = useContext(FrozenContext);
  const animateIn = rollIn && !frozen && !reducedMotion();
  const [shown, setShown] = useState(() => (animateIn ? text.replace(/\d/g, '0') : text));
  useEffect(() => {
    if (shown === text) return;
    // 第一次：先畫出 0，下一格畫面再換成真正的數字，CSS 轉場才會滾動。
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setShown(text));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [text, shown]);
  const chars = [...shown];
  return (
    <span className={`odo${className ? ` ${className}` : ''}`} aria-label={text} role="text">
      {chars.map((ch, i) => {
        // 從右邊數過來當 key：位數增加時，原本的各位數繼續滾動，新的位數從左邊長出來。
        const key = chars.length - i;
        return /\d/.test(ch) ? <Digit key={key} k={key} d={Number(ch)} /> : (
          <span key={`s${key}`} className="odo-sep" aria-hidden="true">
            {ch}
          </span>
        );
      })}
    </span>
  );
}
