import { buildCapacityGrid } from './capacityCalendar';
import type { CapacityCalendarSegment } from './types';

/**
 * 容量占用见证（只读）：
 *
 * 一次成功求解落地前，由「入选作业 + 容量日历」的全部端点把左闭右开
 * 时间轴切成小格，再把相邻且「有效容量相同、活动作业集合相同」的小格
 * 合并为稳定片段，逐段给出起止、有效容量、实际占用、余量与稳定排序的
 * 作业清单。见证是只读产物：重新计算一律生成新见证，不就地改写旧见证。
 *
 * 见证严格绑定生成它的三元组 dataId + workspaceVersion + selectedIds
 * （并隐含同一 capacity 与同一容量日历）：约束变化、异身份恢复或
 * Worker 迟到的旧响应，其见证都绝不能附到当前方案上展示或下载。
 */

export interface WitnessSegment {
  /** 片段起点（含） */
  start: number;
  /** 片段终点（不含）；与下一片段 start 相接，无空隙无重叠 */
  end: number;
  /** 该片段的有效容量（容量日历压容处可能为 0） */
  capacity: number;
  /** 实际占用：片段内活动的入选作业数 */
  occupancy: number;
  /** 余量 = capacity - occupancy，恒非负 */
  spare: number;
  /**
   * 片段内活动的入选作业 id，稳定排序：start 升序、end 升序、id 升序。
   * 长度恒等于 occupancy。
   */
  jobIds: string[];
}

export interface CapacityWitness {
  /** 固定类型标签：恢复时缺失/不符即整体拒绝 */
  kind: 'capacity-witness';
  /** 见证格式版本；当前仅支持 1 */
  witnessVersion: 1;
  /** 绑定的工作区数据身份 */
  workspaceDataId: string;
  /** 绑定的工作区版本（必须与生成它的快照版本逐字段相等） */
  workspaceVersion: number;
  capacity: number;
  /** 生成见证所用的同一容量日历 */
  capacityCalendar: CapacityCalendarSegment[];
  /** 绑定的入选集合（求解器导入顺序；与快照 selectedIds 严格同集合同序） */
  selectedIds: string[];
  /** 见证生成时间（取所属快照的 solvedAt，同一结果同一时刻） */
  solvedAt: string;
  /** 合并后的占用片段，时间上首尾相接 */
  segments: WitnessSegment[];
}

/**
 * 见证生成/自检失败。调用方必须把它当作“该结果不得下发”处理：
 * 不更新当前快照、不展示、不可下载，但也不清空上一次成功结果。
 */
export class WitnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WitnessError';
  }
}

export interface WitnessInput {
  /** 当前工作区的全部作业（用于把 selectedIds 解析成时刻） */
  jobs: readonly { id: string; start: number; end: number }[];
  capacity: number;
  calendar: CapacityCalendarSegment[];
  /** 入选作业 id（求解结果，导入顺序） */
  selectedIds: readonly string[];
  workspaceDataId: string;
  workspaceVersion: number;
  solvedAt: string;
}

interface SelectedJob {
  id: string;
  start: number;
  end: number;
}

function compareActive(a: SelectedJob, b: SelectedJob): number {
  return a.start - b.start || a.end - b.end || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * 由入选集合与容量日历构造容量占用见证。
 *
 * 时间格只由「入选作业端点 + 日历端点」切分（未入选作业不产生切分点）；
 * 同一坐标先结算结束（-1）再结算开始（+1），故端点相接的两个作业
 * （end == 下一个 start）永不同时活动，与半开区间语义一致。
 *
 * 相邻小格合并的充要条件：边界坐标上没有任何入选作业起止事件，
 * 且两小格有效容量相等——无事件则活动集合必不变，两条合并键
 * （有效容量、活动作业 id 集合）因此都不变。
 *
 * 任何输入不一致（容量非法、selectedIds 重复/指向不存在作业、
 * 逐格占用超过有效容量）都抛 WitnessError：调用方不得把该结果
 * 伪装成可下发的当前方案。
 */
export function buildCapacityWitness(input: WitnessInput): CapacityWitness {
  const { jobs, capacity, calendar, selectedIds } = input;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 8) {
    throw new WitnessError(`容量占用见证生成失败：capacity 非法（${capacity}）`);
  }
  if (typeof input.workspaceDataId !== 'string' || input.workspaceDataId.length === 0) {
    throw new WitnessError('容量占用见证生成失败：缺少数据身份');
  }
  if (!Number.isInteger(input.workspaceVersion) || input.workspaceVersion < 1) {
    throw new WitnessError('容量占用见证生成失败：工作区版本非法');
  }

  const byId = new Map<string, SelectedJob>();
  for (const job of jobs) byId.set(job.id, { id: job.id, start: job.start, end: job.end });

  const selected: SelectedJob[] = [];
  const chosen = new Set<string>();
  for (const id of selectedIds) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new WitnessError('容量占用见证生成失败：入选集合含非法 id');
    }
    if (chosen.has(id)) {
      throw new WitnessError(`容量占用见证生成失败：入选作业 id "${id}" 重复`);
    }
    const job = byId.get(id);
    if (!job) {
      throw new WitnessError(`容量占用见证生成失败：入选作业 "${id}" 在工作区中不存在`);
    }
    chosen.add(id);
    selected.push(job);
  }

  // 统一时间格：仅入选作业端点 + 日历端点
  const grid = buildCapacityGrid(selected, capacity, calendar);
  const coords = grid.coords;
  const cellCap = grid.cellCapacity;
  const m = coords.length - 1;

  // 每个坐标上的开始/结束事件；相接端点先结束后开始
  // 无入选且无日历（坐标集为空）时 m = -1：所有集合/数组均为空
  const startsAt: string[][] = Array.from({ length: Math.max(0, m + 1) }, () => []);
  const endsAt: string[][] = Array.from({ length: Math.max(0, m + 1) }, () => []);
  const diff = new Int32Array(Math.max(0, m));
  for (const job of selected) {
    const li = grid.index.get(job.start)!;
    const ri = grid.index.get(job.end)!;
    startsAt[li].push(job.id);
    endsAt[ri].push(job.id);
    diff[li] += 1;
    diff[ri] -= 1;
  }

  // 差分独立计数并逐格核对容量（与活动集合双重印证）
  const cellOcc = new Int32Array(Math.max(0, m));
  let depth = 0;
  for (let p = 0; p < m; p++) {
    depth += diff[p];
    if (depth < 0) {
      throw new WitnessError('容量占用见证生成失败：占用扫描出现负深度');
    }
    if (depth > cellCap[p]) {
      throw new WitnessError(
        `容量占用见证生成失败：时间格 [${coords[p]}, ${coords[p + 1]}) 占用 ${depth} 超过有效容量 ${cellCap[p]}`,
      );
    }
    cellOcc[p] = depth;
  }

  // 扫描活动集合并合并相邻同键小格。
  // 活动作业数恒 <= capacity <= 8，用有序数组增量维护（插入/删除均为
  // O(capacity) 的小数组移位），避免对每个片段反复排序；5 万作业量级
  // 下片段数接近作业数，整体仍为 O(n·capacity)。
  const segments: WitnessSegment[] = [];
  const activeJobs: SelectedJob[] = [];
  const activeIndex = new Map<string, number>(); // id -> activeJobs 下标
  const addActive = (job: SelectedJob): void => {
    // 按 (start,end,id) 找到插入位置，保持稳定排序
    let lo = 0;
    while (lo < activeJobs.length && compareActive(activeJobs[lo], job) < 0) lo++;
    activeJobs.splice(lo, 0, job);
    for (let i = lo; i < activeJobs.length; i++) activeIndex.set(activeJobs[i].id, i);
  };
  const removeActive = (id: string): void => {
    const at = activeIndex.get(id);
    if (at === undefined) return;
    activeJobs.splice(at, 1);
    for (let i = at; i < activeJobs.length; i++) activeIndex.set(activeJobs[i].id, i);
    activeIndex.delete(id);
  };
  const activeIds = (): string[] => activeJobs.map((j) => j.id);

  if (m > 0) {
    // 进入小格 0 前结算坐标 0 的事件（先结束后开始）
    for (const id of endsAt[0]) removeActive(id);
    for (const id of startsAt[0]) addActive(byId.get(id)!);

    let segStart = coords[0];
    let segCap = cellCap[0];
    let segJobIds = activeIds();

    const openCellOk = (p: number): void => {
      if (activeJobs.length !== cellOcc[p]) {
        throw new WitnessError(
          `容量占用见证生成失败：时间格 [${coords[p]}, ${coords[p + 1]}) 活动集合与占用计数不一致`,
        );
      }
      if (activeJobs.length > cellCap[p]) {
        throw new WitnessError(
          `容量占用见证生成失败：时间格 [${coords[p]}, ${coords[p + 1]}) 占用超过有效容量`,
        );
      }
    };
    openCellOk(0);

    for (let p = 1; p < m; p++) {
      const hasEvent = startsAt[p].length > 0 || endsAt[p].length > 0;
      const capChanged = cellCap[p] !== segCap;
      if (hasEvent || capChanged) {
        // 收尾上一个合并片段 [segStart, coords[p])
        pushSegment(segments, segStart, coords[p], segCap, segJobIds);
        segStart = coords[p];
        segCap = cellCap[p];
        for (const id of endsAt[p]) removeActive(id);
        for (const id of startsAt[p]) addActive(byId.get(id)!);
        segJobIds = activeIds();
      }
      // 无事件的坐标两端活动集合不变，无需更新 activeJobs
      openCellOk(p);
    }
    pushSegment(segments, segStart, coords[m], segCap, segJobIds);
  }

  return {
    kind: 'capacity-witness',
    witnessVersion: 1,
    workspaceDataId: input.workspaceDataId,
    workspaceVersion: input.workspaceVersion,
    capacity,
    capacityCalendar: calendar.map((seg) => ({ ...seg })),
    selectedIds: [...selectedIds],
    solvedAt: input.solvedAt,
    segments,
  };
}

function pushSegment(
  segments: WitnessSegment[],
  start: number,
  end: number,
  capacity: number,
  jobIds: string[],
): void {
  segments.push({
    start,
    end,
    capacity,
    occupancy: jobIds.length,
    spare: capacity - jobIds.length,
    jobIds,
  });
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

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameSegments(a: WitnessSegment[], b: WitnessSegment[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.start !== y.start ||
      x.end !== y.end ||
      x.capacity !== y.capacity ||
      x.occupancy !== y.occupancy ||
      x.spare !== y.spare ||
      !sameStringArray(x.jobIds, y.jobIds)
    ) {
      return false;
    }
  }
  return true;
}

export interface WitnessContext {
  dataId: string;
  version: number;
  capacity: number;
  calendar: CapacityCalendarSegment[];
  jobs: readonly { id: string; start: number; end: number }[];
  selectedIds: readonly string[];
}

/**
 * 见证自检：用当前工作区与入选集合重建见证并逐项比对。
 * 身份、版本、容量、日历、入选集合或任一片段不一致都返回 false——
 * 该见证绝不允许展示或附到下载文件上。重建本身抛错同样判 false。
 */
export function verifyCapacityWitness(witness: CapacityWitness, ctx: WitnessContext): boolean {
  if (witness.kind !== 'capacity-witness' || witness.witnessVersion !== 1) return false;
  if (witness.workspaceDataId !== ctx.dataId) return false;
  if (witness.workspaceVersion !== ctx.version) return false;
  if (witness.capacity !== ctx.capacity) return false;
  if (!sameCalendar(witness.capacityCalendar, ctx.calendar)) return false;
  if (!sameStringArray(witness.selectedIds, ctx.selectedIds)) return false;

  let expected: CapacityWitness;
  try {
    expected = buildCapacityWitness({
      jobs: ctx.jobs,
      capacity: ctx.capacity,
      calendar: ctx.calendar,
      selectedIds: ctx.selectedIds,
      workspaceDataId: ctx.dataId,
      workspaceVersion: ctx.version,
      solvedAt: witness.solvedAt,
    });
  } catch {
    return false;
  }
  return sameSegments(witness.segments, expected.segments);
}
