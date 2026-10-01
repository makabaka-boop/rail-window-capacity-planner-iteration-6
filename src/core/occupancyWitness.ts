import { buildCapacityGrid } from './capacityCalendar';
import type { CapacityCalendarSegment, Job } from './types';

/**
 * 只读「容量占用见证」（capacity occupancy witness）：
 *
 * 调度员下发最优检修排程前，需要看到每段时间究竟由哪些入选作业占用作业队，
 * 而不只看峰值数字。见证以「入选作业端点 + 容量日历端点」切分左闭右开
 * 时间轴，把有效容量与活动作业 ID 集合均相同的相邻小格合并，逐段给出：
 *
 *   - start / end：片段区间（左闭右开，片段首尾相接、无缝铺满时间轴）；
 *   - capacity：该片段的有效容量（容量日历下调后的值，可能为 0）；
 *   - occupancy：实际占用（跨越该片段的入选作业数）；
 *   - spare：余量 = capacity - occupancy（封闭段为 0）；
 *   - jobIds：占用该片段的入选作业，按工作区导入顺序稳定排序。
 *
 * 见证是一次成功求解结果的只读派生品，不持久化、不可手工编辑，并且只
 * 属于生成它的三要素：dataId、workspaceVersion、入选集合。任何一项变化
 * （约束变化后重算、导入异身份数据、Worker 迟到的旧响应被采纳）都必须
 * 重新生成；旧见证附到新方案时由 witnessMatchesSnapshot / 下载前的
 * verifyWitnessAgainstSnapshot 挡下，绝不下发。
 */

export interface OccupancySegment {
  /** 片段起点（含） */
  start: number;
  /** 片段终点（不含）；与下一片段 start 相接 */
  end: number;
  /** 该片段内恒定的有效容量（无日历覆盖处为全局 capacity；可为 0） */
  capacity: number;
  /** 实际占用：跨越该片段的入选作业数 */
  occupancy: number;
  /** 余量 = capacity - occupancy */
  spare: number;
  /** 占用作业队的入选作业 id，按工作区导入顺序（下标升序）稳定排序 */
  jobIds: string[];
}

export interface CapacityWitness {
  /** 形态标记：下载 JSON / 结构校验据此识别见证体 */
  kind: typeof WITNESS_KIND;
  /** 见证格式版本 */
  witnessVersion: 1;
  /** 绑定的工作区数据身份；与结果快照不一致的见证一律无效 */
  workspaceDataId: string;
  /** 绑定的工作区版本（求解时的版本） */
  workspaceVersion: number;
  /** 生成见证所用的入选集合（与结果 selectedIds 同序逐项相等） */
  selectedIds: string[];
  /** 生成时间（ISO 字符串，仅展示用途） */
  generatedAt: string;
  /** 合并后的占用片段：首尾相接、无缝铺满「入选端点 + 日历端点」时间轴 */
  segments: OccupancySegment[];
}

export const WITNESS_KIND = 'capacity-occupancy-witness';

/** 见证生成/校验失败：调用方必须让结果保持「不可下发」状态，不得伪装成功。 */
export class WitnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WitnessError';
  }
}

/** 见证只需快照的结构子集（避免与 persistence 产生运行时循环依赖）。 */
export interface WitnessSnapshotLike {
  workspaceDataId?: string;
  workspaceVersion: number;
  capacity: number;
  result: {
    selectedIds: string[];
    peakOccupancy: number;
  };
  capacityCalendar: CapacityCalendarSegment[];
}

export interface BuildWitnessInput {
  dataId: string;
  version: number;
  selectedIds: readonly string[];
  /** 当前工作区的全部作业（用于按导入下标定位与稳定排序） */
  jobs: readonly Job[];
  capacity: number;
  /** 生成见证所依据快照携带的同一容量日历 */
  calendar: readonly CapacityCalendarSegment[];
  /** 生成时间；省略时取当前时刻（测试可注入确定值） */
  generatedAt?: string;
}

const MAX_BOUND = 1_000_000_000;

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/** 构造前的输入结构检查：任何不一致都明确失败，而不是产出残缺见证。 */
function validateInputs(input: BuildWitnessInput): void {
  if (typeof input.dataId !== 'string' || input.dataId.length === 0) {
    throw new WitnessError('见证缺少有效的数据身份 dataId');
  }
  if (!isInt(input.version) || input.version < 1) {
    throw new WitnessError('见证绑定的工作区版本非法');
  }
  if (!isInt(input.capacity) || input.capacity < 1 || input.capacity > 8) {
    throw new WitnessError(`见证的 capacity 非法：${input.capacity}`);
  }
  if (!Array.isArray(input.selectedIds)) {
    throw new WitnessError('见证的入选集合不是数组');
  }
  if (!Array.isArray(input.calendar)) {
    throw new WitnessError('见证的容量日历不是数组');
  }
  // 日历范围以「全部工作区作业」为界（与导入校验一致）；无作业时只允许空日历
  let jobMinStart: number | null = null;
  let jobMaxEnd: number | null = null;
  for (const job of input.jobs) {
    if (
      !isInt(job.start) ||
      !isInt(job.end) ||
      job.start < 0 ||
      job.end > MAX_BOUND ||
      job.end <= job.start
    ) {
      throw new WitnessError(`作业 "${job.id}" 端点非法`);
    }
    jobMinStart = jobMinStart === null ? job.start : Math.min(jobMinStart, job.start);
    jobMaxEnd = jobMaxEnd === null ? job.end : Math.max(jobMaxEnd, job.end);
  }
  const seen = new Set<string>();
  for (const id of input.selectedIds) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new WitnessError('见证入选集合中存在空 id');
    }
    if (seen.has(id)) throw new WitnessError(`见证入选集合中 id 重复：${id}`);
    seen.add(id);
  }
  // 日历与导入校验同标准：结构、范围、互不重叠（允许端点相接）
  let prevEnd = -1;
  for (const seg of input.calendar) {
    if (
      !isInt(seg.start) ||
      !isInt(seg.end) ||
      !isInt(seg.available) ||
      seg.start < 0 ||
      seg.end > MAX_BOUND ||
      seg.end <= seg.start
    ) {
      throw new WitnessError('容量日历片段端点非法');
    }
    if (seg.available < 0 || seg.available > input.capacity - 1) {
      throw new WitnessError(`容量日历片段 available 非法：${seg.available}`);
    }
    if (jobMinStart !== null && (seg.start < jobMinStart || seg.end > (jobMaxEnd as number))) {
      throw new WitnessError('容量日历片段越出作业范围');
    }
    if (seg.start < prevEnd) {
      throw new WitnessError('容量日历片段相互重叠');
    }
    prevEnd = seg.end;
  }
}

function sameIdList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * 由一次成功求解的入选集合与容量日历生成只读容量占用见证。
 *
 * 时间轴切分与求解器使用同一坐标压缩（buildCapacityGrid：入选作业端点 +
 * 日历端点），保证逐格容量与求解约束完全一致。扫描线在每个坐标先结算
 * 结束（-1）、再结算开始（+1）——左闭右开，端点相接的两个作业不共处
 * 同一片段。随后把「有效容量相同且活动作业集合（同序）相同」的相邻
 * 小格合并为最大连续片段。
 */
export function buildOccupancyWitness(input: BuildWitnessInput): CapacityWitness {
  validateInputs(input);

  // id -> 作业 / 工作区导入下标；入选作业按下标升序（稳定排序）
  const indexById = new Map<string, number>();
  input.jobs.forEach((job, i) => {
    if (!indexById.has(job.id)) indexById.set(job.id, i);
  });
  const chosen: { job: Job; order: number }[] = [];
  for (const id of input.selectedIds) {
    const order = indexById.get(id);
    if (order === undefined) {
      // selectedIds 指向不存在的作业：最危险的伪造结果，见证必须失败
      throw new WitnessError(`入选作业 "${id}" 在当前工作区中不存在，无法生成见证`);
    }
    const job = input.jobs[order];
    if (
      !isInt(job.start) ||
      !isInt(job.end) ||
      job.start < 0 ||
      job.end > MAX_BOUND ||
      job.end <= job.start
    ) {
      throw new WitnessError(`入选作业 "${id}" 端点非法`);
    }
    chosen.push({ job, order });
  }
  chosen.sort((a, b) => a.order - b.order);

  // 统一时间格：入选作业端点 + 容量日历端点（与求解器同一构造）
  const selectedJobs = chosen.map((c) => c.job);
  const grid = buildCapacityGrid(selectedJobs, input.capacity, input.calendar);
  const coords = grid.coords;
  const m = coords.length - 1;

  // 无入选作业且日历无任何片段：时间轴为空（没有可见证的时间）
  if (m <= 0) {
    return {
      kind: WITNESS_KIND,
      witnessVersion: 1,
      workspaceDataId: input.dataId,
      workspaceVersion: input.version,
      selectedIds: [...input.selectedIds],
      generatedAt: input.generatedAt ?? new Date().toISOString(),
      segments: [],
    };
  }

  // 每个坐标上的开始/结束事件，事件项为 chosen 规范数组的下标
  const startsAt: number[][] = Array.from({ length: m + 1 }, () => []);
  const endsAt: number[][] = Array.from({ length: m + 1 }, () => []);
  chosen.forEach(({ job }, k) => {
    startsAt[grid.index.get(job.start)!].push(k);
    endsAt[grid.index.get(job.end)!].push(k);
  });

  // 扫描线：active 为 chosen 下标升序（故每格 id 清单天然按导入顺序稳定排序）
  const cellIds: string[][] = new Array(m);
  let active: number[] = [];
  for (let p = 0; p < m; p++) {
    if (endsAt[p].length > 0) {
      const leaving = new Set(endsAt[p]);
      active = active.filter((k) => !leaving.has(k));
    }
    for (const k of startsAt[p]) {
      // 按下标升序插入（活动深度 ≤ capacity ≤ 8，线性插入即可）
      let i = 0;
      while (i < active.length && active[i] < k) i++;
      active.splice(i, 0, k);
    }
    cellIds[p] = active.map((k) => chosen[k].job.id);
  }

  // 合并：相邻小格「有效容量相同 + 活动作业集合（同序）相同」才合并
  const segments: OccupancySegment[] = [];
  let runStart = 0;
  for (let p = 1; p <= m; p++) {
    const sameAsPrevious =
      p < m &&
      grid.cellCapacity[p] === grid.cellCapacity[p - 1] &&
      sameIdList(cellIds[p], cellIds[p - 1]);
    if (!sameAsPrevious) {
      const cap = grid.cellCapacity[runStart];
      const ids = cellIds[runStart];
      if (ids.length > cap) {
        // 与求解器容量约束矛盾：防御性失败，绝不输出超容见证
        throw new WitnessError(
          `时间片段 [${coords[runStart]}, ${coords[p]}) 占用 ${ids.length} 超过有效容量 ${cap}`,
        );
      }
      segments.push({
        start: coords[runStart],
        end: coords[p],
        capacity: cap,
        occupancy: ids.length,
        spare: cap - ids.length,
        jobIds: ids,
      });
      runStart = p;
    }
  }

  return {
    kind: WITNESS_KIND,
    witnessVersion: 1,
    workspaceDataId: input.dataId,
    workspaceVersion: input.version,
    selectedIds: [...input.selectedIds],
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    segments,
  };
}

/**
 * 轻量绑定闸门：见证只在 dataId、版本、入选集合三者与快照逐项一致时
 * 才允许附到该结果上（下载/展示前调用）。不做几何重算。
 */
export function witnessMatchesSnapshot(
  witness: CapacityWitness,
  snapshot: WitnessSnapshotLike,
): boolean {
  if (witness.kind !== WITNESS_KIND || witness.witnessVersion !== 1) return false;
  if (snapshot.workspaceDataId === undefined) return false;
  if (witness.workspaceDataId !== snapshot.workspaceDataId) return false;
  if (witness.workspaceVersion !== snapshot.workspaceVersion) return false;
  return sameIdList(witness.selectedIds, snapshot.result.selectedIds);
}

export type WitnessVerification = { ok: true } | { ok: false; reason: string };

/** 不依赖见证构造路径的有效容量：时刻 t 落在日历片段内取 available。 */
function effectiveCapacityAt(
  t: number,
  capacity: number,
  calendar: readonly CapacityCalendarSegment[],
): number {
  for (const seg of calendar) {
    if (seg.start <= t && t < seg.end) return seg.available;
  }
  return capacity;
}

/**
 * 下载/展示前的完整核对：
 *  1) 绑定三要素（dataId、版本、入选集合）；
 *  2) 用快照与工作区作业独立重建见证，逐片段深比较；
 *  3) 对见证本身做独立不变量检查（无缝铺满、容量/占用/余量自洽、
 *     作业清单稳定排序且完整覆盖、合并极大性、峰值一致）。
 * 任何一项不过都返回失败原因，调用方必须保持「不可下发」，
 * 绝不允许把旧见证/被篡改见证附到当前结果。
 */
export function verifyWitnessAgainstSnapshot(
  witness: CapacityWitness,
  snapshot: WitnessSnapshotLike,
  jobs: readonly Job[],
): WitnessVerification {
  const fail = (reason: string): WitnessVerification => ({ ok: false, reason });

  if (!witness || typeof witness !== 'object') return fail('见证不是对象');
  if (witness.kind !== WITNESS_KIND) return fail('见证 kind 标记不符');
  if (witness.witnessVersion !== 1) return fail('见证版本不受支持');
  if (snapshot.workspaceDataId === undefined) return fail('快照缺少数据身份，不能附见证');
  if (witness.workspaceDataId !== snapshot.workspaceDataId) {
    return fail('见证的数据身份与当前结果不一致');
  }
  if (witness.workspaceVersion !== snapshot.workspaceVersion) {
    return fail('见证的工作区版本与当前结果不一致（可能是约束变化前的旧见证）');
  }
  if (!sameIdList(witness.selectedIds, snapshot.result.selectedIds)) {
    return fail('见证的入选集合与当前结果不一致（可能是旧方案/迟到响应的旧见证）');
  }

  // 独立重建（generatedAt 保持一致以便整体比较）
  let rebuilt: CapacityWitness;
  try {
    rebuilt = buildOccupancyWitness({
      dataId: snapshot.workspaceDataId,
      version: snapshot.workspaceVersion,
      selectedIds: snapshot.result.selectedIds,
      jobs,
      capacity: snapshot.capacity,
      calendar: snapshot.capacityCalendar,
      generatedAt: witness.generatedAt,
    });
  } catch (err) {
    return fail(`见证无法从当前结果重建：${err instanceof Error ? err.message : String(err)}`);
  }
  if (JSON.stringify(rebuilt.segments) !== JSON.stringify(witness.segments)) {
    return fail('见证片段与按当前结果独立重建的占用时间轴不一致');
  }

  // ---- 对「传入的见证」做独立不变量检查（不引用重建结果） ----
  const orderById = new Map<string, number>();
  const jobById = new Map<string, Job>();
  jobs.forEach((job, i) => {
    orderById.set(job.id, i);
    jobById.set(job.id, job);
  });

  const segs = witness.segments;
  if (!Array.isArray(segs)) return fail('见证片段不是数组');

  // 独立扫描线（与构造路径不同实现：以见证片段边界为坐标做事件差分），
  // 线性算出每个片段「应当活动」的入选作业集合，再与片段清单逐一比对。
  // 事件挂在「片段下标」上：作业 start 所在片段加、end 所在片段（不含）减；
  // 末端点 hi 之后没有片段，落在那里的结束事件标记为 n（循环后自然丢弃）。
  const boundary = new Map<number, number>();
  segs.forEach((seg, i) => {
    boundary.set(seg.start, i);
    boundary.set(seg.end, i + 1); // end 恰是后一片段起点时被下一行覆盖为该起点下标
  });
  const addEvents = new Map<number, string[]>();
  const delEvents = new Map<number, string[]>();
  const pushEvent = (map: Map<number, string[]>, at: number, id: string): boolean => {
    const idx = boundary.get(at);
    if (idx === undefined) return false;
    const list = map.get(idx);
    if (list) list.push(id);
    else map.set(idx, [id]);
    return true;
  };

  // 期望覆盖域：入选作业端点 ∪ 日历端点的最小值/最大值
  let lo: number | null = null;
  let hi: number | null = null;
  for (const id of witness.selectedIds) {
    const job = jobById.get(id);
    if (!job) return fail(`见证作业 "${id}" 不存在于工作区`);
    lo = lo === null ? job.start : Math.min(lo, job.start);
    hi = hi === null ? job.end : Math.max(hi, job.end);
  }
  for (const seg of snapshot.capacityCalendar) {
    lo = lo === null ? seg.start : Math.min(lo, seg.start);
    hi = hi === null ? seg.end : Math.max(hi, seg.end);
  }
  if (lo === null || hi === null) {
    if (segs.length !== 0) return fail('无入选作业且无日历时见证必须为空时间轴');
  } else {
    if (segs.length === 0) return fail('时间轴非空但见证没有任何片段');
    if (segs[0].start !== lo) return fail('见证未从时间轴最早端点开始（存在缺口）');
    if (segs[segs.length - 1].end !== hi) return fail('见证未铺到时间轴最晚上端点（存在缺口）');
  }

  // 作业事件必须恰好落在见证边界上（否则片段无法忠实表达该作业的起止）
  for (const id of witness.selectedIds) {
    const job = jobById.get(id)!;
    if (!pushEvent(addEvents, job.start, id)) {
      return fail(`作业 "${id}" 的起点 ${job.start} 不是见证片段边界`);
    }
    if (!pushEvent(delEvents, job.end, id)) {
      return fail(`作业 "${id}" 的终点 ${job.end} 不是见证片段边界`);
    }
  }

  let measuredPeak = 0;
  let prevEnd: number | null = null;
  const expectedActive = new Set<string>();
  for (let i = 0; i < segs.length; i++) {
    // 半开扫描：先结算结束，再结算开始（相接端点不共处同一片段）
    for (const id of delEvents.get(i) ?? []) expectedActive.delete(id);
    for (const id of addEvents.get(i) ?? []) expectedActive.add(id);

    const seg = segs[i];
    if (!isInt(seg.start) || !isInt(seg.end) || seg.end <= seg.start) {
      return fail(`片段 #${i} 端点非法`);
    }
    if (prevEnd !== null && seg.start !== prevEnd) {
      return fail(`片段 #${i} 与前一片段未首尾相接（缝隙或重叠）`);
    }
    prevEnd = seg.end;

    // 有效容量独立由日历推导（片段内部不含日历端点，取左端点即可）
    const cap = effectiveCapacityAt(seg.start, snapshot.capacity, snapshot.capacityCalendar);
    if (seg.capacity !== cap) {
      return fail(`片段 [${seg.start}, ${seg.end}) 有效容量与容量日历不符`);
    }
    if (!Array.isArray(seg.jobIds)) return fail(`片段 #${i} 作业清单不是数组`);
    if (seg.occupancy !== seg.jobIds.length) {
      return fail(`片段 [${seg.start}, ${seg.end}) 占用数与作业清单长度不符`);
    }
    if (seg.spare !== seg.capacity - seg.occupancy) {
      return fail(`片段 [${seg.start}, ${seg.end}) 余量不等于容量-占用`);
    }
    if (seg.occupancy > seg.capacity) {
      return fail(`片段 [${seg.start}, ${seg.end}) 占用超过有效容量`);
    }

    // 清单稳定排序（工作区导入下标升序）、无重复，且每个作业完整跨越片段
    let lastOrder = -1;
    const idsHere = new Set<string>();
    for (const id of seg.jobIds) {
      const order = orderById.get(id);
      if (order === undefined) return fail(`片段作业 "${id}" 不存在于工作区`);
      if (idsHere.has(id)) return fail(`片段作业 "${id}" 重复`);
      idsHere.add(id);
      if (order <= lastOrder) return fail('片段作业清单未按导入顺序稳定排序');
      lastOrder = order;
      const job = jobById.get(id)!;
      if (!(job.start <= seg.start && job.end >= seg.end)) {
        return fail(`作业 "${id}" 未完整跨越其被列入的片段`);
      }
    }

    // 独立扫描集合必须恰好等于片段清单（防增删/防伪造占用）
    if (expectedActive.size !== idsHere.size) {
      return fail(`片段 [${seg.start}, ${seg.end}) 的活动作业集合与入选集合不符`);
    }
    for (const id of expectedActive) {
      if (!idsHere.has(id)) {
        return fail(`片段 [${seg.start}, ${seg.end}) 缺少应活动的作业 "${id}"`);
      }
    }
    // 清单中是否有不应活动的作业（集合大小相同时仍需反向确认）
    for (const id of idsHere) {
      if (!expectedActive.has(id)) {
        return fail(`片段 [${seg.start}, ${seg.end}) 列出了不应活动的作业 "${id}"`);
      }
    }

    // 合并极大性：相邻片段不得容量与集合都相同
    if (i > 0) {
      const prev = segs[i - 1];
      if (prev.capacity === seg.capacity && sameIdList(prev.jobIds, seg.jobIds)) {
        return fail('相邻同容量同作业集合的片段未被合并');
      }
    }

    if (seg.occupancy > measuredPeak) measuredPeak = seg.occupancy;
  }

  if (measuredPeak !== snapshot.result.peakOccupancy) {
    return fail('见证逐段占用的峰值与结果峰值不一致');
  }

  return { ok: true };
}
