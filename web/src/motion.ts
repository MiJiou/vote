// 動畫工具：數字滾動、變動提示、位置交換（FLIP）。
// 使用者在系統裡開了「減少動態效果」時，一律直接顯示結果、不播放動畫。
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

export const reducedMotion = (): boolean =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const easeOutCubic = (k: number) => 1 - (1 - k) ** 3;

/**
 * 數字從上一個值平滑滾動到新值。
 * @param from 第一次顯示時從哪個數字開始滾（例如 0）；省略則直接顯示。
 */
export function useTweened(value: number, duration = 900, from?: number): number {
  const start = from !== undefined && !reducedMotion() ? from : value;
  const [shown, setShown] = useState(start);
  const current = useRef(start);
  useEffect(() => {
    if (current.current === value) return;
    if (reducedMotion()) {
      current.current = value;
      setShown(value);
      return;
    }
    const begin = current.current;
    const delta = value - begin;
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / duration);
      const v = Math.round(begin + delta * easeOutCubic(k));
      current.current = v;
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(step);
      else current.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      current.current = value;
    };
  }, [value, duration]);
  return shown;
}

/** 值變動後的一小段時間內回傳 true（第一次顯示不算），用來觸發「剛更新」的提示動畫。 */
export function useChanged(value: unknown, ms = 1200): boolean {
  const [on, setOn] = useState(false);
  const prev = useRef(value);
  useEffect(() => {
    if (Object.is(prev.current, value)) return;
    prev.current = value;
    if (reducedMotion()) return;
    setOn(true);
    const t = setTimeout(() => setOn(false), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return on;
}

/**
 * 子元素重新排序時，讓它們從舊位置滑到新位置（FLIP）。
 * 子元素需要帶 data-flip 屬性（內容為唯一的 id）。使用 offsetTop/offsetLeft，
 * 不受外層縮放（轉播舞台的 scale）影響。
 */
export function useFlip(container: RefObject<HTMLElement | null>, orderKey: string, duration = 700): void {
  const last = useRef(new Map<string, { top: number; left: number }>());
  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    const next = new Map<string, { top: number; left: number }>();
    for (const child of Array.from(el.querySelectorAll<HTMLElement>(':scope > [data-flip]'))) {
      const id = child.dataset.flip!;
      const pos = { top: child.offsetTop, left: child.offsetLeft };
      next.set(id, pos);
      const before = last.current.get(id);
      if (!before || reducedMotion()) continue;
      const dy = before.top - pos.top;
      const dx = before.left - pos.left;
      if (dx || dy) {
        child.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
          duration,
          easing: 'cubic-bezier(.2,.8,.2,1)',
        });
      }
    }
    last.current = next;
  }, [container, orderKey, duration]);
}
