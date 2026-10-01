import { buildCapacityGrid } from './capacityCalendar';
import { newDataId, isDataId } from './identity';
import {
  normalizeReferenceMembers,
  type ReferenceDiff,
  type ReferenceMember,
  type ReferencePlan,
} from './reference';
import type { SolverResult } from './solver';
import type { Capacity, CapacityCalendarSegment, Job, JobStatus, Workspace } from './types';
import {
  verifyCapacityWitness,
  type CapacityWitness,
  type WitnessSegment,
} from './witness';

export interface StoredSnapshot {
  /**
   * 配套工作区的数据身份。旧快照没有该字段（undefined）：
   * 仅在 restoreSession 的旧数据迁移中、与同一旧工作区确认配套后补登。
   */
  workspaceDataId?: string;
  workspaceVersion: number;
  capacity: number;
  /** 本次求解使用的容量日历（与工作区同一数据源） */
  capacityCalendar: CapacityCalendarSegment[];
  solvedAt: string;
  result: SolverResult;
}

const STORAGE_KEY = 'rail-possession-scheduler:v1';
const SNAPSHOT_KEY = 'rail-possession-scheduler:snapshot:v1';
/**
 * 容量占用见证记录（第四把本地键）。与快照同生共写、独立解析：
 * 只凭 dataId + workspaceVersion + 入选集合与快照/工作区配对，
 * 异身份、异版本、异集合、旧格式（无 dataId/无类型标签）或结构损坏的
 * 记录一律丢弃删除，绝不能附到新方案上展示或下载。
 */
const WITNESS_KEY = 'rail-possession-scheduler:witness:v1';
/**
 * 已采纳的不可变参考方案。与工作区/快照一样仅凭 dataId 配套：
 * 导入新数据或恢复到身份不配套的本地记录时绝不生效（记录直接丢弃）。
 */
const REFERENCE_KEY = 'rail-possession-scheduler:reference:v1';

const MAX_BOUND = 1_000_000_000;
const MAX_JOBS = 50_000;
const JOB_STATUSES: ReadonlySet<string> = new Set(['normal', 'required', 'excluded']);

interface PersistedWorkspace {
  dataId?: unknown;
  capacity: unknown;
  version: unknown;
  jobs: unknown;
  /** 旧版本地数据可能没有该字段；缺省即全程 capacity（空数组） */
  capacityCalendar?: unknown;
}

export interface RestoredSession {
  /** 通过结构校验的工作区；存储损坏/不完整时为 null */
  workspace: Workspace | null;
  /**
   * 仅当与工作区共享同一数据身份（且内容交叉核对通过）时非 null。
   * 同身份但版本较旧的快照保留（界面标记“已过期”）；身份不明/不匹配、
   * 结构无效或引用了不存在作业的快照一律为 null，不展示也不可下载。
   */
  snapshot: StoredSnapshot | null;
  /**
   * 仅当参考记录结构合法且 dataId 与工作区完全一致时非 null。
   * 参考不随快照成对：快照丢失/过期不影响已采纳参考；异身份、
   * 损坏或旧格式（无 dataId）的参考记录一律丢弃，绝不作用于新工作区。
   */
  reference: ReferencePlan | null;
  /**
   * 仅当见证记录结构合法、且与所配套快照（dataId + 版本 + 容量日历 +
   * 入选集合逐字段相等）并用当前工作区作业重建见证逐段一致时非 null。
   * 见证不与快照“共存”地无条件恢复：快照缺失/被判废、身份或版本不匹配、
   * 旧格式、结构损坏、片段对不上工作区时一律为 null 且记录被清除，
   * 绝不展示也不进入下载。
   */
  witness: CapacityWitness | null;
}

function safeParse(raw: string | null): unknown | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * 日历结构校验。与导入校验同标准：
 *  - 每项为对象，start/end/available 均为整数；
 *  - 0 <= start < end <= 1e9，0 <= available < capacity；
 *  - 各片段限于作业范围 [minStart, maxEnd]（有作业时）；
 *  - 片段互不重叠（端点相接允许）。
 * 返回按 start 排序的新数组；任何一项不合法返回 null。
 * 缺省（undefined）与空数组等价：返回 []。
 */
export function parseCalendar(
  value: unknown,
  capacity: number,
  jobBounds: { minStart: number; maxEnd: number } | null,
): CapacityCalendarSegment[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;

  const segments: CapacityCalendarSegment[] = [];
  for (const rawSeg of value) {
    if (typeof rawSeg !== 'object' || rawSeg === null || Array.isArray(rawSeg)) return null;
    const seg = rawSeg as Record<string, unknown>;
    const { start, end, available } = seg;
    if (!isInt(start) || !isInt(end) || !isInt(available)) return null;
    if (start < 0 || start > MAX_BOUND || end < 0 || end > MAX_BOUND) return null;
    if (end <= start) return null;
    if (available < 0 || available > capacity - 1) return null;
    if (jobBounds && (start < jobBounds.minStart || end > jobBounds.maxEnd)) return null;
    segments.push({ start, end, available });
  }

  segments.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].start < segments[i - 1].end) return null;
  }
  return segments;
}

function jobBounds(jobs: { start: number; end: number }[]): { minStart: number; maxEnd: number } | null {
  if (jobs.length === 0) return null;
  let minStart = jobs[0].start;
  let maxEnd = jobs[0].end;
  for (const j of jobs) {
    if (j.start < minStart) minStart = j.start;
    if (j.end > maxEnd) maxEnd = j.end;
  }
  return { minStart, maxEnd };
}

interface RawStoredJob {
  id: unknown;
  start: unknown;
  end: unknown;
  benefit: unknown;
  status: unknown;
}

/** 工作区结构校验：任何字段缺失/越界/状态非法/id 重复均整体拒绝。 */
function parseWorkspace(data: unknown): { workspace: Omit<Workspace, 'dataId'> & { dataId?: string }; legacy: boolean } | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const p = data as PersistedWorkspace;

  if (!isInt(p.capacity) || p.capacity < 1 || p.capacity > 8) return null;

  // version：旧数据可能缺失，缺省为 1；存在则必须是正整数
  let version = 1;
  if (p.version !== undefined) {
    if (!isInt(p.version) || p.version < 1) return null;
    version = p.version;
  }

  if (!Array.isArray(p.jobs) || p.jobs.length < 1 || p.jobs.length > MAX_JOBS) return null;

  const jobs: Job[] = [];
  const seen = new Set<string>();
  for (const rawJob of p.jobs) {
    if (typeof rawJob !== 'object' || rawJob === null || Array.isArray(rawJob)) return null;
    const j = rawJob as RawStoredJob;
    // 存储由本应用写入，id 必为字符串；非法 id 不再宽松规范化
    if (!isNonEmptyString(j.id) || seen.has(j.id)) return null;
    if (!isInt(j.start) || j.start < 0 || j.start > MAX_BOUND) return null;
    if (!isInt(j.end) || j.end <= j.start || j.end > MAX_BOUND) return null;
    if (!isInt(j.benefit) || j.benefit < 1 || j.benefit > MAX_BOUND) return null;
    if (!isNonEmptyString(j.status) || !JOB_STATUSES.has(j.status)) return null;
    seen.add(j.id);
    jobs.push({ id: j.id, start: j.start, end: j.end, benefit: j.benefit, status: j.status as JobStatus });
  }

  const calendar = parseCalendar(p.capacityCalendar, p.capacity, jobBounds(jobs));
  if (calendar === null) return null;

  // dataId：旧数据缺失（legacy），由恢复逻辑补登
  if (p.dataId !== undefined && !isDataId(p.dataId)) return null;

  return {
    workspace: {
      capacity: p.capacity as Capacity,
      version,
      jobs,
      capacityCalendar: calendar,
      dataId: p.dataId,
    },
    legacy: p.dataId === undefined,
  };
}

/** 快照结果体的纯结构校验（不依赖工作区；交叉核对另见 resultMatchesWorkspace）。 */
function parseSnapshotResult(result: unknown): SolverResult | null {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return null;
  const r = result as Record<string, unknown>;

  if (!Array.isArray(r.selectedIds)) return null;
  const selectedIds: string[] = [];
  const idsSeen = new Set<string>();
  for (const id of r.selectedIds) {
    if (!isNonEmptyString(id) || idsSeen.has(id)) return null;
    idsSeen.add(id);
    selectedIds.push(id);
  }

  if (!Number.isSafeInteger(r.totalBenefit) || (r.totalBenefit as number) < 0) return null;
  if (!isInt(r.peakOccupancy) || r.peakOccupancy < 0) return null;
  if (!isInt(r.capacity) || r.capacity < 1 || r.capacity > 8) return null;
  if (!isInt(r.selectedCount) || r.selectedCount !== selectedIds.length) return null;
  // peakCellLimit 为新字段：旧结果缺失允许，存在则必须为非负整数
  if (r.peakCellLimit !== undefined && (!isInt(r.peakCellLimit) || r.peakCellLimit < 0)) return null;

  const totalBenefit = r.totalBenefit as number;
  const peakOccupancy = r.peakOccupancy as number;
  const capacity = r.capacity as number;
  const selectedCount = r.selectedCount as number;
  const peakCellLimit = r.peakCellLimit as number | undefined;

  return {
    selectedIds,
    totalBenefit,
    peakOccupancy,
    peakCellLimit,
    capacity,
    selectedCount,
  };
}

interface ParsedSnapshot {
  snapshot: StoredSnapshot;
  legacy: boolean;
}

/** 快照结构校验：工作区身份可缺失（旧快照），其余字段必须完整合法。 */
function parseSnapshot(data: unknown): ParsedSnapshot | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const s = data as Record<string, unknown>;

  if (s.workspaceDataId !== undefined && !isDataId(s.workspaceDataId)) return null;
  if (!isInt(s.workspaceVersion) || s.workspaceVersion < 1) return null;
  if (!isInt(s.capacity) || s.capacity < 1 || s.capacity > 8) return null;
  if (!isNonEmptyString(s.solvedAt)) return null;

  const result = parseSnapshotResult(s.result);
  if (!result) return null;

  // 日历先按快照自带 capacity 做结构校验；与工作区日历逐段相等由配对时核对
  const calendar = parseCalendar(s.capacityCalendar, s.capacity, null);
  if (calendar === null) return null;

  return {
    snapshot: {
      workspaceDataId: s.workspaceDataId as string | undefined,
      workspaceVersion: s.workspaceVersion,
      capacity: s.capacity,
      capacityCalendar: calendar,
      solvedAt: s.solvedAt,
      result,
    },
    legacy: s.workspaceDataId === undefined,
  };
}

function sameCalendar(a: CapacityCalendarSegment[], b: CapacityCalendarSegment[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].start !== b[i].start || a[i].end !== b[i].end || a[i].available !== b[i].available) {
      return false;
    }
  }
  return true;
}

/**
 * 求解结果与工作区的交叉核对（也用于 worker 成功响应落地前的防御性验证）：
 *  - 容量、日历与工作区一致；
 *  - selectedIds 全部指向工作区中真实存在的作业；
 *  - 总收益等于入选作业收益之和；
 *  - 逐格扫描得到的峰值占用与 peakOccupancy 一致，且每格不超有效容量；
 *  - peakCellLimit（若结果中存在）等于最早峰值格的有效容量。
 *
 * 不校验入选作业的必选/排除状态：同身份旧版本的结果在约束修改后本就应
 * 标记为“已过期”，不属于冒充当前结果。
 */
export function resultMatchesWorkspace(
  workspace: Workspace,
  result: Pick<SolverResult, 'selectedIds' | 'totalBenefit' | 'peakOccupancy' | 'peakCellLimit' | 'capacity'>,
): boolean {
  if (result.capacity !== workspace.capacity) return false;

  const byId = new Map<string, Job>();
  for (const job of workspace.jobs) byId.set(job.id, job);

  const selected: Job[] = [];
  for (const id of result.selectedIds) {
    const job = byId.get(id);
    if (!job) return false; // 把不存在的作业交给下游是最危险的伪造结果
    selected.push(job);
  }

  let totalBenefit = 0;
  const grid = buildCapacityGrid(workspace.jobs, workspace.capacity, workspace.capacityCalendar);
  const m = grid.coords.length - 1;
  const diff = new Int32Array(m);
  for (const job of selected) {
    const li = grid.index.get(job.start)!;
    const ri = grid.index.get(job.end)!;
    diff[li] += 1;
    diff[ri] -= 1;
    totalBenefit += job.benefit;
  }
  if (totalBenefit !== result.totalBenefit) return false;

  let peak = 0;
  let peakCellLimit: number = workspace.capacity;
  let cur = 0;
  for (let i = 0; i < m; i++) {
    cur += diff[i];
    if (cur > grid.cellCapacity[i]) return false;
    if (cur > peak) {
      peak = cur;
      peakCellLimit = grid.cellCapacity[i];
    }
  }
  if (peak !== result.peakOccupancy) return false;
  if (result.peakCellLimit !== undefined && result.peakCellLimit !== peakCellLimit) return false;
  return true;
}

/** 快照与工作区是否配套：身份 + 版本 + 容量/日历 + 结果内容全部一致。 */
export function snapshotMatchesWorkspace(snapshot: StoredSnapshot, workspace: Workspace): boolean {
  if (snapshot.workspaceDataId !== workspace.dataId) return false;
  if (snapshot.workspaceVersion !== workspace.version) return false;
  if (snapshot.capacity !== workspace.capacity) return false;
  if (!sameCalendar(snapshot.capacityCalendar, workspace.capacityCalendar)) return false;
  return resultMatchesWorkspace(workspace, snapshot.result);
}

/**
 * 见证记录的纯结构校验（不依赖工作区；与快照/工作区的逐段核对另见
 * matchWitness）。任何字段缺失/类型错误、片段不首尾相接、占用为负、
 * 超容量、余量不自洽、作业清单与占用数不符、入选集合重复都整体拒绝。
 * 旧格式（无 dataId、无 kind 标签）天然落入拒绝路径，不做迁移。
 */
function parseCapacityWitness(data: unknown): CapacityWitness | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const w = data as Record<string, unknown>;
  if (w.kind !== 'capacity-witness') return null;
  if (w.witnessVersion !== 1) return null;
  if (!isDataId(w.workspaceDataId)) return null;
  if (!isInt(w.workspaceVersion) || w.workspaceVersion < 1) return null;
  if (!isInt(w.capacity) || w.capacity < 1 || w.capacity > 8) return null;
  if (!isNonEmptyString(w.solvedAt)) return null;

  const calendar = parseCalendar(w.capacityCalendar, w.capacity, null);
  if (calendar === null) return null;

  if (!Array.isArray(w.selectedIds)) return null;
  const selectedIds: string[] = [];
  const idsSeen = new Set<string>();
  for (const id of w.selectedIds) {
    if (!isNonEmptyString(id) || idsSeen.has(id)) return null;
    idsSeen.add(id);
    selectedIds.push(id);
  }

  if (!Array.isArray(w.segments)) return null;
  const segments: WitnessSegment[] = [];
  for (const rawSeg of w.segments) {
    if (typeof rawSeg !== 'object' || rawSeg === null || Array.isArray(rawSeg)) return null;
    const s = rawSeg as Record<string, unknown>;
    if (!isInt(s.start) || !isInt(s.end) || s.end <= s.start) return null;
    if (!isInt(s.capacity) || s.capacity < 0 || s.capacity > w.capacity) return null;
    if (!isInt(s.occupancy) || s.occupancy < 0 || s.occupancy > s.capacity) return null;
    if (!isInt(s.spare) || s.spare !== s.capacity - s.occupancy) return null;
    if (!Array.isArray(s.jobIds)) return null;
    const jobIds: string[] = [];
    const segSeen = new Set<string>();
    for (const id of s.jobIds) {
      if (!isNonEmptyString(id) || !idsSeen.has(id) || segSeen.has(id)) return null;
      segSeen.add(id);
      jobIds.push(id);
    }
    if (jobIds.length !== s.occupancy) return null;
    // 片段必须按稳定排序（start,end,id）存储
    for (let i = 1; i < jobIds.length; i++) {
      if (jobIds[i - 1] > jobIds[i]) return null;
    }
    segments.push({
      start: s.start,
      end: s.end,
      capacity: s.capacity,
      occupancy: s.occupancy,
      spare: s.spare,
      jobIds,
    });
  }
  // 片段在见证时间轴上首尾相接（第一段起点、相邻端点、最后一段终点）
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].start !== segments[i - 1].end) return null;
  }

  return {
    kind: 'capacity-witness',
    witnessVersion: 1,
    workspaceDataId: w.workspaceDataId,
    workspaceVersion: w.workspaceVersion,
    capacity: w.capacity,
    capacityCalendar: calendar,
    selectedIds,
    solvedAt: w.solvedAt,
    segments,
  };
}

/**
 * 见证与所配套快照的配对 + 用当前工作区作业重建见证逐段核对。
 * 配对条件：dataId、版本、容量、日历逐字段相等，selectedIds 与快照
 * 严格同序同集合（下载 JSON 与页面必须使用同一见证）；随后重建见证，
 * 任一片段对不上即判废。同身份旧版本快照以“已过期”展示时，其见证
 * 版本也必须等于快照版本——当前工作区版本的见证绝不附到过期快照上。
 */
function matchWitness(
  witness: CapacityWitness | null,
  snapshot: StoredSnapshot | null,
  workspace: Workspace,
): CapacityWitness | null {
  if (!witness || !snapshot) return null;
  if (witness.workspaceDataId !== snapshot.workspaceDataId) return null;
  if (witness.workspaceVersion !== snapshot.workspaceVersion) return null;
  if (witness.capacity !== snapshot.capacity) return null;
  if (!sameCalendar(witness.capacityCalendar, snapshot.capacityCalendar)) return null;
  if (!sameStringArray(witness.selectedIds, snapshot.result.selectedIds)) return null;

  const ok = verifyCapacityWitness(witness, {
    dataId: workspace.dataId,
    version: snapshot.workspaceVersion,
    capacity: workspace.capacity,
    calendar: workspace.capacityCalendar,
    jobs: workspace.jobs,
    selectedIds: snapshot.result.selectedIds,
  });
  return ok ? witness : null;
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * 同身份但可能是旧版本的快照（用于“已过期”展示）：身份一致、
 * 内容仍是该批数据的一份合法结果即可；版本不同只表示过期，不表示伪造。
 */
export function snapshotBelongsToWorkspace(snapshot: StoredSnapshot, workspace: Workspace): boolean {
  if (snapshot.workspaceDataId !== workspace.dataId) return false;
  if (snapshot.capacity !== workspace.capacity) return false;
  if (!sameCalendar(snapshot.capacityCalendar, workspace.capacityCalendar)) return false;
  return resultMatchesWorkspace(workspace, snapshot.result);
}

function removeItem(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // 存储不可用时忽略：内存中的配对结论仍然成立
  }
}

/**
 * 参考方案记录结构校验。参考是不可变输入，任何字段缺失/非法
 * （无 dataId、版本非正整数、时间戳非字符串、成员畸形/重复）整体拒绝。
 * 不校验成员是否仍存在于工作区：已删除成员由配对后的差异计算剔除。
 */
function parseReference(data: unknown): ReferencePlan | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const r = data as Record<string, unknown>;
  if (!isDataId(r.workspaceDataId)) return null;
  if (!isInt(r.workspaceVersion) || r.workspaceVersion < 1) return null;
  if (!isNonEmptyString(r.adoptedAt)) return null;
  const members = normalizeReferenceMembers(r.members);
  if (members === null) return null;
  return {
    workspaceDataId: r.workspaceDataId,
    workspaceVersion: r.workspaceVersion,
    adoptedAt: r.adoptedAt,
    members,
  };
}

/** 单独读取参考记录：仅结构校验，不与任何工作区配对（测试/工具用）。 */
export function loadReference(): ReferencePlan | null {
  try {
    const raw = localStorage.getItem(REFERENCE_KEY);
    return parseReference(safeParse(raw));
  } catch {
    return null;
  }
}

/** 持久化参考方案（采纳后写入；存储失败不影响内存中的功能）。 */
export function persistReference(reference: ReferencePlan): void {
  try {
    localStorage.setItem(REFERENCE_KEY, JSON.stringify(reference));
  } catch {
    // 忽略：存储不可用（隐私模式/超额）不影响当前会话
  }
}

/** 丢弃参考记录（导入新数据/异身份恢复时调用）。 */
export function clearReference(): void {
  removeItem(REFERENCE_KEY);
}

/**
 * 恢复唯一入口：同时读取工作区、求解快照与参考方案，按数据身份严格配对。
 *
 * 防混合规则：
 *  - 两份结果记录必须同属一个数据身份。版本号相同但 dataId 不同（典型：
 *    新导入的数据也从 version=1 起步）绝不配套；
 *  - 浏览器只成功写入一份记录（单键写入/中途崩溃）时，另一份没有同身份
 *    对象可配对，孤儿快照直接丢弃，绝不与新工作区混合；
 *  - 结构无效（畸形日历、非法状态、结果不完整、selectedIds 指向不存在
 *    的作业、收益/峰值对不上）的记录整体拒绝并清除，不渲染也不导出；
 *  - 参考方案独立按 dataId 配对：身份不明（旧格式无 dataId）或不匹配的
 *    参考记录直接删除，绝不作用于新工作区；参考不与快照绑定，
 *    快照过期/丢失不影响已采纳参考；
 *  - 旧合法存储（两份均无 dataId）仅在版本、容量、日历、结果内容全部
 *    与工作区对得上时视为配套，补登同一新 dataId 并立即回写迁移。
 */
export function restoreSession(): RestoredSession {
  const empty: RestoredSession = { workspace: null, snapshot: null, reference: null, witness: null };
  let storageOk = true;
  try {
    storageOk = typeof localStorage !== 'undefined';
  } catch {
    storageOk = false;
  }
  if (!storageOk) return empty;

  let wsRaw: string | null = null;
  let snapRaw: string | null = null;
  let refRaw: string | null = null;
  let witnessRaw: string | null = null;
  try {
    wsRaw = localStorage.getItem(STORAGE_KEY);
    snapRaw = localStorage.getItem(SNAPSHOT_KEY);
    refRaw = localStorage.getItem(REFERENCE_KEY);
    witnessRaw = localStorage.getItem(WITNESS_KEY);
  } catch {
    return empty;
  }

  const parsedWs = parseWorkspace(safeParse(wsRaw));
  const parsedSnap = parseSnapshot(safeParse(snapRaw));
  // 旧版本地数据不可能有参考键：无 dataId 的参考记录直接判废
  const parsedReference = parseReference(safeParse(refRaw));
  if (refRaw !== null && !parsedReference) removeItem(REFERENCE_KEY);
  // 见证是新格式记录：任何结构损坏（含无 dataId/无类型标签的旧形态）
  // 都沿用现有拒绝规则，整体判废并清除，绝不静默迁移或附到旧方案上。
  const parsedWitness = parseCapacityWitness(safeParse(witnessRaw));
  if (witnessRaw !== null && !parsedWitness) removeItem(WITNESS_KEY);

  if (!parsedWs) {
    if (wsRaw !== null) removeItem(STORAGE_KEY);
    if (parsedSnap) removeItem(SNAPSHOT_KEY); // 没有工作区的快照无法配对，不能下发
    if (parsedReference) removeItem(REFERENCE_KEY);
    if (parsedWitness) removeItem(WITNESS_KEY); // 孤儿见证与孤儿快照同样丢弃
    return empty;
  }

  if (!parsedSnap) {
    if (snapRaw !== null) removeItem(SNAPSHOT_KEY); // 工作区有效，快照损坏：保工作区、弃快照
    if (parsedWitness) removeItem(WITNESS_KEY); // 没有可配套快照：见证不得独立下发
    const dataId = parsedWs.legacy ? newDataId() : parsedWs.workspace.dataId!;
    const workspace = { ...parsedWs.workspace, dataId };
    if (parsedWs.legacy) persistWorkspace(workspace); // 旧工作区补登身份并立即回写
    return { workspace, snapshot: null, reference: matchReference(parsedReference, dataId), witness: null };
  }

  const { snapshot, legacy: snapLegacy } = parsedSnap;
  const wsLegacy = parsedWs.legacy;

  // 只有“两份都是旧数据”或“两份都是新数据且 dataId 相同”才可能配套
  if (wsLegacy !== snapLegacy || (!wsLegacy && parsedWs.workspace.dataId !== snapshot.workspaceDataId)) {
    removeItem(SNAPSHOT_KEY); // 异身份：可能是单键写入或旧快照残留，丢弃
    if (parsedWitness) removeItem(WITNESS_KEY); // 快照既不配套，旧见证绝不能附到新方案
    const dataId = wsLegacy ? newDataId() : parsedWs.workspace.dataId!;
    const workspace = { ...parsedWs.workspace, dataId };
    if (wsLegacy) persistWorkspace(workspace);
    return { workspace, snapshot: null, reference: matchReference(parsedReference, dataId), witness: null };
  }

  const workspace: Workspace = wsLegacy
    ? { ...parsedWs.workspace, dataId: newDataId() }
    : { ...parsedWs.workspace, dataId: parsedWs.workspace.dataId! };

  // 旧数据没有 dataId，版本号是唯一的配对线索：版本不一致不能配套
  const versionOk = !wsLegacy || snapshot.workspaceVersion === workspace.version;
  const contentOk =
    versionOk &&
    snapshot.capacity === workspace.capacity &&
    sameCalendar(snapshot.capacityCalendar, workspace.capacityCalendar) &&
    resultMatchesWorkspace(workspace, snapshot.result);

  if (!contentOk) {
    removeItem(SNAPSHOT_KEY);
    if (parsedWitness) removeItem(WITNESS_KEY);
    if (wsLegacy) persistWorkspace(workspace);
    return { workspace, snapshot: null, reference: matchReference(parsedReference, workspace.dataId), witness: null };
  }

  if (wsLegacy) {
    // 确认配套的旧数据：补登同一身份并回写，之后按新数据处理
    snapshot.workspaceDataId = workspace.dataId;
    persistWorkspace(workspace);
    persistSnapshot(snapshot);
    // 旧快照迁移时没有任何合法见证可迁移（旧记录无类型标签，已在上方判废）
    if (parsedWitness) removeItem(WITNESS_KEY);
    return {
      workspace,
      snapshot,
      reference: matchReference(parsedReference, workspace.dataId),
      witness: null,
    };
  }

  // 同身份：版本相同即当前结果；版本较旧时由界面标记“已过期”（不冒充当前）。
  // 见证同样只与这份快照配套（版本等于快照版本、入选集合逐字段相等、
  // 按当前工作区作业重建逐段一致）；对不上就清除，绝不把旧见证附到新方案。
  const witness = matchWitness(parsedWitness, snapshot, workspace);
  if (parsedWitness && !witness) removeItem(WITNESS_KEY);
  return {
    workspace,
    snapshot,
    reference: matchReference(parsedReference, workspace.dataId),
    witness,
  };
}

/**
 * 参考与工作区的唯一配对条件：dataId 完全相等。
 * 不匹配（含无工作区时的残留）的合法记录直接删除，防止误用。
 */
function matchReference(reference: ReferencePlan | null, dataId: string): ReferencePlan | null {
  if (!reference) return null;
  if (reference.workspaceDataId !== dataId) {
    removeItem(REFERENCE_KEY);
    return null;
  }
  return reference;
}

export function persistWorkspace(workspace: Workspace): void {
  try {
    const data: PersistedWorkspace & { dataId: string } = {
      dataId: workspace.dataId,
      capacity: workspace.capacity,
      version: workspace.version,
      jobs: workspace.jobs,
      capacityCalendar: workspace.capacityCalendar,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // 存储不可用（隐私模式/超额）不影响内存中的功能
  }
}

/**
 * 单独加载工作区（旧接口，供测试与工具复用）。同样执行严格结构校验；
 * 旧数据缺 dataId 时补一个新身份。
 */
export function loadWorkspace(): Workspace | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = parseWorkspace(safeParse(raw));
    if (!parsed) return null;
    return { ...parsed.workspace, dataId: parsed.legacy ? newDataId() : parsed.workspace.dataId! };
  } catch {
    return null;
  }
}

export function persistSnapshot(snapshot: StoredSnapshot): void {
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    // 忽略：结果持久化失败不影响当前会话
  }
}

/**
 * 持久化容量占用见证（与快照同生：每次成功求解在快照之后写入）。
 * 存储失败（配额/隐私模式）不影响当前会话的展示与下载；
 * 恢复时若只有快照没有见证，见证缺省为 null，绝不临时拼凑一份。
 */
export function persistWitness(witness: CapacityWitness): void {
  try {
    localStorage.setItem(WITNESS_KEY, JSON.stringify(witness));
  } catch {
    // 忽略：见证持久化失败不影响当前会话
  }
}

/**
 * 单独加载见证（测试/工具用）：仅做结构校验，不与任何快照/工作区配对。
 * 界面恢复必须走 restoreSession()，避免跨批次/跨版本见证冒充当前结果。
 */
export function loadWitness(): CapacityWitness | null {
  try {
    const raw = localStorage.getItem(WITNESS_KEY);
    return parseCapacityWitness(safeParse(raw));
  } catch {
    return null;
  }
}

/** 丢弃见证记录（主要供测试与显式清理使用）。 */
export function clearWitness(): void {
  removeItem(WITNESS_KEY);
}

/**
 * 单独加载快照（旧接口）：仅做结构校验。注意它不与任何工作区配对——
 * 界面恢复必须走 restoreSession()，避免跨批次数据冒充当前结果。
 */
export function loadSnapshot(): StoredSnapshot | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    return parseSnapshot(safeParse(raw))?.snapshot ?? null;
  } catch {
    return null;
  }
}

/** 下载 JSON 中单个相对参考方案的差异成员（时刻为该成员当前时刻）。 */
export interface ReferenceDiffJson {
  id: string;
  start: number;
  end: number;
  /** 同编号作业在当前工作区中的时刻（保留项与 start/end 相同；改期项不同） */
  currentStart: number;
  currentEnd: number;
}

/** 下载 JSON 中的参考方案区块：与屏幕结果页逐项一致。 */
export interface ReferenceBlockJson {
  dataId: string;
  adoptedAt: string;
  /** 采纳时的工作区版本（仅信息用途） */
  workspaceVersion: number;
  retained: ReferenceDiffJson[];
  removed: ReferenceDiffJson[];
  added: ReferenceDiffJson[];
  /** 已从当前工作区删除、不参与可避免差异计数的参考成员 */
  deletedReference: ReferenceMember[];
  /** 可避免差异数 = removed + added */
  diffCount: number;
}

function toDiffJson(items: ReferenceDiff['retained']): ReferenceDiffJson[] {
  return items.map((item) => ({
    id: item.id,
    start: item.start,
    end: item.end,
    currentStart: item.currentStart,
    currentEnd: item.currentEnd,
  }));
}

/**
 * 屏幕展示集合与下载文件必须一致：统一由此函数构造结果 JSON。
 * 下载内容包含同一身份、同一日历、集合、收益和峰值数据，
 * 不含任何占位值或派生猜测字段；旧快照无身份时该字段缺省（原结构不变）。
 *
 * referenceDiff 非空（已采纳且身份配套的参考）时，结果页展示的
 * 保留/撤下/新增三类成员原样进入下载文件，屏幕与下载来自同一份
 * computeReferenceDiff 结果，不存在两套计算路径。
 *
 * witness 非空且与快照严格配套（dataId/版本/容量/日历/selectedIds
 * 逐字段相等）时，下载文件附带 capacityWitness 区块——它与页面上的
 * 容量占用见证是同一个只读对象。不配套或缺省时该字段省略，旧格式
 * 下载（以及旧快照）结构逐项不变。
 */
export function buildResultJson(
  snapshot: StoredSnapshot,
  reference: ReferencePlan | null = null,
  referenceDiff: ReferenceDiff | null = null,
  witness: CapacityWitness | null = null,
): {
  dataId?: string;
  capacity: number;
  capacityCalendar: CapacityCalendarSegment[];
  workspaceVersion: number;
  solvedAt: string;
  totalBenefit: number;
  peakOccupancy: number;
  peakCellLimit: number;
  selectedCount: number;
  selectedIds: string[];
  reference?: ReferenceBlockJson;
  capacityWitness?: WitnessBlockJson;
} {
  const base = {
    // undefined 在 JSON.stringify 时自动省略：旧快照下载结构保持原样
    dataId: snapshot.workspaceDataId,
    capacity: snapshot.capacity,
    capacityCalendar: snapshot.capacityCalendar,
    workspaceVersion: snapshot.workspaceVersion,
    solvedAt: snapshot.solvedAt,
    totalBenefit: snapshot.result.totalBenefit,
    peakOccupancy: snapshot.result.peakOccupancy,
    peakCellLimit:
      snapshot.result.peakCellLimit ?? effectiveFallback(snapshot.capacityCalendar, snapshot.capacity),
    selectedCount: snapshot.result.selectedCount,
    selectedIds: snapshot.result.selectedIds,
  };
  if (!reference || !referenceDiff) {
    return witness && witnessMatchesSnapshot(witness, snapshot)
      ? { ...base, capacityWitness: toWitnessBlock(witness) }
      : base;
  }
  const referenceBlock: ReferenceBlockJson = {
    dataId: reference.workspaceDataId,
    adoptedAt: reference.adoptedAt,
    workspaceVersion: reference.workspaceVersion,
    retained: toDiffJson(referenceDiff.retained),
    removed: toDiffJson(referenceDiff.removed),
    added: toDiffJson(referenceDiff.added),
    deletedReference: referenceDiff.deletedReference.map((m) => ({ ...m })),
    diffCount: referenceDiff.diffCount,
  };
  return witness && witnessMatchesSnapshot(witness, snapshot)
    ? { ...base, reference: referenceBlock, capacityWitness: toWitnessBlock(witness) }
    : { ...base, reference: referenceBlock };
}

/** 下载 JSON 中的容量占用见证区块：与页面见证面板来自同一对象。 */
export interface WitnessBlockJson {
  kind: 'capacity-witness';
  witnessVersion: 1;
  dataId: string;
  workspaceVersion: number;
  capacity: number;
  capacityCalendar: CapacityCalendarSegment[];
  selectedIds: string[];
  solvedAt: string;
  segments: WitnessSegment[];
}

/** 见证是否与快照严格配套（下载/展示前的最后一道身份与集合闸门）。 */
export function witnessMatchesSnapshot(witness: CapacityWitness, snapshot: StoredSnapshot): boolean {
  if (witness.kind !== 'capacity-witness' || witness.witnessVersion !== 1) return false;
  if (witness.workspaceDataId !== snapshot.workspaceDataId) return false;
  if (witness.workspaceVersion !== snapshot.workspaceVersion) return false;
  if (witness.capacity !== snapshot.capacity) return false;
  if (!sameCalendar(witness.capacityCalendar, snapshot.capacityCalendar)) return false;
  if (!sameStringArray(witness.selectedIds, snapshot.result.selectedIds)) return false;
  if (witness.solvedAt !== snapshot.solvedAt) return false;
  return true;
}

function toWitnessBlock(witness: CapacityWitness): WitnessBlockJson {
  return {
    kind: 'capacity-witness',
    witnessVersion: 1,
    dataId: witness.workspaceDataId,
    workspaceVersion: witness.workspaceVersion,
    capacity: witness.capacity,
    capacityCalendar: witness.capacityCalendar.map((seg) => ({ ...seg })),
    selectedIds: [...witness.selectedIds],
    solvedAt: witness.solvedAt,
    segments: witness.segments.map((seg) => ({ ...seg, jobIds: [...seg.jobIds] })),
  };
}

/** 旧结果缺 peakCellLimit 时的展示回退：空日历即全程 capacity。 */
function effectiveFallback(calendar: CapacityCalendarSegment[], capacity: number): number {
  return calendar.length === 0 ? capacity : Math.min(...calendar.map((s) => s.available));
}
