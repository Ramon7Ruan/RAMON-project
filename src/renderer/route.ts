import type { ConceptState, ConceptStatus, ContentMeta, Domain } from '@shared/types';
import type { ConceptSummary } from '@shared/summary';
import type { SettingsDTO, StatsDTO } from './api';

export type Route =
  | { name: 'home' }
  | { name: 'domain'; domain: Domain }
  | { name: 'concept'; id: string }
  | { name: 'review' }
  | { name: 'search' }
  | { name: 'settings' };

export interface PageCtx {
  summaries: ConceptSummary[];
  states: Record<string, ConceptState>;
  meta: ContentMeta;
  settings: SettingsDTO;
  stats: StatsDTO | null;
  go(r: Route): void;
  refresh(): Promise<void>;
  setLocalStatus(id: string, status: ConceptStatus): void;
  setLocalFav(id: string, favorite: boolean): void;
  favs: Set<string>;
}

export const statusOf = (ctx: PageCtx, id: string): ConceptStatus => ctx.states[id]?.status ?? 'unread';

export const domainOf = <T extends { domain: Domain }>(list: T[], d: Domain) => list.filter((c) => c.domain === d);
