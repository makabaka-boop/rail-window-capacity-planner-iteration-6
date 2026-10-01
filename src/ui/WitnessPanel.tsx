import { useEffect, useMemo, useRef, useState } from 'react';
import type { CapacityWitness } from '../core/witness';
import type { Job } from '../core/types';

/**
 * 只读「容量占用见证」面板。
 *
 * 数据全部来自传入的同一个 CapacityWitness 对象（下载 JSON 中的
 * capacityWitness 区块也由它序列化），面板本身不做任何重算：
 *  - 时间条按合并后的片段等宽铺排，颜色表示占用率（0 容量封闭段置灰）；
 *  - 点击任一片段定位其详情：起止、有效容量、实际占用、余量与
 *    稳定排序（start、end、id）的活动作业清单；
 *  - 反向定位：在入选作业中选择一项，跳到第一个包含它的片段并高亮；
 *  - 片段内每个作业 id 也可点击，回到该作业在当前片段中的归属。
 *
 * 片段可能很多（切分点量级与入选作业数相同），列表采用窗口化渲染。
 */
export function WitnessPanel({ witness, jobs }: { witness: CapacityWitness | null; jobs: Job[] }) {
  const [selectedSeg, setSelectedSeg] = useState(0);
  const [jobQuery, setJobQuery] = useState('');
  const listRef = useRef<HTMLDivElement | null>(null);

  const segments = witness?.segments ?? [];

  // 切换见证（重新计算/导入）后选中位置归零
  const witnessKey = witness ? `${witness.workspaceDataId}#${witness.workspaceVersion}#${witness.solvedAt}` : null;
  useEffect(() => {
    setSelectedSeg(0);
    setJobQuery('');
  }, [witnessKey]);

  const jobTime = useMemo(() => {
    const m = new Map<string, { start: number; end: number }>();
    for (const j of jobs) m.set(j.id, { start: j.start, end: j.end });
    return m;
  }, [jobs]);

  if (!witness) {
    // 当前快照没有配套见证（典型：旧版本恢复的快照）：明确说明，
    // 不临时生成、不展示伪造片段，下载文件也不会包含 capacityWitness。
    return (
      <details className="witness-details">
        <summary>容量占用见证</summary>
        <div className="hint">
          当前结果没有配套的容量占用见证（旧版本恢复的结果不补造见证）。重新计算后生成的
          当前结果会附带只读见证，且下载 JSON 与页面使用同一份。
        </div>
      </details>
    );
  }

  // 见证整体合法性的廉价自检（恢复侧已做过逐段重建核对，这里只做形态断言）
  const segIndex = Math.min(selectedSeg, Math.max(0, segments.length - 1));
  const seg = segments[segIndex];

  const locateJob = (id: string): void => {
    const idx = segments.findIndex((s) => s.jobIds.includes(id));
    if (idx >= 0) {
      setSelectedSeg(idx);
      setJobQuery(id);
      requestAnimationFrame(() => scrollSegmentIntoView(listRef.current, idx));
    }
  };

  const onPickJob = (value: string): void => {
    const id = value.trim();
    if (!id) return;
    const idx = segments.findIndex((s) => s.jobIds.includes(id));
    if (idx >= 0) {
      setSelectedSeg(idx);
      requestAnimationFrame(() => scrollSegmentIntoView(listRef.current, idx));
    }
  };

  const totalOccupied = segments.reduce((sum, s) => sum + s.occupancy, 0);

  return (
    <details className="witness-details" open>
      <summary>
        容量占用见证（只读 · {segments.length} 段 · 绑定 v{witness.workspaceVersion} /{' '}
        {witness.selectedIds.length} 项入选作业）
      </summary>
      <div className="witness-toolbar">
        <label>
          定位入选作业：
          <input
            list="witness-job-options"
            value={jobQuery}
            onChange={(e) => setJobQuery(e.target.value)}
            placeholder="输入或选择作业 id"
            onKeyDown={(e) => {
              if (e.key === 'Enter') onPickJob((e.target as HTMLInputElement).value);
            }}
          />
          <datalist id="witness-job-options">
            {witness.selectedIds.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
        </label>
        <button type="button" onClick={() => onPickJob(jobQuery)}>
          定位到片段
        </button>
        {(() => {
          const hit = segments.findIndex((s) => s.jobIds.includes(jobQuery.trim()));
          return jobQuery.trim() !== '' ? (
            <span className="hint">
              {hit >= 0
                ? `作业 “${jobQuery.trim()}” 首个活动片段：#${hit}`
                : `入选集合中没有作业 “${jobQuery.trim()}”`}
            </span>
          ) : null;
        })()}
      </div>

      <div className="witness-timeline" role="img" aria-label="容量占用时间条">
        {segments.map((s, i) => (
          <button
            type="button"
            key={i}
            className={`witness-cell ${i === segIndex ? 'active' : ''} ${s.capacity === 0 ? 'cell-closed' : ''}`}
            style={{ flexGrow: Math.max(1, s.end - s.start) }}
            title={`[${s.start}, ${s.end}) 有效容量 ${s.capacity}，占用 ${s.occupancy}，余量 ${s.spare}`}
            onClick={() => setSelectedSeg(i)}
          >
            <span className="witness-cell-fill" style={{ height: fillPct(s) }} />
          </button>
        ))}
      </div>

      <div className="witness-body">
        <div className="witness-segments" ref={listRef}>
          <SegmentWindow
            segments={segments}
            activeIndex={segIndex}
            onSelect={setSelectedSeg}
            highlightJob={jobQuery.trim()}
          />
        </div>
        <div className="witness-segment-detail">
          {seg ? (
            <>
              <div className="witness-detail-head">
                片段 #{segIndex}　<code>[{seg.start}, {seg.end})</code>
              </div>
              <div className="witness-metric-row">
                <span>
                  有效容量 <strong>{seg.capacity}</strong>
                </span>
                <span>
                  实际占用 <strong>{seg.occupancy}</strong>
                </span>
                <span>
                  余量 <strong className={seg.spare === 0 ? 'spare-zero' : ''}>{seg.spare}</strong>
                </span>
                {seg.capacity === 0 && <span className="tag tag-closed">时段封闭</span>}
              </div>
              <div className="witness-job-list">
                <div className="witness-job-list-title">活动作业（{seg.jobIds.length}，稳定排序）</div>
                {seg.jobIds.length === 0 ? (
                  <div className="hint">无活动作业（作业队空闲或时段封闭）</div>
                ) : (
                  <ul>
                    {seg.jobIds.map((id) => (
                      <li key={id}>
                        <button
                          type="button"
                          className={`witness-job-link ${jobQuery.trim() === id ? 'job-hit' : ''}`}
                          onClick={() => locateJob(id)}
                          title={`${id}  ${formatInterval(id, jobTime.get(id))}`}
                        >
                          {id}
                          <span className="witness-job-interval">
                            {formatInterval(id, jobTime.get(id))}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          ) : (
            <div className="hint">见证不含任何片段（无入选作业且无容量日历）。</div>
          )}
        </div>
      </div>
      <div className="witness-footer hint">
        片段由「入选作业端点 + 容量日历端点」切分并合并相邻同容量、同活动集合片段；
        全程容量 {witness.capacity}，片段占用之和（跨段计数）{totalOccupied}。
        下载 JSON 的 capacityWitness 区块即本见证对象。
      </div>
    </details>
  );
}

function formatInterval(id: string, t: { start: number; end: number } | undefined): string {
  if (!t) return `[?, ?)  ${id}`;
  return `[${t.start}, ${t.end})`;
}

function fillPct(s: { capacity: number; occupancy: number }): string {
  if (s.capacity <= 0) return '0%';
  return `${Math.round((s.occupancy / s.capacity) * 100)}%`;
}

function scrollSegmentIntoView(container: HTMLDivElement | null, index: number): void {
  if (!container) return;
  const el = container.querySelector<HTMLElement>(`[data-seg-index="${index}"]`);
  el?.scrollIntoView({ block: 'nearest' });
}

const ROW_H = 30;
const OVERSCAN = 10;

/** 片段列表的窗口化渲染：5 万作业量级下片段数也可能接近该量级。 */
function SegmentWindow({
  segments,
  activeIndex,
  onSelect,
  highlightJob,
}: {
  segments: CapacityWitness['segments'];
  activeIndex: number;
  onSelect: (i: number) => void;
  highlightJob: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [top, setTop] = useState(0);
  const [h, setH] = useState(360);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setH(el.clientHeight || 360);
  }, []);

  const start = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
  const count = Math.ceil(h / ROW_H) + 2 * OVERSCAN;
  const end = Math.min(segments.length, start + count);
  const rows = segments.slice(start, end);

  return (
    <div ref={ref} onScroll={(e) => setTop(e.currentTarget.scrollTop)} className="witness-list-scroll">
      <div style={{ height: segments.length * ROW_H, position: 'relative' }}>
        <table className="witness-table" style={{ top: start * ROW_H }}>
          <tbody>
            {rows.map((s, off) => {
              const i = start + off;
              const hasHit = highlightJob !== '' && s.jobIds.includes(highlightJob);
              return (
                <tr
                  key={i}
                  data-seg-index={i}
                  className={[
                    i === activeIndex ? 'seg-active' : '',
                    s.capacity === 0 ? 'seg-closed' : '',
                    hasHit ? 'seg-hit' : '',
                  ].join(' ')}
                  onClick={() => onSelect(i)}
                >
                  <td className="w-idx">#{i}</td>
                  <td className="w-interval">
                    [{s.start}, {s.end})
                  </td>
                  <td className="w-num">{s.capacity}</td>
                  <td className="w-num">{s.occupancy}</td>
                  <td className="w-num">{s.spare}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
