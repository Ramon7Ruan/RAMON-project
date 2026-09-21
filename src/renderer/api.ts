import { CH } from '../shared/ipc';
import type {
  Concept, ConceptState, ConceptStatus, ContentMeta, Rating, SearchHit, UpdateInfo,
} from '../shared/types';
import type { ConceptSummary } from '../shared/summary';

interface RecallBridge {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  onEvent?(cb: (name: string, data: unknown) => void): void;
  platform?: string;
}

function bridge(): RecallBridge {
  const w = window as unknown as { recall?: RecallBridge };
  if (!w.recall) {
    throw new Error('未连接主进程：请通过 Electron 启动（npm start）');
  }
  return w.recall;
}

async function call<T>(channel: string, payload?: unknown): Promise<T> {
  return (await bridge().invoke(channel, payload)) as T;
}

export interface ImportResult {
  ok: boolean;
  reason?: string;
  version?: string;
  count?: number;
  backup?: string;
  issues?: { message: string }[];
}

export interface ImportPreviewDTO {
  ok: boolean;
  reason?: string;
  total: number;
  willUpdate: number;
  unchanged: number;
  older: number;
  orphans: number;
  favorites: number;
  schemaVersion: number;
  compatible: boolean;
  problems: string[];
}

export interface StatsDTO {
  meta: ContentMeta;
  total: number;
  known: number;
  reading: number;
  review: number;
  fuzzy: number;
  favorites: number;
  logs: number;
  tracks: { key: string; domain: string; label: string }[];
}

export type CheckResultDTO =
  | { kind: 'skipped'; reason: string }
  | { kind: 'update'; info: UpdateInfo };

export interface SettingsDTO {
  theme: string;
  autoCheckUpdate: boolean;
  manifestUrl: string;
  lastCheck: string;
  lastExport: string;
}

export const api = {
  meta: () => call<ContentMeta>(CH.contentMeta),
  listConcepts: () => call<ConceptSummary[]>(CH.contentList),
  getConcept: (id: string) => call<Concept | null>(CH.contentGet, { id }),
  search: (q: string) => call<SearchHit[]>(CH.contentSearch, { q }),

  checkUpdate: () => call<CheckResultDTO>(CH.contentCheckUpdate),
  applyUpdate: (info: UpdateInfo) => call<{ ok: boolean; reason?: string; version?: string }>(CH.contentApplyUpdate, info),
  importContent: (path: string) => call<ImportResult>(CH.contentImport, { path }),
  exportDist: () => call<{ manifestPath: string; jsonlPath: string; count: number; version: string }>(CH.contentExportDist),

  states: () => call<Record<string, ConceptState>>(CH.progressGetAll),
  setStatus: (id: string, status: ConceptStatus) => call<ConceptState>(CH.progressSet, { id, status }),
  rate: (id: string, rating: Rating) => call<ConceptState>(CH.progressReview, { id, rating }),
  dueQueue: () => call<string[]>(CH.progressDue),
  markRead: (id: string) => call<ConceptState>(CH.progressMarkRead, { id }),
  toggleFavorite: (id: string) => call<{ favorite: boolean }>(CH.progressToggleFav, { id }),
  favorites: () => call<string[]>(CH.progressFavorites),
  resetProgress: (confirm: string, keepFavorites: boolean) =>
    call<{ ok: boolean; cleared: number; reason?: string }>(CH.progressReset, { confirm, keepFavorites }),

  settings: () => call<SettingsDTO>(CH.settingsGet),
  saveSettings: (patch: Partial<SettingsDTO>) => call<SettingsDTO>(CH.settingsSet, patch),

  stats: () => call<StatsDTO>(CH.appStats),

  exportData: (path: string) => call<{ ok: boolean; path: string; count: number }>(CH.backupExport, { path }),
  previewImport: (path: string) => call<ImportPreviewDTO>(CH.backupPreview, { path }),
  importData: (path: string) => call<{ applied: number; favorites: number; orphans: number; skipped: number }>(CH.backupImport, { path }),
  listBackups: () => call<string[]>(CH.backupList),

  pickPath: (mode: 'openFile' | 'save' | 'content') => call<string | null>(CH.appPickPath, { mode }),

  /** 首屏可交互时上报，供冷启动计时 */
  signalReady: () => call<{ ok: boolean }>(CH.appReady),
};

/** 主进程事件订阅（内容更新可用）。非 Electron 环境静默忽略。 */
export function onAppEvent(cb: (name: string, data: unknown) => void): void {
  try {
    bridge().onEvent?.(cb);
  } catch {
    /* 忽略 */
  }
}
