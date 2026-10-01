import { useEffect, useMemo, useRef, useState } from 'react';
import type { CapacityWitness, OccupancySegment } from '../core/occupancyWitness';
import type { Job } from '../core/types';

interface Props {
  /** 已通过 verifyWitnessAgainstSnapshot 核对、与当前快照配套的只读见证 */
  witness: CapacityWitness;
  jobs: Job[];
  /** 在作业清单中定位某作业（按 id 过滤） */
  onLocateJob: (id: string) => void;
}

const ROW_HEIGHT = 30;
const OVERSCAN = 10;
const VIEWPORT_H = 260;

/**
 * 半开时间轴定位：返回满足 start <= t < end 的片段下标；t 不在见证
 * 覆盖域 [first.start, last.end) 内时返回 -1。片段首尾相接、坐标严格
 * 递增，因此二分即可；恰在右端点上的时刻属于后一片段。
 */
export function locateSegmentIndex(segments: readonly OccupancySegment[], t: number): number {
  if (segments.length === 0) return -1;
  if (t < segments[0].start || t >= segments[segments.length - 1].end) return -1;
  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segments[mid];
    if (t < s.start) hi = mid - 1;
    else if (t >= s.end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/**
 * 容量占用见证面板（只读）：
 *  - 逐片段给出 [start,end)、有效容量、实际占用、余量与稳定排序的作业清单；
 *  - 可按任意时刻定位片段，可在封闭段（有效容量 0）间跳转；
 *  - 点击片段内作业可在作业表中定位该作业；
 *  - 片段窗口化渲染（最坏约 10 万片段）。
 * 见证由父组件对「当前同身份、同版本结果」一次性生成并核对，本组件不
 * 重新计算，也不接受任何手工编辑。
 */
export function WitnessPanel({ witness, jobs, onLocateJob }: Props) {
  const segments = witness.segments;
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [timeInput, setTimeInput] = useState('');
  const [locateMsg, setLocateMsg] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(VIEWPORT_H);

  const jobById = useMemo(() => {
    const m = new Map<string, Job>();
    for (const j of jobs) m.set(j.id, j);
    return m;
  }, [jobs]);

  const closedIndices = useMemo(() => {
    const out: number[] = [];
    segments.forEach((s, i) => {
      if (s.capacity === 0) out.push(i);
    });
    return out;
  }, [segments]);

  // 见证（=结果）变化后复位选中片段
  useEffect(() => {
    setSelectedIdx(0);
    setTimeInput('');
    setLocateMsg(null);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [witness]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height;
      if (h) setViewportH(h);
    });
    observer.observe(el);
    setViewportH(el.clientHeight || VIEWPORT_H);
    return () => observer.disconnect();
  }, []);

  const scrollToIndex = (idx: number) => {
    const el = scrollRef.current;
    if (el) el.scrollTop = Math.max(0, idx * ROW_HEIGHT - ROW_HEIGHT * 2);
  };

  const locateTime = () => {
    const t = Number(timeInput.trim());
    if (!Number.isInteger(t) || t < 0) {
      setLocateMsg('请输入非负整数时刻');
      return;
    }
    // 半开时间轴：start <= t < end；恰在右端点上的时刻属于后一片段
    const found = locateSegmentIndex(segments, t);
    if (found < 0) {
      const first = segments[0]?.start;
      const last = segments[segments.length - 1]?.end;
      setLocateMsg(
        first !== undefined && last !== undefined
          ? `时刻 ${t} 不在见证时间轴 [${first}, ${last}) 内`
          : `时刻 ${t} 无对应片段`,
      );
      return;
    }
    setSelectedIdx(found);
    scrollToIndex(found);
    setLocateMsg(`已定位片段 #${found}`);
  };

  const jumpClosed = (dir: 1 | -1) => {
    if (closedIndices.length === 0) {
      setLocateMsg('时间轴上没有封闭（有效容量 0）片段');
      return;
    }
    // 从当前选中片段之后/之前找最近的封闭段
    let next = -1;
    if (dir === 1) {
      for (const i of closedIndices) if (i > selectedIdx) { next = i; break; }
      if (next < 0) next = closedIndices[0]; // 回绕
    } else {
      for (let k = closedIndices.length - 1; k >= 0; k--) {
        if (closedIndices[k] < selectedIdx) { next = closedIndices[k]; break; }
      }
      if (next < 0) next = closedIndices[closedIndices.length - 1];
    }
    setSelectedIdx(next);
    scrollToIndex(next);
    setLocateMsg(`已定位封闭片段 #${next}`);
  };

  const totalH = segments.length * ROW_HEIGHT;
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(viewportH / ROW_HEIGHT) + 2 * OVERSCAN;
  const end = Math.min(segments.length, start + visibleCount);
  const selected = segments[selectedIdx];

  const span = segments.length > 0
    ? `[${segments[0].start}, ${segments[segments.length - 1].end})`
    : '空时间轴';

  // 屏幕上展示的见证对象就是下载 JSON 中的同一个 witness
  // （ResultPanel 下载时原样传入；本组件不复制、不重算）。

  return (
    <details className="witness-details">
      <summary>
        容量占用见证（{segments.length} 个片段
        {closedIndices.length > 0 ? `，其中封闭片段 ${closedIndices.length} 个` : ''}
        ，与下载 JSON 同一见证）
      </summary>

      <div className="witness-meta hint">
        只读见证，绑定 dataId <code>{witness.workspaceDataId}</code> ·
        工作区 v{witness.workspaceVersion} · 入选 {witness.selectedIds.length} 项 ·
        时间轴 {span} · 生成于 {witness.generatedAt}
      </div>

      <div className="witness-toolbar">
        <label>
          定位时刻：
          <input
            value={timeInput}
            onChange={(e) => setTimeInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') locateTime();
            }}
            placeholder="如 30"
            inputMode="numeric"
          />
        </label>
        <button onClick={locateTime} disabled={segments.length === 0}>
          定位片段
        </button>
        <button onClick={() => jumpClosed(-1)} disabled={closedIndices.length === 0}>
          上一封闭段
        </button>
        <button onClick={() => jumpClosed(1)} disabled={closedIndices.length === 0}>
          下一封闭段
        </button>
        {locateMsg && <span className="witness-locate-msg">{locateMsg}</span>}
      </div>

      <div className="witness-body">
        <div
          className="witness-viewport"
          ref={scrollRef}
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        >
          <div style={{ height: totalH, position: 'relative' }}>
            {segments.length === 0 ? (
              <div className="hint">空见证：无入选作业且无容量日历端点。</div>
            ) : (
              <table className="witness-table" style={{ top: start * ROW_HEIGHT }}>
                <tbody>
                  {segments.slice(start, end).map((seg, off) => {
                    const i = start + off;
                    const closed = seg.capacity === 0;
                    return (
                      <tr
                        key={i}
                        className={`witness-row${i === selectedIdx ? ' selected' : ''}${
                          closed ? ' closed' : seg.spare === 0 ? ' full' : ''
                        }`}
                        onClick={() => setSelectedIdx(i)}
                      >
                        <td className="w-idx">#{i}</td>
                        <td className="w-time">
                          [{seg.start}, {seg.end})
                        </td>
                        <td className="w-num">{closed ? '0 封闭' : seg.capacity}</td>
                        <td className="w-num">{seg.occupancy}</td>
                        <td className="w-num">{seg.spare}</td>
                        <td className="w-jobs">
                          {seg.jobIds.length === 0 ? (
                            <span className="hint">—</span>
                          ) : (
                            seg.jobIds.map((id) => (
                              <span key={id} className="w-job-tag" title={id}>
                                {id}
                              </span>
                            ))
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {selected && (
          <div className="witness-detail">
            <div className="witness-detail-head">
              片段 #{selectedIdx}：
              <code>
                [{selected.start}, {selected.end})
              </code>
            </div>
            <div className="witness-detail-metrics">
              <span>
                有效容量 <strong>{selected.capacity}</strong>
                {selected.capacity === 0 && '（完全封闭）'}
              </span>
              <span>
                实际占用 <strong>{selected.occupancy}</strong>
              </span>
              <span>
                余量 <strong>{selected.spare}</strong>
              </span>
            </div>
            <div className="witness-detail-list-title">
              占用作业队的入选作业（{selected.jobIds.length}，按导入顺序）：
            </div>
            {selected.jobIds.length === 0 ? (
              <div className="hint">该片段没有入选作业占用。</div>
            ) : (
              <ul className="witness-job-list">
                {selected.jobIds.map((id) => {
                  const job = jobById.get(id);
                  return (
                    <li key={id}>
                      <button
                        className="w-locate-btn"
                        title="在作业表中定位该作业"
                        onClick={() => onLocateJob(id)}
                      >
                        {id}
                      </button>{' '}
                      <code>
                        [{job?.start}, {job?.end})
                      </code>{' '}
                      收益 {job ? job.benefit.toLocaleString() : '—'}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>
    </details>
  );
}
