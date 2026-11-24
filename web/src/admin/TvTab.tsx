import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import type { TvConfig } from '../api';
import { errorText } from '../ui';
import type { Contest, Election } from './types';

const DEFAULTS: TvConfig = { headline: '', headlineStyle: 'alert', focus: [], rotateSeconds: 8, defaultView: 'detail' };

function parse(raw: string): TvConfig {
  try {
    return { ...DEFAULTS, ...(JSON.parse(raw || '{}') as Partial<TvConfig>) };
  } catch {
    return DEFAULTS;
  }
}

/** 轉播版面（新聞台風格）的設定：快訊標題、焦點選舉區、輪播速度。 */
export function TvTab({ election, contests, reload }: { election: Election; contests: Contest[]; reload: () => Promise<void> }) {
  const saved = parse(election.tv);
  const [tv, setTv] = useState<TvConfig>(saved);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [previewKey, setPreviewKey] = useState(0);
  const multi = contests.length > 1;
  const url = `/e/${election.id}/tv`;

  const save = async (next: TvConfig, ok: string) => {
    try {
      await api(`/api/admin/elections/${election.id}`, { method: 'PATCH', body: { tv: next } });
      setTv(next);
      setMessage({ ok: true, text: ok });
      await reload();
    } catch (err) {
      setMessage({ ok: false, text: errorText(err) });
    }
  };
  const submitHeadline = (e: FormEvent) => {
    e.preventDefault();
    void save(tv, tv.headline.trim() ? '快訊已更新，轉播畫面會立刻換上' : '快訊已清除');
  };
  const setFocus = (index: number, value: string) => {
    const focus = [tv.focus[0] ?? 0, tv.focus[1] ?? 0];
    focus[index] = Number(value);
    setTv({ ...tv, focus: focus.filter((id, i) => id > 0 && focus.indexOf(id) === i) });
  };

  return (
    <>
      {message && <p className={message.ok ? 'success' : 'alert'}>{message.text}</p>}
      <section className="card section">
        <div className="section-head">
          <h2>轉播版面</h2>
          <div className="row">
            <Link className="btn btn-primary" to={url} target="_blank">開啟轉播版面 ↗</Link>
            <button className="btn" onClick={() => setPreviewKey((k) => k + 1)}>重新載入預覽</button>
          </div>
        </div>
        <p className="help">
          仿電視開票報導的 16:9 畫面：大頭照、以「萬」為單位的大字票數、快訊橫幅、底部輪播與時鐘。
          開啟後按右上角的「全螢幕」就能投影或放上電視牆；也可以在直播軟體（例如 OBS）加入「瀏覽器來源」，網址填這一頁、尺寸 1920×1080。
          {election.status === 'draft' && ' 這場選舉目前是草稿，只有登入後台的瀏覽器看得到轉播版面。'}
        </p>
        <iframe key={previewKey} className="tv-preview" src={url} title="轉播版面預覽" />
      </section>

      <section className="card section">
        <h2>快訊橫幅</h2>
        <form className="stack" onSubmit={submitHeadline}>
          <label className="field">
            <span>快訊文字（最多 30 個字較合適；留空白會自動顯示選舉名稱與開票進度）</span>
            <input className="input" value={tv.headline} onChange={(e) => setTv({ ...tv, headline: e.target.value })} maxLength={60} placeholder="例如：得票數跨過當選門檻　某某某自行宣布當選" />
          </label>
          <div className="row row-center">
            <label className="check">
              <input type="radio" name="headline-style" checked={tv.headlineStyle === 'alert'} onChange={() => setTv({ ...tv, headlineStyle: 'alert' })} />
              紅底（重大快訊）
            </label>
            <label className="check">
              <input type="radio" name="headline-style" checked={tv.headlineStyle === 'info'} onChange={() => setTv({ ...tv, headlineStyle: 'info' })} />
              黃底（一般資訊）
            </label>
          </div>
          <div className="row">
            <button className="btn btn-primary">更新快訊</button>
            <button type="button" className="btn" onClick={() => void save({ ...tv, headline: '' }, '快訊已清除')} disabled={!saved.headline && !tv.headline}>清除快訊</button>
          </div>
        </form>
      </section>

      <section className="card section">
        <h2>版面設定</h2>
        <div className="row">
          {multi &&
            [0, 1].map((i) => (
              <label className="field" key={i}>
                <span>大版面{i === 0 ? '左' : '右'}邊的選舉區</span>
                <select className="input" value={tv.focus[i] ?? 0} onChange={(e) => setFocus(i, e.target.value)}>
                  <option value={0}>自動輪播</option>
                  {contests.map((c) => (
                    <option key={c.id} value={c.id}>{c.areaName}</option>
                  ))}
                </select>
              </label>
            ))}
          <label className="field" style={{ width: 150 }}>
            <span>輪播每頁停留秒數</span>
            <input className="input input-num" type="number" min={4} max={60} value={tv.rotateSeconds} onChange={(e) => setTv({ ...tv, rotateSeconds: Number(e.target.value) })} />
          </label>
          <label className="field">
            <span>公開連結預設開啟</span>
            <select className="input" value={tv.defaultView} onChange={(e) => setTv({ ...tv, defaultView: e.target.value as TvConfig['defaultView'] })}>
              <option value="detail">詳細看板（地圖、表格，可下鑽）</option>
              <option value="tv">轉播版面</option>
            </select>
          </label>
          <button className="btn btn-primary" onClick={() => void save(tv, '版面設定已儲存')}>儲存版面設定</button>
        </div>
        <p className="help">
          {multi
            ? '大版面一次放兩個選舉區，各顯示得票最高的兩位候選人；沒有指定的位置會自動輪流顯示其他縣市。底部小卡固定輪播全部縣市。'
            : '全國性選舉的大版面固定顯示各組候選人，底部小卡輪播各縣市的前兩名。'}
          候選人的照片與「當選」章請到「候選人」頁設定。
        </p>
      </section>
    </>
  );
}
