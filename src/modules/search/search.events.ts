export const SEARCH_EVENTS = {
  SETTINGS_BEFORE_WRITE: 'search-settings.before-write',
  SETTINGS_UPDATED: 'search-settings.updated',
  SWITCH_STARTED: 'search-settings.switch-started',
  SWITCHED: 'search-settings.switched',
  SWITCH_FAILED: 'search-settings.switch-failed',
  DOCUMENTS_BEFORE_WRITE: 'search.documents-before-write',
  /** Postgres documents changed — pushed to the website's external engine(s). */
  DOCUMENTS_CHANGED: 'search.documents-changed',
} as const;

export interface DocumentsChangedData {
  storeId: string;
  localeCode: string;
  upserted: string[];
  removed: string[];
}

export interface SearchSettingsEventData {
  websiteId: string;
}
