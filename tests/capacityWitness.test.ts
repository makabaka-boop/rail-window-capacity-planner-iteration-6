import { describe, expect, it } from 'vitest';
import {
  buildCapacityWitness,
  verifyCapacityWitness,
  WitnessError,
  type CapacityWitness,
} from '../src/core/witness';
import { solve, type SolverJob } from '../src/core/solver';
import type { CapacityCalendarSegment } from '../src/core/types';

interface J {
  id: string;
  start: number;
  end: number;
  benefit?: number;
}

function jobs(raw: J[]): SolverJob[] {
  return raw.map((j) => ({
    id: j.id,
    start: j.start,
    end: j.end,
    benefit: j.benefit ?? 1,
    status: 'normal',
  }));
}

function witnessFor(
  rawJobs: J[],
  selectedIds: string[],
  capacity = 2,
  calendar: CapacityCalendarSegment[] = [],
): CapacityWitness {
  const all = jobs(rawJobs);
  return buildCapacityWitness({
    jobs: all,
    capacity,
    calendar,
    selectedIds,
    workspaceDataId: 'data-test',
    workspaceVersion: 1,
    solvedAt: '2026-10-01T00:00:00.000Z',
  });
}

/**
 * 独立参考实现：用「入选作业端点 + 日历端点」逐格计数（先结束后开始），
 * 再按 (有效容量, 活动 id 集合) 合并相邻格，与见证产物逐段核对。
 */
function bruteSegments(
  rawJobs: J[],
  selectedIds: string[],
  capacity: number,
  calendar: CapacityCalendarSegment[],
) {
  const byId = new Map(rawJobs.map((j) => [j.id, j]));
  const chosen = selectedIds.map((id) => byId.get(id)!);
  const coordSet = new Set<number>();
  chosen.forEach((j) => {
    coordSet.add(j.start);
    coordSet.add(j.end);
  });
  calendar.forEach((s) => {
    coordSet.add(s.start);
    coordSet.add(s.end);
  });
  const coords = [...coordSet].sort((a, b) => a - b);
  const capAt = (lo: number) => {
    for (const seg of calendar) if (seg.start <= lo && lo < seg.end) return seg.available;
    return capacity;
  };

  const cells: { start: number; end: number; cap: number; ids: string[] }[] = [];
  const active = new Set<string>();
  for (let p = 0; p < coords.length - 1; p++) {
    // 坐标 p 处先结束后开始
    for (const j of chosen) if (j.end === coords[p]) active.delete(j.id);
    for (const j of chosen) if (j.start === coords[p]) active.add(j.id);
    cells.push({
      start: coords[p],
      end: coords[p + 1],
      cap: capAt(coords[p]),
      ids: chosen
        .filter((j) => active.has(j.id))
        .sort((a, b) => a.start - b.start || a.end - b.end || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((j) => j.id),
    });
  }

  const merged: typeof cells = [];
  for (const cell of cells) {
    const prev = merged[merged.length - 1];
    const sameSet =
      prev &&
      prev.ids.length === cell.ids.length &&
      prev.ids.every((id, i) => id === cell.ids[i]);
    if (prev && prev.cap === cell.cap && prev.end === cell.start && sameSet) {
      prev.end = cell.end;
    } else {
      merged.push({ ...cell, ids: [...cell.ids] });
    }
  }
  return merged;
}

function expectMatchesBrute(
  witness: CapacityWitness,
  rawJobs: J[],
  selectedIds: string[],
  capacity: number,
  calendar: CapacityCalendarSegment[],
) {
  const expected = bruteSegments(rawJobs, selectedIds, capacity, calendar);
  expect(witness.segments).toHaveLength(expected.length);
  witness.segments.forEach((seg, i) => {
    const e = expected[i];
    expect(seg.start).toBe(e.start);
    expect(seg.end).toBe(e.end);
    expect(seg.capacity).toBe(e.cap);
    expect(seg.occupancy).toBe(e.ids.length);
    expect(seg.spare).toBe(e.cap - e.ids.length);
    expect(seg.jobIds).toEqual(e.ids);
  });
}

describe('容量占用见证：小时间轴逐格计数', () => {
  it('端点相接：a=[0,10) 与 b=[10,20) 不同格活动，各自占用 1', () => {
    const raw = [
      { id: 'a', start: 0, end: 10 },
      { id: 'b', start: 10, end: 20 },
    ];
    const w = witnessFor(raw, ['a', 'b'], 2);
    // 同一容量（2）且活动集合相同（{a} 与 {b} 是不同集合）=> 两段，不合并
    expect(w.segments).toEqual([
      { start: 0, end: 10, capacity: 2, occupancy: 1, spare: 1, jobIds: ['a'] },
      { start: 10, end: 20, capacity: 2, occupancy: 1, spare: 1, jobIds: ['b'] },
    ]);
  });

  it('完全重叠：两项 [0,10) 同格活动，容量 2 余量 0', () => {
    const raw = [
      { id: 'a', start: 0, end: 10 },
      { id: 'b', start: 0, end: 10 },
    ];
    const w = witnessFor(raw, ['a', 'b'], 2);
    expect(w.segments).toEqual([
      { start: 0, end: 10, capacity: 2, occupancy: 2, spare: 0, jobIds: ['a', 'b'] },
    ]);
  });

  it('零容量格：日历封闭段片段保留，占用 0、余量 0，跨段作业不能入选（由求解器保证）', () => {
    const raw = [
      { id: 'before', start: 0, end: 5 },
      { id: 'after', start: 15, end: 20 },
    ];
    const calendar: CapacityCalendarSegment[] = [{ start: 5, end: 15, available: 0 }];
    const w = witnessFor(raw, ['before', 'after'], 2, calendar);
    // 端点：0,5,15,20；[0,5) cap2 {before}；[5,15) cap0 {}；[15,20) cap2 {after}
    // 三段活动集合各不相同 => 不合并；封闭段 cap0 与两侧 cap2 也不同
    expect(w.segments).toEqual([
      { start: 0, end: 5, capacity: 2, occupancy: 1, spare: 1, jobIds: ['before'] },
      { start: 5, end: 15, capacity: 0, occupancy: 0, spare: 0, jobIds: [] },
      { start: 15, end: 20, capacity: 2, occupancy: 1, spare: 1, jobIds: ['after'] },
    ]);
  });

  it('相邻两个零容量日历片段（中间无作业端点）合并为一个封闭片段', () => {
    const raw = [{ id: 'a', start: 0, end: 5 }];
    const calendar: CapacityCalendarSegment[] = [
      { start: 5, end: 10, available: 0 },
      { start: 10, end: 15, available: 0 },
    ];
    const w = witnessFor(raw, ['a'], 3, calendar);
    expect(w.segments).toEqual([
      { start: 0, end: 5, capacity: 3, occupancy: 1, spare: 2, jobIds: ['a'] },
      { start: 5, end: 15, capacity: 0, occupancy: 0, spare: 0, jobIds: [] },
    ]);
  });

  it('跨日历端点的同一活动集合：两侧容量相等时合并（日历边界不强制断开）', () => {
    // a=[0,20) 横跨日历边界；[0,10) 与 [10,20) 都压到 1 => 活动集合都是 {a}，合并
    const raw = [{ id: 'a', start: 0, end: 20 }];
    const calendar: CapacityCalendarSegment[] = [
      { start: 0, end: 10, available: 1 },
      { start: 10, end: 20, available: 1 },
    ];
    const w = witnessFor(raw, ['a'], 2, calendar);
    expect(w.segments).toEqual([
      { start: 0, end: 20, capacity: 1, occupancy: 1, spare: 0, jobIds: ['a'] },
    ]);
  });

  it('跨日历端点但容量不同：必须断开成两段（同活动集合也不合并）', () => {
    const raw = [{ id: 'a', start: 0, end: 20 }];
    const calendar: CapacityCalendarSegment[] = [{ start: 10, end: 20, available: 1 }];
    const w = witnessFor(raw, ['a'], 2, calendar);
    expect(w.segments).toEqual([
      { start: 0, end: 10, capacity: 2, occupancy: 1, spare: 1, jobIds: ['a'] },
      { start: 10, end: 20, capacity: 1, occupancy: 1, spare: 0, jobIds: ['a'] },
    ]);
  });

  it('作业之间的空段（空闲间隙）不与相邻活动段合并：活动集合不同', () => {
    const raw = [
      { id: 'a', start: 0, end: 10 },
      { id: 'b', start: 20, end: 30 },
    ];
    const w = witnessFor(raw, ['a', 'b'], 2);
    // 端点 0,10,20,30：{a}、{}、{b} 三段
    expect(w.segments).toEqual([
      { start: 0, end: 10, capacity: 2, occupancy: 1, spare: 1, jobIds: ['a'] },
      { start: 10, end: 20, capacity: 2, occupancy: 0, spare: 2, jobIds: [] },
      { start: 20, end: 30, capacity: 2, occupancy: 1, spare: 1, jobIds: ['b'] },
    ]);
  });

  it('同一集合在长区间内持续（内部无任何端点）：跨日历外区域合并为一段', () => {
    // 一项 [0,40) 长作业，日历 [10,30) 压到 1
    const raw = [{ id: 'a', start: 0, end: 40 }];
    const calendar: CapacityCalendarSegment[] = [{ start: 10, end: 30, available: 1 }];
    const w = witnessFor(raw, ['a'], 2, calendar);
    expect(w.segments).toEqual([
      { start: 0, end: 10, capacity: 2, occupancy: 1, spare: 1, jobIds: ['a'] },
      { start: 10, end: 30, capacity: 1, occupancy: 1, spare: 0, jobIds: ['a'] },
      { start: 30, end: 40, capacity: 2, occupancy: 1, spare: 1, jobIds: ['a'] },
    ]);
  });

  it('活动作业稳定排序：同时刻开始按 end 再按 id；包含关系都正确', () => {
    const raw = [
      { id: 'z', start: 0, end: 20 },
      { id: 'b', start: 0, end: 10 },
      { id: 'a', start: 0, end: 10 },
    ];
    const w = witnessFor(raw, ['z', 'b', 'a'], 3);
    // 端点 0,10,20：[0,10) 三项活动，按 (start,end,id)：a,b 同时刻按 id；z 后结束
    expect(w.segments[0].jobIds).toEqual(['a', 'b', 'z']);
    expect(w.segments[1].jobIds).toEqual(['z']);
  });

  it('片段在时间轴上首尾相接、无空隙无重叠', () => {
    const raw = [
      { id: 'a', start: 0, end: 10 },
      { id: 'b', start: 5, end: 25 },
      { id: 'c', start: 30, end: 40 },
    ];
    const calendar: CapacityCalendarSegment[] = [{ start: 10, end: 20, available: 1 }];
    const w = witnessFor(raw, ['a', 'b', 'c'], 2, calendar);
    for (let i = 1; i < w.segments.length; i++) {
      expect(w.segments[i].start).toBe(w.segments[i - 1].end);
    }
    expect(w.segments[0].start).toBe(0);
    expect(w.segments[w.segments.length - 1].end).toBe(40);
    expectMatchesBrute(w, raw, ['a', 'b', 'c'], 2, calendar);
  });
});

describe('容量占用见证：与独立逐格计数 + 合并参考实现一致', () => {
  it('一组交错作业 + 压容/封闭日历，逐段等于暴力实现（选用日历下可行的集合）', () => {
    const raw = [
      { id: 'a', start: 0, end: 12 },
      { id: 'b', start: 4, end: 10 },
      { id: 'c', start: 10, end: 20 },
      { id: 'd', start: 14, end: 24 },
      { id: 'e', start: 30, end: 40 },
    ];
    const calendar: CapacityCalendarSegment[] = [
      { start: 6, end: 14, available: 1 },
      { start: 24, end: 30, available: 0 },
    ];
    // 可行集合：[6,10) 内 a、b 重叠而该段压到 1，故只保留 a；
    // [10,14) 内 a、c 重叠同样限 1，故去掉 c；d=[14,24) 不与压容段重叠。
    const selected = ['a', 'd', 'e'];
    const w = witnessFor(raw, selected, 2, calendar);
    expectMatchesBrute(w, raw, selected, 2, calendar);
  });

  it('求解器真实结果（交错作业 + 压容/封闭日历）：见证逐段等于暴力实现', () => {
    const raw = [
      { id: 'a', start: 0, end: 12, benefit: 5 },
      { id: 'b', start: 4, end: 10, benefit: 9 },
      { id: 'c', start: 10, end: 20, benefit: 7 },
      { id: 'd', start: 14, end: 24, benefit: 6 },
      { id: 'e', start: 30, end: 40, benefit: 8 },
    ];
    const calendar: CapacityCalendarSegment[] = [
      { start: 6, end: 14, available: 1 },
      { start: 24, end: 30, available: 0 },
    ];
    const r = solve(jobs(raw), 2, calendar);
    const w = witnessFor(raw, r.selectedIds, 2, calendar);
    expectMatchesBrute(w, raw, r.selectedIds, 2, calendar);
    // 封闭段 [24,30) 不得有任何入选作业跨越
    for (const id of r.selectedIds) {
      const j = raw.find((x) => x.id === id)!;
      expect(j.start >= 30 || j.end <= 24).toBe(true);
    }
  });

  it('求解器真实结果：日历封闭段两侧方案的见证逐格核对', () => {
    const all = jobs([
      { id: 'cross', start: 0, end: 20, benefit: 1000 },
      { id: 'e', start: 0, end: 5, benefit: 9 },
      { id: 'f', start: 15, end: 20, benefit: 8 },
    ]);
    const calendar: CapacityCalendarSegment[] = [{ start: 5, end: 15, available: 0 }];
    const r = solve(all, 2, calendar);
    const w = witnessFor(
      all.map((j) => ({ id: j.id, start: j.start, end: j.end })),
      r.selectedIds,
      2,
      calendar,
    );
    expect(r.selectedIds.sort()).toEqual(['e', 'f']);
    expectMatchesBrute(
      w,
      all.map((j) => ({ id: j.id, start: j.start, end: j.end })),
      r.selectedIds,
      2,
      calendar,
    );
  });
});

describe('容量占用见证：空集合边界', () => {
  it('无入选且无日历：没有片段（时间轴为空）', () => {
    const w = witnessFor([{ id: 'a', start: 0, end: 10 }], [], 2);
    expect(w.segments).toEqual([]);
    expect(w.selectedIds).toEqual([]);
  });

  it('无入选但有日历：仅由日历端点切分，片段保留（含封闭段）', () => {
    const w = witnessFor(
      [{ id: 'a', start: 0, end: 20 }],
      [],
      2,
      [{ start: 5, end: 15, available: 0 }],
    );
    // 端点 5,15（入选端点为空）：只描述封闭段本身
    expect(w.segments).toEqual([
      { start: 5, end: 15, capacity: 0, occupancy: 0, spare: 0, jobIds: [] },
    ]);
  });

  it('日历之外的空时间轴不产生片段：见证只覆盖端点张成的范围', () => {
    const w = witnessFor(
      [{ id: 'a', start: 100, end: 200 }],
      [],
      2,
      [{ start: 120, end: 180, available: 1 }],
    );
    expect(w.segments).toEqual([
      { start: 120, end: 180, capacity: 1, occupancy: 0, spare: 1, jobIds: [] },
    ]);
  });
});

describe('容量占用见证：自检与非法输入', () => {
  it('verifyCapacityWitness：身份/版本/容量/日历/集合一致且逐段重建一致 => true', () => {
    const raw = [
      { id: 'a', start: 0, end: 10 },
      { id: 'b', start: 0, end: 10 },
    ];
    const w = witnessFor(raw, ['a', 'b'], 2);
    expect(
      verifyCapacityWitness(w, {
        dataId: 'data-test',
        version: 1,
        capacity: 2,
        calendar: [],
        jobs: jobs(raw),
        selectedIds: ['a', 'b'],
      }),
    ).toBe(true);
  });

  it('异 dataId / 异版本 / 异容量 / 异日历 / 异入选集合：自检 false', () => {
    const raw = [
      { id: 'a', start: 0, end: 10 },
      { id: 'b', start: 0, end: 10 },
    ];
    const w = witnessFor(raw, ['a', 'b'], 2);
    const ctx = {
      dataId: 'data-test',
      version: 1,
      capacity: 2,
      calendar: [] as CapacityCalendarSegment[],
      jobs: jobs(raw),
      selectedIds: ['a', 'b'] as string[],
    };
    expect(verifyCapacityWitness(w, { ...ctx, dataId: 'other' })).toBe(false);
    expect(verifyCapacityWitness(w, { ...ctx, version: 2 })).toBe(false);
    expect(verifyCapacityWitness(w, { ...ctx, capacity: 1 })).toBe(false);
    expect(
      verifyCapacityWitness(w, { ...ctx, calendar: [{ start: 0, end: 10, available: 1 }] }),
    ).toBe(false);
    expect(verifyCapacityWitness(w, { ...ctx, selectedIds: ['a'] })).toBe(false);
    // 同集合但顺序不同也判 false：见证绑定的是有序入选集合
    expect(verifyCapacityWitness(w, { ...ctx, selectedIds: ['b', 'a'] })).toBe(false);
  });

  it('片段被篡改（余量/占用/容量/作业清单）：自检重建后为 false', () => {
    const raw = [
      { id: 'a', start: 0, end: 10 },
      { id: 'b', start: 0, end: 10 },
    ];
    const ctx = {
      dataId: 'data-test',
      version: 1,
      capacity: 2,
      calendar: [] as CapacityCalendarSegment[],
      jobs: jobs(raw),
      selectedIds: ['a', 'b'],
    };
    const tamper = (seg: (typeof w.segments)[number]): CapacityWitness => ({
      ...w,
      segments: [{ ...seg }],
    });
    const w = witnessFor(raw, ['a', 'b'], 2);
    expect(verifyCapacityWitness(tamper({ ...w.segments[0], spare: 1 }), ctx)).toBe(false);
    expect(
      verifyCapacityWitness(tamper({ ...w.segments[0], occupancy: 1, jobIds: ['a'] }), ctx),
    ).toBe(false);
    expect(verifyCapacityWitness(tamper({ ...w.segments[0], capacity: 1 }), ctx)).toBe(false);
    expect(
      verifyCapacityWitness(
        tamper({ ...w.segments[0], jobIds: ['b', 'a'] }),
        ctx,
      ),
    ).toBe(false);
  });

  it('selectedIds 引用不存在的作业 / 重复 id：抛 WitnessError，不产出见证', () => {
    const raw = [{ id: 'a', start: 0, end: 10 }];
    expect(() => witnessFor(raw, ['ghost'])).toThrow(WitnessError);
    expect(() => witnessFor(raw, ['a', 'a'], 2)).toThrow(WitnessError);
  });

  it('占用超过有效容量（伪造入选集合）：抛 WitnessError，结果不得下发', () => {
    const raw = [
      { id: 'a', start: 0, end: 10 },
      { id: 'b', start: 0, end: 10 },
    ];
    expect(() => witnessFor(raw, ['a', 'b'], 1)).toThrow(WitnessError);
    // 日历压容后超限同样拒绝
    expect(() =>
      witnessFor(raw, ['a', 'b'], 2, [{ start: 0, end: 10, available: 1 }]),
    ).toThrow(WitnessError);
  });

  it('缺 dataId / 版本非法 / 容量非法：抛 WitnessError', () => {
    const raw = [{ id: 'a', start: 0, end: 10 }];
    const base = {
      jobs: jobs(raw),
      capacity: 2,
      calendar: [] as CapacityCalendarSegment[],
      selectedIds: ['a'],
      solvedAt: 't',
    };
    expect(() =>
      buildCapacityWitness({ ...base, workspaceDataId: '', workspaceVersion: 1 }),
    ).toThrow(WitnessError);
    expect(() =>
      buildCapacityWitness({ ...base, workspaceDataId: 'd', workspaceVersion: 0 }),
    ).toThrow(WitnessError);
    expect(() =>
      buildCapacityWitness({ ...base, workspaceDataId: 'd', workspaceVersion: 1, capacity: 9 }),
    ).toThrow(WitnessError);
  });
});

describe('容量占用见证：5 万作业量级', () => {
  it('5 万入选作业的见证构建在 3 秒内完成且片段全部自洽', () => {
    const rand = mulberry32(20261001);
    const cap = 4;
    const all: J[] = [];
    for (let i = 0; i < 50_000; i++) {
      const s = Math.floor(rand() * 1_000_000_000);
      const len = 1 + Math.floor(rand() * 1_000_000);
      all.push({ id: `job-${i}`, start: s, end: Math.min(1_000_000_000, s + len), benefit: 1 });
    }
    // 用求解器实际结果作为可行入选集合（占用逐格不超容量）
    const r = solve(jobs(all), cap, []);
    const started = performance.now();
    const w = witnessFor(all, r.selectedIds, cap, []);
    const elapsed = performance.now() - started;
    // 仅计量见证构建（求解耗时由 calendarSolver 的性能用例单独考核）
    expect(elapsed).toBeLessThan(3000);

    // 自洽性：余量非负、占用==清单长度、片段首尾相接
    let prevEnd = w.segments[0]?.start;
    for (const seg of w.segments) {
      expect(seg.occupancy).toBe(seg.jobIds.length);
      expect(seg.spare).toBe(seg.capacity - seg.occupancy);
      expect(seg.occupancy).toBeLessThanOrEqual(seg.capacity);
      expect(seg.start).toBe(prevEnd);
      prevEnd = seg.end;
    }
    // 每个入选作业至少出现在一个片段中
    const seen = new Set<string>();
    for (const seg of w.segments) for (const id of seg.jobIds) seen.add(id);
    expect(seen.size).toBe(r.selectedIds.length);
  });
});

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
