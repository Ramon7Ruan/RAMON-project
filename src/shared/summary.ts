import type { Concept } from './types';

/**
 * 要点速览页所需的字段集合 —— 不含 blocks / links。
 * 单独放一个文件是为了避免 content.ts ↔ ipc.ts 之间的循环引用。
 */
export type ConceptSummary = Omit<Concept, 'blocks' | 'links'>;
