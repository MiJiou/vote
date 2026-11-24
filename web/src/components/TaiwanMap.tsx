import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { geoArea, geoMercator, geoPath } from 'd3-geo';
import { feature } from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';
import type { Feature, FeatureCollection, MultiPolygon, Polygon, Position } from 'geojson';

type Props = { code: string; county?: string };
type Feat = Feature<Polygon | MultiPolygon, Props>;
type Geo = { counties: Feat[]; towns: Feat[] };

let geoPromise: Promise<Geo> | null = null;

function loadGeo(): Promise<Geo> {
  geoPromise ??= fetch('/maps/tw.json')
    .then((r) => {
      if (!r.ok) throw new Error('地圖載入失敗');
      return r.json() as Promise<Topology>;
    })
    .then((topo) => ({
      counties: (feature(topo, topo.objects.counties as GeometryCollection<Props>) as FeatureCollection<Polygon | MultiPolygon, Props>).features,
      towns: (feature(topo, topo.objects.towns as GeometryCollection<Props>) as FeatureCollection<Polygon | MultiPolygon, Props>).features,
    }));
  geoPromise.catch(() => (geoPromise = null));
  return geoPromise;
}

const KINMEN = '09020';
const LIENCHIANG = '09007';
const WUQIU = '09020060'; // 烏坵鄉離金門本島太遠，計算縮放範圍時略過

const parts = (f: Feat): Position[][][] => (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates);

/**
 * 決定地圖縮放範圍時要看的形狀：每一區取最大的一塊，再加上夠大的其他區塊。
 * 這樣零星的小離島（彭佳嶼、花嶼…）不會把整張圖縮小，但仍會照常畫出。
 */
function fitShape(features: Feat[]): FeatureCollection<Polygon> {
  const all = features.map((f) => parts(f).map((coordinates) => ({ coordinates, area: geoArea({ type: 'Polygon', coordinates }) })));
  const biggest = Math.max(...all.flat().map((p) => p.area));
  const kept: Feature<Polygon>[] = [];
  for (const list of all) {
    const own = Math.max(...list.map((p) => p.area));
    for (const p of list) {
      if (p.area === own || p.area >= biggest * 0.02) kept.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: p.coordinates } });
    }
  }
  return { type: 'FeatureCollection', features: kept };
}

type Shape = { code: string; d: string; cx: number; cy: number };
type Frame = { x: number; y: number; w: number; h: number; title: string; code: string };

function project(features: Feat[], box: [[number, number], [number, number]], fitOn: Feat[] = features): Shape[] {
  const projection = geoMercator().fitExtent(box, fitShape(fitOn));
  const path = geoPath(projection);
  return features.map((f) => {
    const [cx, cy] = path.centroid(f);
    return { code: f.properties.code, d: path(f) ?? '', cx, cy };
  });
}

export type MapProps = {
  /** 省略：全國各縣市；給縣市代碼：該縣市的各鄉鎮市區。 */
  county?: string;
  fill: (code: string) => string | null;
  name: (code: string) => string;
  tooltip: (code: string) => ReactNode;
  onSelect?: (code: string) => void;
  /** 只畫這些代碼（縣市長選舉只辦部分縣市時使用）。 */
  only?: Set<string>;
  ariaLabel: string;
};

export function TaiwanMap({ county, fill, name, tooltip, onSelect, only, ariaLabel }: MapProps) {
  const [geo, setGeo] = useState<Geo | null>(null);
  const [failed, setFailed] = useState(false);
  const [hover, setHover] = useState<{ code: string; x: number; y: number } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    loadGeo().then((g) => alive && setGeo(g), () => alive && setFailed(true));
    return () => void (alive = false);
  }, []);

  const W = 400;
  const H = county ? 400 : 540;

  const { shapes, frames } = useMemo(() => {
    if (!geo) return { shapes: [] as Shape[], frames: [] as Frame[] };
    if (county) {
      const towns = geo.towns.filter((t) => t.properties.county === county);
      const fitOn = towns.filter((t) => t.properties.code !== WUQIU);
      return { shapes: project(towns, [[14, 14], [W - 14, H - 14]], fitOn.length ? fitOn : towns), frames: [] };
    }
    const main = geo.counties.filter((c) => c.properties.code !== KINMEN && c.properties.code !== LIENCHIANG);
    const out = project(main, [[12, 12], [W - 12, H - 12]]);
    const frames: Frame[] = [];
    // 金門、連江離本島太遠，放大後畫在左上角的小框裡。
    [
      { code: LIENCHIANG, y: 12, title: '連江縣' },
      { code: KINMEN, y: 104, title: '金門縣' },
    ].forEach(({ code, y, title }) => {
      const f = geo.counties.find((c) => c.properties.code === code);
      if (!f) return;
      const frame = { x: 12, y, w: 96, h: 80, title, code };
      out.push(...project([f], [[frame.x + 10, frame.y + 20], [frame.x + frame.w - 10, frame.y + frame.h - 8]]));
      frames.push(frame);
    });
    return { shapes: out, frames };
  }, [geo, county, H]);

  if (failed) return <p className="muted">地圖載入失敗，請參考下方表格。</p>;

  const visible = only ? shapes.filter((s) => only.has(s.code)) : shapes;
  const shownFrames = only ? frames.filter((f) => only.has(f.code)) : frames;
  const move = (code: string, e: { clientX: number; clientY: number }) => {
    const rect = wrap.current?.getBoundingClientRect();
    if (rect) setHover({ code, x: e.clientX - rect.left, y: e.clientY - rect.top });
  };
  const focusAt = (s: Shape) => {
    const rect = wrap.current?.getBoundingClientRect();
    if (rect) setHover({ code: s.code, x: (s.cx / W) * rect.width, y: (s.cy / H) * rect.height });
  };

  return (
    <div className="map" ref={wrap} onPointerLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="group" aria-label={ariaLabel}>
        {/* 離島小框：整個框都可以點，並在標題旁放色塊，島太小看不清時仍讀得到領先者。 */}
        {shownFrames.map((f) => {
          const color = fill(f.code);
          return (
            <g key={f.title}>
              <rect
                className={`map-frame${onSelect ? ' is-link' : ''}${hover?.code === f.code ? ' is-active' : ''}`}
                x={f.x} y={f.y} width={f.w} height={f.h} rx={6}
                onPointerMove={(e) => move(f.code, e)}
                onClick={() => onSelect?.(f.code)}
              />
              <rect className="map-frame-key" x={f.x + 8} y={f.y + 7} width={8} height={8} rx={2} style={color ? { fill: color } : undefined} />
              <text className="map-frame-title" x={f.x + 20} y={f.y + 14.5}>{f.title}</text>
            </g>
          );
        })}
        {visible.map((s) => {
          const color = fill(s.code);
          const active = hover?.code === s.code;
          const inset = frames.some((f) => f.code === s.code);
          return (
            <path
              key={s.code}
              d={s.d}
              className={`map-area${active ? ' is-active' : ''}${onSelect ? ' is-link' : ''}${inset ? ' is-inset' : ''}`}
              style={color ? { fill: color, ...(inset ? { stroke: color } : {}) } : undefined}
              tabIndex={0}
              role={onSelect ? 'link' : 'img'}
              aria-label={name(s.code)}
              onPointerMove={(e) => move(s.code, e)}
              onFocus={() => focusAt(s)}
              onBlur={() => setHover(null)}
              onClick={() => onSelect?.(s.code)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect?.(s.code);
                }
              }}
            />
          );
        })}
        {/* 滑過的區域重畫在最上層，外框才不會被鄰區蓋住。 */}
        {hover && visible.filter((s) => s.code === hover.code && !frames.some((f) => f.code === s.code)).map((s) => <path key="hover" d={s.d} className="map-outline" />)}
      </svg>
      {!geo && <p className="map-loading muted">地圖載入中…</p>}
      {hover && (
        <div
          className="tooltip"
          role="status"
          style={{
            left: Math.min(Math.max(hover.x, 110), (wrap.current?.clientWidth ?? 400) - 110),
            top: hover.y,
            transform: hover.y < 150 ? 'translate(-50%, 18px)' : 'translate(-50%, calc(-100% - 14px))',
          }}
        >
          {tooltip(hover.code)}
        </div>
      )}
    </div>
  );
}
