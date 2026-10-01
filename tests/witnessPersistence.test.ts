import { describe, expect, it, beforeEach } from 'vitest';
import {
  restoreSession,
  persistWorkspace,
  persistSnapshot,
  persistWitness,
  loadWitness,
  clearWitness,
  witnessMatchesSnapshot,
  buildResultJson,
  type StoredSnapshot,
} from '../src/core/persistence';
import { createWorkspace } from '../src/core/workspace';
import { buildCapacityWitness, type CapacityWitness } from '../src/core/witness';
import { computeReferenceDiff } from '../src/core/reference';
import { newDataId } from '../src/core/identity';
import { solve } from '../src/core/solver';
import type { Capacity, CapacityCalendarSegment, Workspace } from '../src/core/types';

const SNAP_KEY = 'rail-possession-scheduler:snapshot:v1';
const WITNESS_KEY = 'rail-possession-scheduler:witness:v1';

/** 每个测试使用独立的内存 localStorage 桩 */
const storage = new Map<string, string>();
beforeEach(() => {
  storage.clear();
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
    clear: () => storage.clear(),
    key: () => null,
    length: 0,
  } as Storage;
});

function makeWorkspace(
  jobList: { id: string; start: number; end: number; benefit: number }[],
  capacity: Capacity = 2,
  calendar: CapacityCalendarSegment[] = [],
): Workspace {
  return createWorkspace({ capacity, jobs: jobList, capacityCalendar: calendar });
}

function snapshotFor(workspace: Workspace, version = workspace.version): StoredSnapshot {
  const result = solve(workspace.jobs, workspace.capacity, workspace.capacityCalendar);
  return {
    workspaceDataId: workspace.dataId,
    workspaceVersion: version,
    capacity: workspace.capacity,
    capacityCalendar: workspace.capacityCalendar,
    solvedAt: '2026-10-01T08:00:00.000Z',
    result,
  };
}

function witnessFor(workspace: Workspace, snapshot: StoredSnapshot): CapacityWitness {
  return buildCapacityWitness({
    jobs: workspace.jobs,
    capacity: workspace.capacity,
    calendar: workspace.capacityCalendar,
    selectedIds: snapshot.result.selectedIds,
    workspaceDataId: workspace.dataId,
    workspaceVersion: snapshot.workspaceVersion,
    solvedAt: snapshot.solvedAt,
  });
}

function persistTriple(workspace: Workspace): { snapshot: StoredSnapshot; witness: CapacityWitness } {
  const snapshot = snapshotFor(workspace);
  const witness = witnessFor(workspace, snapshot);
  persistWorkspace(workspace);
  persistSnapshot(snapshot);
  persistWitness(witness);
  return { snapshot, witness };
}

describe('容量见证：Worker 迟到 / 新方案不得附带旧见证', () => {
  it('旧约束响应即使迟到，其见证也不能附到新约束方案（requestId 闸门 + 版本配对双保险）', () => {
    // v1 方案（两个必选会在 cap=1 下冲突，故用普通作业）
    const w = makeWorkspace([
      { id: 'a', start: 0, end: 10, benefit: 5 },
      { id: 'b', start: 10, end: 20, benefit: 6 },
    ]);
    const snapV1 = snapshotFor(w, 1);
    const witnessV1 = witnessFor(w, snapV1);

    // 用户改约束 => v2：把 b 设为必选（求解仍可行，结果可能变化）
    w.jobs[1].status = 'required';
    w.version = 2;
    persistWorkspace(w);
    const snapV2 = snapshotFor(w, 2);
    const witnessV2 = witnessFor(w, snapV2);

    // 旧请求（requestId=1）迟到返回：消息层由 isCurrentResponse 丢弃。
    // 即便它绕过消息层，v1 见证也与 v2 快照不配套：
    expect(witnessMatchesSnapshot(witnessV1, snapV2)).toBe(false);
    expect(witnessMatchesSnapshot(witnessV2, snapV1)).toBe(false);
    expect(witnessMatchesSnapshot(witnessV1, snapV1)).toBe(true);
    expect(witnessMatchesSnapshot(witnessV2, snapV2)).toBe(true);
  });

  it('两份同版本但不同 dataId 的见证：同版本号也不配对（异身份恢复直接丢弃）', () => {
    const a = makeWorkspace([{ id: 'a', start: 0, end: 10, benefit: 1 }]);
    const b = makeWorkspace([{ id: 'a', start: 0, end: 10, benefit: 2 }]); // 同 id、同 v1
    persistWorkspace(b);
    const snapA = snapshotFor(a);
    persistSnapshot(snapA); // A 的快照先残留
    persistWitness(witnessFor(a, snapA));
    // 恢复到 B：A 的快照与见证都被丢弃
    const session = restoreSession();
    expect(session.workspace!.dataId).toBe(b.dataId);
    expect(session.snapshot).toBeNull();
    expect(session.witness).toBeNull();
    expect(storage.has(SNAP_KEY)).toBe(false);
    expect(storage.has(WITNESS_KEY)).toBe(false);
  });

  it('见证生成失败（集合超容量）不得伪装成可下发结果：无见证产生，旧结果不受影响', () => {
    // 主线程落地前 buildCapacityWitness 抛错即拒绝落地；这里直接验证
    // “不存在”一份为超容集合生成的见证可供下载。
    const w = makeWorkspace([
      { id: 'a', start: 0, end: 10, benefit: 5 },
      { id: 'b', start: 0, end: 10, benefit: 6 },
    ]);
    const forged = { ...snapshotFor(w), result: { ...snapshotFor(w).result, selectedIds: ['a', 'b'] } };
    expect(() => witnessFor(w, forged as StoredSnapshot)).not.toThrow(); // cap=2 下合法
    const cap1: Workspace = { ...w, capacity: 1, jobs: w.jobs.map((j) => ({ ...j })) };
    const forgedOver = {
      ...snapshotFor(w),
      capacity: 1,
      result: { ...snapshotFor(w).result, capacity: 1, selectedIds: ['a', 'b'], selectedCount: 2 },
    };
    expect(() => witnessFor(cap1, forgedOver as StoredSnapshot)).toThrow();
  });
});

describe('容量见证：持久化与随会话恢复', () => {
  it('三键齐全且同身份同版本：见证随会话恢复，逐字段与快照配套', () => {
    const w = makeWorkspace([
      { id: 'a', start: 0, end: 10, benefit: 5 },
      { id: 'b', start: 0, end: 10, benefit: 7 },
    ]);
    const { witness } = persistTriple(w);
    const session = restoreSession();
    expect(session.snapshot).not.toBeNull();
    expect(session.witness).not.toBeNull();
    expect(session.witness!.workspaceDataId).toBe(w.dataId);
    expect(session.witness!.workspaceVersion).toBe(w.version);
    expect(session.witness!.segments).toEqual(witness.segments);
  });

  it('只有见证键（无工作区/快照）：孤儿见证整体丢弃并删除', () => {
    const w = makeWorkspace([{ id: 'a', start: 0, end: 10, benefit: 5 }]);
    const snap = snapshotFor(w);
    persistWitness(witnessFor(w, snap));
    const session = restoreSession();
    expect(session).toEqual({ workspace: null, snapshot: null, reference: null, witness: null });
    expect(storage.has(WITNESS_KEY)).toBe(false);
  });

  it('快照被接受但见证损坏：保快照、弃见证（见证不展示也不进入下载）', () => {
    const w = makeWorkspace([{ id: 'a', start: 0, end: 10, benefit: 5 }]);
    persistWorkspace(w);
    persistSnapshot(snapshotFor(w));
    storage.set(WITNESS_KEY, '{broken json');
    const session = restoreSession();
    expect(session.snapshot).not.toBeNull();
    expect(session.witness).toBeNull();
    expect(storage.has(WITNESS_KEY)).toBe(false);
  });

  it('同身份旧版本快照 + 当前版本见证：见证不得附到过期快照上（判废并清除）', () => {
    const w = makeWorkspace([{ id: 'a', start: 0, end: 10, benefit: 5 }]);
    // 快照为 v1
    const oldSnap = snapshotFor(w, 1);
    persistWorkspace(w);
    persistSnapshot(oldSnap);
    // 约束改到 v2，工作区当前版本为 2
    w.jobs[0].status = 'required';
    w.version = 2;
    persistWorkspace(w);
    // 见证却伪造为 v2 的身份/版本（与 v1 快照不配套）
    const mismatched = witnessFor(w, { ...oldSnap, workspaceVersion: 2 });
    persistWitness(mismatched);

    const session = restoreSession();
    expect(session.snapshot).not.toBeNull(); // v1 快照以“过期”保留
    expect(session.snapshot!.workspaceVersion).toBe(1);
    expect(session.witness).toBeNull(); // v2 见证绝不能附到 v1 快照
    expect(storage.has(WITNESS_KEY)).toBe(false);
  });

  it('同身份同版本但入选集合被篡改：见证与快照对不上，判废', () => {
    const w = makeWorkspace([
      { id: 'a', start: 0, end: 10, benefit: 5 },
      { id: 'b', start: 10, end: 20, benefit: 6 },
    ]);
    persistWorkspace(w);
    const snap = snapshotFor(w);
    persistSnapshot(snap);
    const bad = { ...witnessFor(w, snap), selectedIds: ['a'] };
    storage.set(WITNESS_KEY, JSON.stringify(bad));
    const session = restoreSession();
    expect(session.snapshot).not.toBeNull();
    expect(session.witness).toBeNull();
    expect(storage.has(WITNESS_KEY)).toBe(false);
  });

  it('见证片段与当前工作区作业重建不一致（改了作业时刻）：判废', () => {
    const w = makeWorkspace([{ id: 'a', start: 0, end: 10, benefit: 5 }]);
    persistWorkspace(w);
    const snap = snapshotFor(w);
    persistSnapshot(snap);
    const good = witnessFor(w, snap);
    // 工作区里的作业时刻变了（dataId/版本/集合都相同，但片段时刻对不上）
    const moved: Workspace = {
      ...w,
      jobs: [{ ...w.jobs[0], start: 2, end: 12 }],
    };
    persistWorkspace(moved);
    persistWitness(good);
    const session = restoreSession();
    // 快照自身的交叉核对（时刻参与峰值/收益）通常也会失败；即便快照侥幸通过，
    // 见证逐段重建也必然 false
    expect(session.witness).toBeNull();
  });

  it('异身份见证：恢复到 B 工作区时 A 的见证被丢弃删除', () => {
    const a = makeWorkspace([{ id: 'a1', start: 0, end: 10, benefit: 1 }]);
    const b = makeWorkspace([{ id: 'b1', start: 0, end: 10, benefit: 2 }]);
    persistWorkspace(b);
    // A 的快照 + A 的见证残留
    const snapA = snapshotFor(a);
    persistSnapshot(snapA);
    persistWitness(witnessFor(a, snapA));
    const session = restoreSession();
    expect(session.workspace!.dataId).toBe(b.dataId);
    expect(session.snapshot).toBeNull();
    expect(session.witness).toBeNull();
    expect(storage.has(SNAP_KEY)).toBe(false);
    expect(storage.has(WITNESS_KEY)).toBe(false);
  });

  it('旧格式记录（无 kind/dataId 标签）：沿用拒绝规则，不迁移、不附到旧快照', () => {
    const w = makeWorkspace([{ id: 'a', start: 0, end: 10, benefit: 5 }]);
    persistWorkspace(w);
    persistSnapshot(snapshotFor(w));
    storage.set(
      WITNESS_KEY,
      JSON.stringify({
        workspaceVersion: 1,
        capacity: 2,
        selectedIds: ['a'],
        segments: [],
      }),
    );
    const session = restoreSession();
    expect(session.snapshot).not.toBeNull();
    expect(session.witness).toBeNull();
    expect(storage.has(WITNESS_KEY)).toBe(false);
  });
});

describe('容量见证：结构校验（loadWitness / 存储）', () => {
  it('合法见证可单独加载；损坏 JSON 返回 null', () => {
    const w = makeWorkspace([{ id: 'a', start: 0, end: 10, benefit: 5 }]);
    persistWitness(witnessFor(w, snapshotFor(w)));
    expect(loadWitness()).not.toBeNull();
    storage.set(WITNESS_KEY, '{nope');
    expect(loadWitness()).toBeNull();
  });

  it('片段不首尾相接 / 余量不自洽 / 占用非数 / 引用非入选 id：整体拒绝', () => {
    const w = makeWorkspace([
      { id: 'a', start: 0, end: 10, benefit: 5 },
      { id: 'b', start: 10, end: 20, benefit: 6 },
    ]);
    const base = (): CapacityWitness => witnessFor(w, snapshotFor(w));

    // 末尾再接一段起点不等于前段终点：不首尾相接
    const w1 = base();
    w1.segments = [...w1.segments, { ...w1.segments[w1.segments.length - 1], start: 999 }];
    storage.set(WITNESS_KEY, JSON.stringify(w1));
    expect(loadWitness()).toBeNull();

    // 余量与 capacity-occupancy 不符
    const w2 = base();
    w2.segments = w2.segments.map((s, i) => (i === 0 ? { ...s, spare: s.spare + 1 } : s));
    storage.set(WITNESS_KEY, JSON.stringify(w2));
    expect(loadWitness()).toBeNull();

    // jobIds 引用了不在 selectedIds 中的 id
    const w3 = base();
    w3.segments = w3.segments.map((s, i) =>
      i === 0 ? { ...s, jobIds: [...s.jobIds, 'ghost'], occupancy: s.occupancy + 1, spare: s.spare - 1 } : s,
    );
    storage.set(WITNESS_KEY, JSON.stringify(w3));
    expect(loadWitness()).toBeNull();

    // jobIds 数量与 occupancy 不符
    const w4 = base();
    w4.segments = w4.segments.map((s, i) => (i === 0 ? { ...s, occupancy: s.occupancy + 1 } : s));
    storage.set(WITNESS_KEY, JSON.stringify(w4));
    expect(loadWitness()).toBeNull();
  });

  it('witnessVersion/kind 不符、版本非正、selectedIds 重复：拒绝', () => {
    const w = makeWorkspace([{ id: 'a', start: 0, end: 10, benefit: 5 }]);
    const good = witnessFor(w, snapshotFor(w));
    storage.set(WITNESS_KEY, JSON.stringify({ ...good, kind: 'other' }));
    expect(loadWitness()).toBeNull();
    storage.set(WITNESS_KEY, JSON.stringify({ ...good, witnessVersion: 2 }));
    expect(loadWitness()).toBeNull();
    storage.set(WITNESS_KEY, JSON.stringify({ ...good, workspaceVersion: 0 }));
    expect(loadWitness()).toBeNull();
    storage.set(WITNESS_KEY, JSON.stringify({ ...good, selectedIds: ['a', 'a'] }));
    expect(loadWitness()).toBeNull();
  });

  it('clearWitness 与存储异常安全降级', () => {
    const w = makeWorkspace([{ id: 'a', start: 0, end: 10, benefit: 5 }]);
    persistWitness(witnessFor(w, snapshotFor(w)));
    expect(loadWitness()).not.toBeNull();
    clearWitness();
    expect(loadWitness()).toBeNull();

    (globalThis as { localStorage?: Storage }).localStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    } as Storage;
    expect(() => persistWitness(witnessFor(w, snapshotFor(w)))).not.toThrow();
    expect(loadWitness()).toBeNull();
  });
});

describe('容量见证：下载 JSON 与页面使用同一见证', () => {
  it('下载文件的 capacityWitness 区块与见证对象逐字段一致', () => {
    const w = makeWorkspace(
      [
        { id: 'a', start: 0, end: 10, benefit: 5 },
        { id: 'b', start: 0, end: 10, benefit: 7 },
        { id: 'c', start: 10, end: 20, benefit: 9 },
      ],
      2,
      [{ start: 0, end: 10, available: 1 }],
    );
    const snap = snapshotFor(w);
    const witness = witnessFor(w, snap);
    const payload = buildResultJson(snap, null, null, witness);
    expect(payload.capacityWitness).toBeDefined();
    expect(payload.capacityWitness!.dataId).toBe(witness.workspaceDataId);
    expect(payload.capacityWitness!.workspaceVersion).toBe(witness.workspaceVersion);
    expect(payload.capacityWitness!.capacity).toBe(witness.capacity);
    expect(payload.capacityWitness!.capacityCalendar).toEqual(witness.capacityCalendar);
    expect(payload.capacityWitness!.selectedIds).toEqual(payload.selectedIds);
    expect(payload.capacityWitness!.segments).toEqual(witness.segments);
  });

  it('见证缺省或与快照不配套：下载结构保持原样（无 capacityWitness 字段）', () => {
    const w = makeWorkspace([{ id: 'a', start: 0, end: 10, benefit: 5 }]);
    const snap = snapshotFor(w);
    const without = buildResultJson(snap);
    expect('capacityWitness' in without).toBe(false);

    const other = witnessFor(w, { ...snap, workspaceVersion: 99 });
    const mismatched = buildResultJson(snap, null, null, other);
    expect('capacityWitness' in mismatched).toBe(false);
  });

  it('witnessMatchesSnapshot：dataId/版本/容量/日历/集合/时间戳任一不同即 false', () => {
    const w = makeWorkspace([{ id: 'a', start: 0, end: 10, benefit: 5 }]);
    const snap = snapshotFor(w);
    const witness = witnessFor(w, snap);
    expect(witnessMatchesSnapshot(witness, snap)).toBe(true);
    expect(witnessMatchesSnapshot(witness, { ...snap, workspaceDataId: newDataId() })).toBe(false);
    expect(witnessMatchesSnapshot(witness, { ...snap, workspaceVersion: 2 })).toBe(false);
    expect(witnessMatchesSnapshot(witness, { ...snap, capacity: 1 })).toBe(false);
    expect(
      witnessMatchesSnapshot(witness, {
        ...snap,
        capacityCalendar: [{ start: 0, end: 10, available: 0 }],
      }),
    ).toBe(false);
    expect(
      witnessMatchesSnapshot(witness, {
        ...snap,
        result: { ...snap.result, selectedIds: ['a', 'a-dup'] },
      }),
    ).toBe(false);
    expect(witnessMatchesSnapshot(witness, { ...snap, solvedAt: 'other-time' })).toBe(false);
  });

  it('有参考 + 有见证：reference 与 capacityWitness 区块同时存在且与各自快照同源', () => {
    // 直接验证 buildResultJson 的组合路径（参考差异计算与见证互不干扰）
    const w = makeWorkspace([
      { id: 'a', start: 0, end: 10, benefit: 5 },
      { id: 'b', start: 10, end: 20, benefit: 6 },
    ]);
    const snap = snapshotFor(w);
    const witness = witnessFor(w, snap);
    const plan = {
      workspaceDataId: w.dataId,
      workspaceVersion: 1,
      adoptedAt: '2026-10-01T09:00:00.000Z',
      members: [{ id: 'a', start: 0, end: 10 }],
    };
    const diff = computeReferenceDiff(snap.result.selectedIds, w.jobs, plan);
    const payload = buildResultJson(snap, plan, diff, witness);
    expect(payload.reference).toBeDefined();
    expect(payload.capacityWitness).toBeDefined();
    expect(payload.reference!.retained.map((m) => m.id)).toContain('a');
    expect(payload.capacityWitness!.selectedIds).toEqual(payload.selectedIds);
  });
});
