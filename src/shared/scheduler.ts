import type { ConceptState, Rating } from './types';

/**
 * 间隔重复调度器 —— SM-2 简化版（PRD §4.3）
 *
 * 硬约束：本文件必须是**纯函数**，不碰数据库、不碰 IO、不读系统时间。
 * 当前时间由调用方传入，这样算法可以脱离 Electron 独立做单元测试。
 */

export const EASE_MIN = 1.3;
export const EASE_MAX = 3.0;
export const EASE_DEFAULT = 2.5;

export interface ReviewInput {
  prev: Pick<ConceptState, 'ease' | 'interval_days' | 'reps' | 'lapses'>;
  rating: Rating;
  now: Date;
}

export interface ReviewOutput {
  ease: number;
  interval_days: number;
  due_at: string;
  reps: number;
  lapses: number;
  status: 'known' | 'reading' | 'review';
  last_review: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function isoDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 在基准日期上加 n 天（按自然日推进，不受时分秒影响） */
function addDays(base: Date, n: number): Date {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  d.setDate(d.getDate() + n);
  return d;
}

export function defaultState(conceptId: string): ConceptState {
  return {
    concept_id: conceptId,
    status: 'unread',
    ease: EASE_DEFAULT,
    interval_days: 0,
    due_at: null,
    reps: 0,
    lapses: 0,
    last_review: null,
  };
}

export function review(input: ReviewInput): ReviewOutput {
  const { prev, rating, now } = input;

  // 防御：脏数据不得让算法崩掉，一律夹到合法区间
  const prevEase = clamp(
    Number.isFinite(prev.ease) ? prev.ease : EASE_DEFAULT,
    EASE_MIN,
    EASE_MAX,
  );
  const prevInterval = Number.isFinite(prev.interval_days) && prev.interval_days > 0
    ? prev.interval_days
    : 0;
  const prevReps = Number.isFinite(prev.reps) && prev.reps >= 0 ? prev.reps : 0;
  const prevLapses = Number.isFinite(prev.lapses) && prev.lapses >= 0 ? prev.lapses : 0;

  let ease = prevEase;
  let interval: number;
  let reps = prevReps;
  let lapses = prevLapses;
  let status: ReviewOutput['status'];

  if (rating === 0) {
    // 忘了：难度上调（ease 下调），间隔重置为 1 天
    ease = clamp(prevEase - 0.2, EASE_MIN, EASE_MAX);
    lapses = prevLapses + 1;
    interval = 1;
    status = 'review';
  } else if (rating === 1) {
    // 模糊：间隔温和增长，ease 略降
    ease = clamp(prevEase - 0.15, EASE_MIN, EASE_MAX);
    interval = prevInterval > 0 ? prevInterval * 1.2 : 1;
    status = 'reading';
  } else {
    // 记得：间隔按 ease 增长
    ease = clamp(prevEase + 0.1, EASE_MIN, EASE_MAX);
    interval = prevInterval > 0 ? prevInterval * ease : 2;
    reps = prevReps + 1;
    status = 'known';
  }

  // 间隔按整数天存，至少 1 天
  const intervalDays = Math.max(1, Math.round(interval));
  const due = addDays(now, intervalDays);

  return {
    ease: Math.round(ease * 1000) / 1000,
    interval_days: intervalDays,
    due_at: isoDay(due),
    reps,
    lapses,
    status,
    last_review: now.toISOString(),
  };
}

/**
 * 是否到期该复习。
 *
 * 语义澄清（重要）：**由 due_at 决定，不看 status**。
 *   - 复习评分「记得」→ status=known 但仍有 due_at → 到日子必须再出现，
 *     否则间隔重复就退化成"一次过"，永远不会二次复习
 *   - 概念页手动点「我掌握了」→ 用户主动断言已掌握 → 清空 due_at，才真正移出队列
 * status 只是"上次发生了什么"的展示标签，不是调度依据。
 */
export function isDue(state: Pick<ConceptState, 'due_at'>, today: Date): boolean {
  if (!state.due_at) return false;
  return state.due_at <= isoDay(today);
}

export { isoDay, DAY_MS };
