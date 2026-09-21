import type {
  Concept, ConceptState, ConceptStatus, ContentMeta, Rating, SearchHit, UpdateInfo,
} from './types';
import type { ConceptSummary } from './summary';

export const CH = {
  contentMeta: 'content:meta',
  contentList: 'content:listConcepts',
  contentGet: 'content:getConcept',
  contentSearch: 'content:search',
  contentCheckUpdate: 'content:checkUpdate',
  contentApplyUpdate: 'content:applyUpdate',
  contentImport: 'content:importPackage',
  contentExportDist: 'content:exportDist',

  progressGetAll: 'progress:getAll',
  progressSet: 'progress:set',
  progressReview: 'progress:review',
  progressReset: 'progress:reset',
  progressDue: 'progress:dueQueue',
  progressMarkRead: 'progress:markRead',
  progressToggleFav: 'progress:toggleFav',
  progressFavorites: 'progress:favorites',

  settingsGet: 'settings:get',
  settingsSet: 'settings:set',

  backupExport: 'backup:export',
  backupPreview: 'backup:previewImport',
  backupImport: 'backup:import',
  backupList: 'backup:list',

  appStats: 'app:stats',
  appVersion: 'app:version',
  appReady: 'app:ready',
  appPickPath: 'app:pickPath',
} as const;

export type Channel = (typeof CH)[keyof typeof CH];

export interface StatsView {
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

export interface RecallApi {
  invoke(ch: string, payload?: unknown): Promise<unknown>;
  // 具体方法的类型在 renderer 侧包装
}

export type {
  Concept, ConceptState, ConceptStatus, ConceptSummary, ContentMeta, Rating, SearchHit, UpdateInfo,
};
