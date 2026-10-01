import { describe, expect, it } from 'vitest';
import {
  buildOccupancyWitness,
  verifyWitnessAgainstSnapshot,
  witnessMatchesSnapshot,
  WitnessError,
  WITNESS_KIND,
  type CapacityWitness,
  type WitnessSnapshotLike,
} from '../src/core/occupancyWitness';
import { locateSegmentIndex } from '../src/ui/WitnessPanel';
import { solve, type SolverJob } from '../src/core/solver';
import { buildResultJson, type StoredSnapshot } from '../src/core/persistence';
import { isCurrentResponse } from '../src/ui/messages';
import type { CapacityCalendarSegment, Job } from '../src/core/types';

const FIXED_NOW = '2026-10-01T08:00:00.000Z';

function makeJobs(raw: [string, number, number, number?][]): Job[] {
  return raw.map(([id, start, end, benefit]) => ({
    id,
    start,
    end,
    benefit: benefit ?? 1,
    status: 'normal',
  }));
}

function snapshotFrom(
  dataId: string,
  version: number,
  jobs: SolverJob[],
  capacity: number,
  calendar: CapacityCalendarSegment[] = [],
): StoredSnapshot {
  const result = solve(jobs, capacity, calendar);
  return {
    workspaceDataId: dataId,
    workspaceVersion: version,
    capacity,
    capacityCalendar: calendar,
    solvedAt: FIXED_NOW,
    result,
  };
}

function witnessFromSnapshot(snapshot: StoredSnapshot, jobs: Job[]): CapacityWitness {
  return buildOccupancyWitness({
    dataId: snapshot.workspaceDataId!,
    version: snapshot.workspaceVersion,
    selectedIds: snapshot.result.selectedIds,
    jobs,
    capacity: snapshot.capacity,
    calendar: snapshot.capacityCalendar,
    generatedAt: FIXED_NOW,
  });
}

/** 独立逐格计数：在给定坐标切分的每个小格上枚举跨越作业，与见证逐段核对。 */
function expectCellByCell(witness: CapacityWitness, jobs: Job[], calendar: CapacityCalendarSegment[], capacity: number) {
  // 见证片段本身按 [start,end) 左闭右开铺满；用整数小格独立复核每个片段
  const byId = new Map(jobs.map((j) => [j.id, j]));
  let peak = 0;
  for (const seg of witness.segments) {
    // 片段内部无任何作业/日历端点（合并保证），逐整数时刻计数应恒定
    const activeAt = (t: number) =>
      witness.selectedIds.filter((id) => {
        const j = byId.get(id)!;
        return j.start <= t && j.end > t;
      });
    let cap = capacity;
    for (const c of calendar) if (c.start <= seg.start && seg.start < c.end) cap = c.available;
    const ids = activeAt(seg.start);
    expect(ids.length).toBe(seg.occupancy);
    expect([...ids].sort()).toEqual([...seg.jobIds].sort());
    expect(seg.capacity).toBe(cap);
    expect(seg.spare).toBe(cap - ids.length);
    expect(ids.length).toBeLessThanOrEqual(cap);
    peak = Math.max(peak, ids.length);
    // 片段内（若宽度>1）每个整数时刻计数一致
    for (let t = seg.start; t < seg.end; t++) {
      expect(activeAt(t).length).toBe(seg.occupancy);
    }
  }
  return peak;
}

describe('容量占用见证：小时间轴逐格计数与左闭右开端点', () => {
  it('两个相接作业（end==start）不共处同一片段；独立逐格计数一致', () => {
    const jobs = makeJobs([
      ['a', 0, 2, 5],
      ['b', 2, 4, 7],
    ]);
    const snap = snapshotFrom('d1', 1, jobs, 2);
    const w = witnessFromSnapshot(snap, jobs);

    expect(w.workspaceDataId).toBe('d1');
    expect(w.workspaceVersion).toBe(1);
    expect(w.selectedIds).toEqual(['a', 'b']);
    expect(w.kind).toBe(WITNESS_KIND);
    expect(w.witnessVersion).toBe(1);
    expect(w.segments.map((s) => [s.start, s.end])).toEqual([
      [0, 2],
      [2, 4],
    ]);
    expect(w.segments[0].jobIds).toEqual(['a']);
    expect(w.segments[1].jobIds).toEqual(['b']);
    expect(w.segments[0].occupancy).toBe(1);
    expect(w.segments[0].spare).toBe(1);
    expect(w.segments[0].capacity).toBe(2);
    // 片段首尾相接、无缝铺满
    expect(w.segments[0].end).toBe(w.segments[1].start);
    const verdict = verifyWitnessAgainstSnapshot(w, snap, jobs);
    expect(verdict.ok).toBe(true);
    expectCellByCell(w, jobs, [], 2);
  });

  it('并行作业 + 空尾段：片段按容量/集合变化切分，空集合与非空集合不合并', () => {
    const jobs = makeJobs([
      ['a', 0, 3, 5],
      ['b', 1, 3, 6],
      ['c', 3, 5, 9],
    ]);
    const snap = snapshotFrom('d2', 1, jobs, 2);
    const w = witnessFromSnapshot(snap, jobs);
    // 端点 0,1,3,5：[0,1){a}、[1,3){a,b}、[3,5){c}
    expect(w.segments.map((s) => [s.start, s.end, s.occupancy])).toEqual([
      [0, 1, 1],
      [1, 3, 2],
      [3, 5, 1],
    ]);
    expect(w.segments[1].jobIds).toEqual(['a', 'b']); // 导入顺序
    expect(w.segments[1].spare).toBe(0);
    const peak = expectCellByCell(w, jobs, [], 2);
    expect(peak).toBe(snap.result.peakOccupancy);
  });

  it('容量日历端点落在作业内部：见证片段随容量切换切分', () => {
    const jobs = makeJobs([['a', 0, 10, 5]]);
    const calendar: CapacityCalendarSegment[] = [{ start: 4, end: 7, available: 1 }];
    const snap = snapshotFrom('d3', 1, jobs, 2, calendar);
    const w = witnessFromSnapshot(snap, jobs);
    expect(w.segments.map((s) => [s.start, s.end, s.capacity, s.occupancy])).toEqual([
      [0, 4, 2, 1],
      [4, 7, 1, 1],
      [7, 10, 2, 1],
    ]);
    // 余量随有效容量变化
    expect(w.segments.map((s) => s.spare)).toEqual([1, 0, 1]);
    const verdict = verifyWitnessAgainstSnapshot(w, snap, jobs);
    expect(verdict.ok).toBe(true);
    expectCellByCell(w, jobs, calendar, 2);
  });

  it('available=0 封闭片段：占用 0、余量 0，可定位且逐格计数为 0', () => {
    const jobs = makeJobs([
      ['before', 0, 5, 9],
      ['after', 15, 20, 8],
    ]);
    const calendar: CapacityCalendarSegment[] = [{ start: 5, end: 15, available: 0 }];
    const snap = snapshotFrom('d4', 1, jobs, 2, calendar);
    const w = witnessFromSnapshot(snap, jobs);
    expect(w.segments.map((s) => [s.start, s.end, s.capacity, s.occupancy, s.spare])).toEqual([
      [0, 5, 2, 1, 1],
      [5, 15, 0, 0, 0],
      [15, 20, 2, 1, 1],
    ]);
    expect(w.segments[1].jobIds).toEqual([]);
    const verdict = verifyWitnessAgainstSnapshot(w, snap, jobs);
    expect(verdict.ok).toBe(true);
    expectCellByCell(w, jobs, calendar, 2);
  });

  it('端点相接：作业在日历段端点结束/开始，两作业分属不同片段逐格定位', () => {
    const jobs = makeJobs([
      ['before', 0, 5, 9],
      ['after', 5, 10, 8],
    ]);
    // capacity=2，[0,5) 压到 1；两作业在 5 处端点相接，不共处同一片段
    const calendar: CapacityCalendarSegment[] = [{ start: 0, end: 5, available: 1 }];
    const snap = snapshotFrom('d5', 1, jobs, 2, calendar);
    const w = witnessFromSnapshot(snap, jobs);
    expect(w.segments).toHaveLength(2);
    expect(w.segments[0].jobIds).toEqual(['before']);
    expect(w.segments[0].capacity).toBe(1);
    expect(w.segments[1].jobIds).toEqual(['after']);
    expect(w.segments[1].capacity).toBe(2);
    expectCellByCell(w, jobs, calendar, 2);
  });
});

describe('容量占用见证：相邻片段合并', () => {
  it('集合与容量都相同的相邻小格合并为最大连续片段', () => {
    // a=[0,10) 横跨两个相邻日历段，两段都 available=1：
    // 容量相同 + 活动集合相同 => 中间日历端点 5 不产生新片段
    const jobs = makeJobs([['a', 0, 10, 5]]);
    const calendar: CapacityCalendarSegment[] = [
      { start: 0, end: 5, available: 1 },
      { start: 5, end: 10, available: 1 },
    ];
    const snap = snapshotFrom('d6', 1, jobs, 2, calendar);
    const w = witnessFromSnapshot(snap, jobs);
    expect(w.segments.map((s) => [s.start, s.end, s.capacity])).toEqual([[0, 10, 1]]);
    expect(w.segments[0].jobIds).toEqual(['a']);
    expect(verifyWitnessAgainstSnapshot(w, snap, jobs).ok).toBe(true);
  });

  it('日历外与日历内容量相同（available==capacity 不会出现在导入里，直接构造）：集合相同仍合并', () => {
    // 无日历：两个并行作业 [0,5) 后都结束，[5,10) 空集合——空与非空不合并
    const jobs = makeJobs([
      ['a', 0, 5, 5],
      ['b', 0, 5, 6],
    ]);
    const snap = snapshotFrom('d7', 1, jobs, 2);
    const w = witnessFromSnapshot(snap, jobs);
    expect(w.segments.map((s) => [s.start, s.end, s.occupancy])).toEqual([[0, 5, 2]]);
  });

  it('一个作业结束、另一个作业在同一端点开始：集合不同，不合并', () => {
    const jobs = makeJobs([
      ['a', 0, 3, 5],
      ['b', 3, 6, 6],
      ['c', 0, 6, 4],
    ]);
    const snap = snapshotFrom('d8', 1, jobs, 2);
    const w = witnessFromSnapshot(snap, jobs);
    // [0,3){a,c}、[3,6){b,c}：容量同为 2，但集合不同，不合并
    expect(w.segments.map((s) => [s.start, s.end])).toEqual([
      [0, 3],
      [3, 6],
    ]);
    expect(w.segments[0].jobIds).toEqual(['a', 'c']);
    expect(w.segments[1].jobIds).toEqual(['b', 'c']);
    expect(verifyWitnessAgainstSnapshot(w, snap, jobs).ok).toBe(true);
  });

  it('容量相同但活动集合变化的相邻段绝不合并（内部作业端点）', () => {
    const jobs = makeJobs([
      ['a', 0, 4, 5],
      ['b', 2, 6, 6],
    ]);
    const snap = snapshotFrom('d9', 1, jobs, 2);
    const w = witnessFromSnapshot(snap, jobs);
    expect(w.segments.map((s) => [s.start, s.end, s.occupancy])).toEqual([
      [0, 2, 1],
      [2, 4, 2],
      [4, 6, 1],
    ]);
    expectCellByCell(w, jobs, [], 2);
  });
});

describe('容量占用见证：稳定排序与空选择', () => {
  it('片段作业清单按工作区导入顺序稳定排序（非字母序）', () => {
    const jobs = makeJobs([
      ['zeta', 0, 5, 5],
      ['alpha', 0, 5, 6],
      ['mid', 0, 5, 7],
    ]);
    const snap = snapshotFrom('d10', 1, jobs, 3);
    const w = witnessFromSnapshot(snap, jobs);
    expect(w.segments[0].jobIds).toEqual(['zeta', 'alpha', 'mid']);
    expect(w.selectedIds).toEqual(snap.result.selectedIds);
  });

  it('空入选集合：见证只覆盖日历端点，全部片段占用 0', () => {
    // capacity=1 下两个重叠高收益作业？构造必选会不可行——直接让求解选空：
    // 用日历封闭所有作业时段，作业无法入选
    const jobs = makeJobs([
      ['a', 0, 5, 9],
      ['b', 2, 7, 8],
    ]);
    const calendar: CapacityCalendarSegment[] = [{ start: 0, end: 7, available: 0 }];
    const snap = snapshotFrom('d11', 1, jobs, 2, calendar);
    expect(snap.result.selectedIds).toEqual([]);
    const w = witnessFromSnapshot(snap, jobs);
    expect(w.segments).toEqual([
      { start: 0, end: 7, capacity: 0, occupancy: 0, spare: 0, jobIds: [] },
    ]);
    expect(verifyWitnessAgainstSnapshot(w, snap, jobs).ok).toBe(true);
  });

  it('无日历且无入选（空求解结果）：空见证时间轴', () => {
    const snap: StoredSnapshot = {
      workspaceDataId: 'd12',
      workspaceVersion: 1,
      capacity: 2,
      capacityCalendar: [],
      solvedAt: FIXED_NOW,
      result: {
        selectedIds: [],
        totalBenefit: 0,
        peakOccupancy: 0,
        peakCellLimit: 2,
        capacity: 2,
        selectedCount: 0,
      },
    };
    const w = witnessFromSnapshot(snap, []);
    expect(w.segments).toEqual([]);
    expect(verifyWitnessAgainstSnapshot(w, snap, []).ok).toBe(true);
  });
});

describe('容量占用见证：随机小时间轴逐格核对（含日历/必选/排除）', () => {
  function mulberry32(seed: number) {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('120 组随机用例：见证片段逐整数时刻与独立枚举一致', () => {
    const rand = mulberry32(20261001);
    let withCalendar = 0;
    let ran = 0;
    for (let trial = 0; trial < 120; trial++) {
      const n = 1 + Math.floor(rand() * 8);
      const cap = 1 + Math.floor(rand() * 3);
      const maxT = 8;
      const raw: [string, number, number][] = [];
      for (let i = 0; i < n; i++) {
        const s = Math.floor(rand() * maxT);
        const len = 1 + Math.floor(rand() * 3);
        const e = Math.min(maxT, s + len);
        if (e <= s) {
          i--;
          continue;
        }
        raw.push([`j${i}`, s, e]);
      }
      const jobs = makeJobs(raw.map(([id, s, e]) => [id, s, e, 1 + Math.floor(rand() * 20)]));
      for (const j of jobs) {
        const roll = rand();
        if (roll < 0.12) j.status = 'required';
        else if (roll < 0.24) j.status = 'excluded';
      }
      // 合法日历：限于作业范围 [minStart,maxEnd]、互不重叠允许相接、
      // available ∈ [0,cap-1]（与导入校验同标准，照搬 calendarSolver 的生成法）
      const minStart = Math.min(...raw.map((j) => j[1]));
      const maxEnd = Math.max(...raw.map((j) => j[2]));
      const calendar: CapacityCalendarSegment[] = [];
      if (rand() < 0.7) {
        const segCount = 1 + Math.floor(rand() * 2);
        let cursor = minStart;
        for (let s = 0; s < segCount; s++) {
          const remaining = maxEnd - cursor;
          if (remaining <= 1) break;
          const start = cursor + Math.floor(rand() * (remaining - 1));
          const maxLen = maxEnd - start;
          const end = start + 1 + Math.floor(rand() * Math.min(2, maxLen - 1));
          if (end > maxEnd || start >= end) continue;
          calendar.push({ start, end, available: Math.floor(rand() * cap) });
          cursor = end;
        }
      }
      if (calendar.length > 0) withCalendar++;

      let snap: StoredSnapshot;
      try {
        snap = snapshotFrom('drand', 1, jobs, cap, calendar);
      } catch {
        continue; // 必选不可行用例跳过（求解器另有专项测试）
      }
      ran++;
      let w: CapacityWitness;
      try {
        w = witnessFromSnapshot(snap, jobs);
      } catch (err) {
        throw new Error(
          `trial ${trial} 生成见证失败: ${(err as Error).message}; cap=${cap} calendar=${JSON.stringify(calendar)} selected=${JSON.stringify(snap.result.selectedIds)}`,
        );
      }
      const verdict = verifyWitnessAgainstSnapshot(w, snap, jobs);
      expect(verdict.ok, `trial ${trial}: ${verdict.ok ? '' : verdict.reason}`).toBe(true);
      const peak = expectCellByCell(w, jobs, calendar, cap);
      expect(peak).toBe(snap.result.peakOccupancy);

      // 相邻片段不得再合并
      for (let i = 1; i < w.segments.length; i++) {
        const a = w.segments[i - 1];
        const b = w.segments[i];
        expect(a.end).toBe(b.start);
        const sameCap = a.capacity === b.capacity;
        const sameIds = JSON.stringify(a.jobIds) === JSON.stringify(b.jobIds);
        expect(sameCap && sameIds).toBe(false);
      }
    }
    expect(ran).toBeGreaterThan(60);
    expect(withCalendar).toBeGreaterThan(40);
  });
});

describe('容量占用见证：只属于生成它的 dataId / 版本 / 入选集合', () => {
  const jobs = makeJobs([
    ['a', 0, 10, 5],
    ['b', 0, 10, 7],
  ]);
  const snap = snapshotFrom('data-A', 1, jobs, 1);
  const w = witnessFromSnapshot(snap, jobs);

  it('三要素一致才配套', () => {
    expect(witnessMatchesSnapshot(w, snap)).toBe(true);
    expect(verifyWitnessAgainstSnapshot(w, snap, jobs).ok).toBe(true);
  });

  it('异身份（异身份恢复）：旧见证不配套，完整核对拒绝', () => {
    const snapB: WitnessSnapshotLike = { ...snap, workspaceDataId: 'data-B' };
    expect(witnessMatchesSnapshot(w, snapB)).toBe(false);
    const verdict = verifyWitnessAgainstSnapshot(w, snapB, jobs);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('身份');
  });

  it('约束变化后版本不同：旧见证不得附到新方案', () => {
    const snapV2: WitnessSnapshotLike = { ...snap, workspaceVersion: 2 };
    expect(witnessMatchesSnapshot(w, snapV2)).toBe(false);
    const verdict = verifyWitnessAgainstSnapshot(w, snapV2, jobs);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('版本');
  });

  it('入选集合不同（新方案）：旧见证拒绝', () => {
    // cap=1 下求解选 b；伪造一个选 a 的“新方案”快照，旧见证必须被挡
    const newResult = {
      ...snap.result,
      selectedIds: ['a'],
      totalBenefit: 5,
      peakOccupancy: 1,
      selectedCount: 1,
    };
    const snapNew: WitnessSnapshotLike = { ...snap, result: newResult };
    expect(witnessMatchesSnapshot(w, snapNew)).toBe(false);
    const verdict = verifyWitnessAgainstSnapshot(w, snapNew, jobs);
    expect(verdict.ok).toBe(false);
  });

  it('篡改片段（占用数/余量/作业清单）：完整核对拒绝', () => {
    const tampered: CapacityWitness = {
      ...w,
      segments: w.segments.map((s) => ({ ...s })),
    };
    tampered.segments[0].occupancy = 9;
    expect(verifyWitnessAgainstSnapshot(tampered, snap, jobs).ok).toBe(false);

    const tampered2: CapacityWitness = {
      ...w,
      segments: w.segments.map((s) => ({ ...s, jobIds: [...s.jobIds] })),
    };
    tampered2.segments[0].jobIds = ['a']; // 实际只有 b
    expect(verifyWitnessAgainstSnapshot(tampered2, snap, jobs).ok).toBe(false);

    const tampered3: CapacityWitness = {
      ...w,
      segments: w.segments.map((s) => ({ ...s })),
    };
    tampered3.segments[0].spare = 99;
    expect(verifyWitnessAgainstSnapshot(tampered3, snap, jobs).ok).toBe(false);
  });

  it('伪造未合并的相邻同集合同容量片段：拒绝', () => {
    const jobs2 = makeJobs([['a', 0, 10, 5]]);
    const snap2 = snapshotFrom('d-merge', 1, jobs2, 2);
    const w2 = witnessFromSnapshot(snap2, jobs2);
    expect(w2.segments).toHaveLength(1);
    const split: CapacityWitness = {
      ...w2,
      segments: [
        { ...w2.segments[0], end: 5, spare: 1 },
        { ...w2.segments[0], start: 5, end: 10, spare: 1 },
      ],
    };
    expect(verifyWitnessAgainstSnapshot(split, snap2, jobs2).ok).toBe(false);
  });

  it('kind / 版本标记不符：拒绝', () => {
    const badKind = { ...w, kind: 'something-else' } as unknown as CapacityWitness;
    expect(verifyWitnessAgainstSnapshot(badKind, snap, jobs).ok).toBe(false);
    const badVer = { ...w, witnessVersion: 9 } as unknown as CapacityWitness;
    expect(verifyWitnessAgainstSnapshot(badVer, snap, jobs).ok).toBe(false);
  });
});

describe('容量占用见证：生成失败不得伪装成可下发结果', () => {
  it('selectedIds 引用不存在的作业：直接抛 WitnessError', () => {
    const jobs = makeJobs([['a', 0, 10, 5]]);
    expect(() =>
      buildOccupancyWitness({
        dataId: 'd',
        version: 1,
        selectedIds: ['ghost'],
        jobs,
        capacity: 2,
        calendar: [],
      }),
    ).toThrow(WitnessError);
  });

  it('入选集合含重复 id：抛错', () => {
    const jobs = makeJobs([['a', 0, 10, 5]]);
    expect(() =>
      buildOccupancyWitness({
        dataId: 'd',
        version: 1,
        selectedIds: ['a', 'a'],
        jobs,
        capacity: 2,
        calendar: [],
      }),
    ).toThrow(WitnessError);
  });

  it('dataId 缺失/空、版本非正、capacity 越界：抛错', () => {
    const jobs = makeJobs([['a', 0, 10, 5]]);
    const base = { selectedIds: ['a'], jobs, capacity: 2, calendar: [] };
    expect(() => buildOccupancyWitness({ ...base, dataId: '', version: 1 })).toThrow(WitnessError);
    expect(() => buildOccupancyWitness({ ...base, dataId: 'd', version: 0 })).toThrow(WitnessError);
    expect(() => buildOccupancyWitness({ ...base, dataId: 'd', version: 1, capacity: 9 })).toThrow(
      WitnessError,
    );
  });

  it('日历重叠 / available 越界：抛错', () => {
    const jobs = makeJobs([['a', 0, 20, 5]]);
    expect(() =>
      buildOccupancyWitness({
        dataId: 'd',
        version: 1,
        selectedIds: ['a'],
        jobs,
        capacity: 2,
        calendar: [
          { start: 0, end: 12, available: 1 },
          { start: 10, end: 20, available: 0 },
        ],
      }),
    ).toThrow(WitnessError);
    expect(() =>
      buildOccupancyWitness({
        dataId: 'd',
        version: 1,
        selectedIds: ['a'],
        jobs,
        capacity: 2,
        calendar: [{ start: 0, end: 10, available: 2 }],
      }),
    ).toThrow(WitnessError);
  });
});

describe('容量占用见证：与下载 JSON 同源、旧格式下载兼容', () => {
  it('下载 JSON 的 occupancyWitness 就是页面见证同一对象，且可被重新核对', () => {
    const jobs = makeJobs([
      ['a', 0, 10, 5],
      ['b', 10, 20, 7],
    ]);
    const calendar: CapacityCalendarSegment[] = [{ start: 0, end: 10, available: 1 }];
    const snap = snapshotFrom('dl-1', 3, jobs, 2, calendar);
    const w = witnessFromSnapshot(snap, jobs);
    const payload = buildResultJson(snap, null, null, w);

    expect(payload.occupancyWitness).toBe(w);
    expect(payload.occupancyWitness!.workspaceDataId).toBe('dl-1');
    expect(payload.occupancyWitness!.workspaceVersion).toBe(3);
    expect(payload.dataId).toBe('dl-1');
    // 模拟“下载文件被重新读入”：用其中的见证对快照再核对
    const roundTrip = JSON.parse(JSON.stringify(payload));
    expect(verifyWitnessAgainstSnapshot(roundTrip.occupancyWitness, snap, jobs).ok).toBe(true);
  });

  it('旧格式下载：不传 witness 时结构不变（无 occupancyWitness 字段）', () => {
    const jobs = makeJobs([['a', 0, 10, 5]]);
    const snap = snapshotFrom('dl-old', 1, jobs, 2);
    const payload = buildResultJson(snap);
    expect('occupancyWitness' in payload).toBe(false);
    expect('reference' in payload).toBe(false);
    expect(payload.selectedIds).toEqual(['a']);
  });

  it('异身份/异版本/异集合的见证附到快照下载：buildResultJson 直接抛错（失败关闭）', () => {
    const jobs = makeJobs([
      ['a', 0, 10, 5],
      ['b', 0, 10, 7],
    ]);
    const snapA = snapshotFrom('A', 1, jobs, 1);
    const wA = witnessFromSnapshot(snapA, jobs);

    const snapB: StoredSnapshot = { ...snapA, workspaceDataId: 'B' };
    expect(() => buildResultJson(snapB, null, null, wA)).toThrow();

    const snapV2: StoredSnapshot = { ...snapA, workspaceVersion: 2 };
    expect(() => buildResultJson(snapV2, null, null, wA)).toThrow();

    // 同身份同版本但见证 selectedIds 与快照结果不一致
    const changed: StoredSnapshot = {
      ...snapA,
      result: { ...snapA.result, selectedIds: ['a'], selectedCount: 1, totalBenefit: 5 },
    };
    expect(() => buildResultJson(changed, null, null, wA)).toThrow();
  });

  it('参考方案与见证同时存在：下载 JSON 两者均在，且各自与屏幕同快照', () => {
    const jobs = makeJobs([
      ['a', 0, 10, 5],
      ['b', 10, 20, 7],
    ]);
    const snap = snapshotFrom('dl-ref', 1, jobs, 2);
    const w = witnessFromSnapshot(snap, jobs);
    // 直接验证结构（参考差异在别处已专项测试）
    const payload = buildResultJson(snap, null, null, w);
    expect(payload.occupancyWitness).toBe(w);
    expect('reference' in payload).toBe(false);
  });
});

describe('容量占用见证：恢复一致性与 Worker 迟到防护', () => {
  it('同身份恢复的快照：按恢复数据重新生成的见证与下载一致', () => {
    const jobs = makeJobs([
      ['a', 0, 5, 5],
      ['b', 3, 8, 6],
      ['c', 8, 12, 9],
    ]);
    const calendar: CapacityCalendarSegment[] = [{ start: 3, end: 6, available: 1 }];
    const snap = snapshotFrom('restore-1', 2, jobs, 2, calendar);
    // 见证只依赖快照 + 当前工作区作业；“恢复后”再生成应与初次完全一致
    const w1 = witnessFromSnapshot(snap, jobs);
    const w2 = witnessFromSnapshot(snap, jobs);
    expect(JSON.stringify(w1.segments)).toBe(JSON.stringify(w2.segments));
    expect(verifyWitnessAgainstSnapshot(w1, snap, jobs).ok).toBe(true);
    expect(verifyWitnessAgainstSnapshot(w2, snap, jobs).ok).toBe(true);
    const payload = buildResultJson(snap, null, null, w1);
    expect(payload.occupancyWitness).toBe(w1);
  });

  it('旧版本（同身份）快照的见证不会被附到当前版本下载（版本闸门）', () => {
    // 模拟约束变化：工作区已到 v3，快照仍是 v1（界面标记“已过期”）。
    // 见证绑定 v1：对 v1 快照它合法，但绝不能用在 v3 的任何下载上。
    const jobs = makeJobs([['a', 0, 10, 5]]);
    const snapV1 = snapshotFrom('same-id', 1, jobs, 2);
    const wV1 = witnessFromSnapshot(snapV1, jobs);
    const currentV3: StoredSnapshot = { ...snapV1, workspaceVersion: 3 };
    expect(witnessMatchesSnapshot(wV1, currentV3)).toBe(false);
    expect(() => buildResultJson(currentV3, null, null, wV1)).toThrow();
    // 对其“来源版本”仍合法（旧结果自身可查看/下载，不冒充新结果）
    expect(verifyWitnessAgainstSnapshot(wV1, snapV1, jobs).ok).toBe(true);
  });

  it('Worker 迟到响应：requestId 闸门丢弃，旧见证不可能为其生成', () => {
    // A（旧约束）求解时用户改了约束触发 B：latestRequestId 前移
    const jobsA = makeJobs([['a', 0, 10, 5]]);
    const jobsB = makeJobs([
      ['b', 0, 10, 6],
      ['c', 10, 20, 8],
    ]);
    const snapA = snapshotFrom('race', 1, jobsA, 1);
    // A 迟到成功响应在最新请求 2 上被丢弃
    const lateResponse = { type: 'success' as const, requestId: 1, dataId: 'race', result: snapA.result, elapsedMs: 1 };
    expect(isCurrentResponse(lateResponse, 2)).toBe(false);
    // 因此能落地的只有 B 的快照；即便持有 A 的见证，也与 B 不配套
    const snapB = snapshotFrom('race', 2, jobsB, 2);
    const wA = witnessFromSnapshot(snapA, jobsA);
    expect(verifyWitnessAgainstSnapshot(wA, snapB, jobsB).ok).toBe(false);
    expect(() => buildResultJson(snapB, null, null, wA)).toThrow();
    // B 必须用自己的见证
    const wB = witnessFromSnapshot(snapB, jobsB);
    expect(verifyWitnessAgainstSnapshot(wB, snapB, jobsB).ok).toBe(true);
  });
});

describe('容量占用见证：界面片段定位（半开二分）', () => {
  const jobs = makeJobs([
    ['a', 0, 5, 5],
    ['b', 5, 15, 6],
    ['c', 15, 20, 7],
  ]);
  const calendar: CapacityCalendarSegment[] = [{ start: 5, end: 15, available: 0 }];
  const snap = snapshotFrom('loc', 1, jobs, 2, calendar);
  const w = witnessFromSnapshot(snap, jobs);
  // 片段：[0,5) cap2 、[5,15) cap0、[15,20) cap2
  it('各片段内部时刻与边界时刻定位正确（右端点归后一片段）', () => {
    expect(w.segments.map((s) => [s.start, s.end])).toEqual([
      [0, 5],
      [5, 15],
      [15, 20],
    ]);
    expect(locateSegmentIndex(w.segments, 0)).toBe(0);
    expect(locateSegmentIndex(w.segments, 4)).toBe(0);
    expect(locateSegmentIndex(w.segments, 5)).toBe(1); // 相接点归后一片段
    expect(locateSegmentIndex(w.segments, 14)).toBe(1);
    expect(locateSegmentIndex(w.segments, 15)).toBe(2);
    expect(locateSegmentIndex(w.segments, 19)).toBe(2);
  });

  it('覆盖域外（含末端点、起点之前）定位为 -1', () => {
    expect(locateSegmentIndex(w.segments, 20)).toBe(-1); // 末端点不属于任何片段
    expect(locateSegmentIndex(w.segments, 21)).toBe(-1);
    expect(locateSegmentIndex(w.segments, -1)).toBe(-1);
    expect(locateSegmentIndex([], 0)).toBe(-1);
  });
});

describe('容量占用见证：5 万作业性能与 JSON 往返', () => {
  function mulberry32(seed: number) {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('5 万作业生成见证在 3 秒内完成且逐片段合法', () => {
    // 与 calendarSolver 性能用例同构的稀疏随机作业，保证求解与见证都不退化
    const rand = mulberry32(2026100101);
    const n = 50_000;
    const cap = 4;
    const solverJobs: SolverJob[] = [];
    for (let i = 0; i < n; i++) {
      const s = Math.floor(rand() * 1_000_000_000);
      const len = 1 + Math.floor(rand() * 1_000_000);
      solverJobs.push({
        id: `job-${i}`,
        start: s,
        end: Math.min(1_000_000_000, s + len),
        benefit: 1 + Math.floor(rand() * 1_000_000_000),
        status: 'normal',
      });
    }
    const calendar: CapacityCalendarSegment[] = [
      { start: 100_000_000, end: 200_000_000, available: 2 },
      { start: 250_000_000, end: 350_000_000, available: 1 },
      { start: 400_000_000, end: 410_000_000, available: 0 },
    ];
    const snap = snapshotFrom('perf', 1, solverJobs, cap, calendar);
    const jobObjs: Job[] = solverJobs.map((j) => ({ ...j }));
    const tBuild = performance.now();
    const w = witnessFromSnapshot(snap, jobObjs);
    const buildMs = performance.now() - tBuild;
    // 见证生成本身（不含求解）必须秒级
    expect(buildMs).toBeLessThan(3000);

    const tVerify = performance.now();
    const verdict = verifyWitnessAgainstSnapshot(w, snap, jobObjs);
    const verifyMs = performance.now() - tVerify;
    expect(verdict.ok).toBe(true);
    expect(verifyMs).toBeLessThan(3000);

    // JSON 往返后仍合法
    const back = JSON.parse(JSON.stringify(w)) as CapacityWitness;
    expect(verifyWitnessAgainstSnapshot(back, snap, jobObjs).ok).toBe(true);
    // 所有片段占用不超过有效容量，峰值与结果一致
    let peak = 0;
    for (const s of w.segments) {
      expect(s.occupancy).toBeLessThanOrEqual(s.capacity);
      expect(s.spare).toBe(s.capacity - s.occupancy);
      peak = Math.max(peak, s.occupancy);
    }
    expect(peak).toBe(snap.result.peakOccupancy);
  });
});
