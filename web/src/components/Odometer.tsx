// 電視台式的滾輪數字：每一位數字是一條直條，數字改變時像里程表一樣往前滾到新的值。
// 個位數與十位數變動時會多轉一整圈（像拉霸），停下時稍微超過再彈回來。
// 滾動完全由 CSS transform 完成（顯示卡處理），不需要每一格畫面重新計算，十幾個數字同時滾也很順。
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { reducedMotion } from '../motion';

/** 在「正在離場」的畫面裡設為 true：數字直接顯示，不再從 0 滾起。 */
export const FrozenContext = createContext(false);

/** 直條上放 4 輪 0–9：平常停在第 2 輪，往前滾時最多用到第 4 輪，滾完再悄悄跳回第 2 輪。 */
const LOOPS = 4;
const CELLS = Array.from({ length: LOOPS * 10 }, (_, i) => String(i % 10));

function Digit({ d, k, spin }: { d: number; k: number; spin: number }) {
  const [pos, setPos] = useState(10 + d);
  const [snap, setSnap] = useState(false);
  const prev = useRef(d);
  useEffect(() => {
    const from = prev.current;
    if (from === d) return;
    prev.current = d;
    if (reducedMotion()) {
      setPos(10 + d);
      return;
    }
    setSnap(false);
    setPos((cur) => {
      // 一律往前滾（開票數字只會增加；9→0 也是往前滾一格）
      const steps = (d - from + 10) % 10;
      const spun = cur + steps + (k <= spin && steps > 0 ? 10 : 0);
      return spun < LOOPS * 10 ? spun : cur + steps < LOOPS * 10 ? cur + steps : 10 + d;
    });
  }, [d, k, spin]);
  // 滾完後不帶動畫地跳回第 2 輪的同一個數字，下次才有空間繼續往前滾。
  const settle = () => {
    if (pos === 10 + d) return;
    setSnap(true);
    setPos(10 + d);
  };
  return (
    <span className="odo-digit" aria-hidden="true" style={{ ['--k' as string]: k }}>
      <span
        className={`odo-strip${snap ? ' is-snap' : ''}`}
        style={{ transform: `translateY(${(-pos * 100) / CELLS.length}%)` }}
        onTransitionEnd={settle}
      >
        {CELLS.map((x, i) => (
          <span key={i}>{x}</span>
        ))}
      </span>
    </span>
  );
}

/**
 * @param text   已排版好的數字文字，例如「35,616」「53.11」「4067」
 * @param rollIn 第一次出現時是否從 0 滾上來
 * @param spin   從右邊數來幾位數變動時要多轉一整圈（預設個位與十位；0 表示不多轉）
 */
export function Odometer({ text, rollIn = false, className, spin = 2 }: { text: string; rollIn?: boolean; className?: string; spin?: number }) {
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
        return /\d/.test(ch) ? <Digit key={key} k={key} d={Number(ch)} spin={spin} /> : (
          <span key={`s${key}`} className="odo-sep" aria-hidden="true">
            {ch}
          </span>
        );
      })}
    </span>
  );
}
