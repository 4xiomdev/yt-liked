export interface YtBootstrapConfig {
  INNERTUBE_API_KEY: string;
  INNERTUBE_CLIENT_VERSION: string;
  VISITOR_DATA: string;
  HL?: string;
  GL?: string;
  SESSION_INDEX?: string | number;
  [key: string]: unknown;
}

export interface YtBootstrapPayload {
  apiKey: string;
  clientVersion: string;
  visitorData: string;
  sessionIndex: string;
  hl: string;
  gl: string;
  dataSyncId: string;
  continuationToken: string;
  pageTitle: string;
  statedVideoCount: number | null;
  alerts: string[];
}

export type SyncCaptureMethod = 'http_replay' | 'browser_network' | 'browser_dom';

export interface SyncMethodReport {
  method: SyncCaptureMethod;
  storedCount: number;
  discoveredCount: number;
  maxIndex: number | null;
  stopReason: string;
  beatBaseline: boolean;
}

export interface SyncReport {
  generatedAt: string;
  chromeUserDataDir: string;
  chromeProfileDirectory: string;
  pageTitle: string;
  statedVideoCount: number | null;
  alertMessages: string[];
  baselineCeiling: number;
  proofPassed: boolean;
  winningMethod: SyncCaptureMethod | null;
  totalStored: number;
  latestSuccessfulIndex: number | null;
  stopReason: string;
  methods: SyncMethodReport[];
  debugArtifacts: string[];
}

export interface ImportedVideoInput {
  playlist_item_id?: string | null;
  video_id?: string | null;
  title?: string | null;
  description?: string | null;
  url?: string | null;
  channel_id?: string | null;
  channel_title?: string | null;
  published_at?: string | null;
  video_published_at?: string | null;
  duration?: string | null;
  privacy_status?: string | null;
  position?: number | null;
  primary_category?: string | null;
  categories?: string[] | string | null;
  tags?: string[] | string | null;
  domains?: string[] | string | null;
  primary_domain?: string | null;
  classification_reason?: string | null;
  classification_engine?: string | null;
  classification_model?: string | null;
  classified_at?: string | null;
  [key: string]: unknown;
}

export interface VideoRecord {
  id: string;
  video_id: string | null;
  playlist_item_id: string | null;
  url: string;
  title: string;
  description: string | null;
  channel_id: string | null;
  channel_title: string | null;
  liked_at: string | null;
  video_published_at: string | null;
  duration: string | null;
  privacy_status: string | null;
  position: number | null;
  categories: string[] | null;
  primary_category: string | null;
  domains: string[] | null;
  primary_domain: string | null;
  classification_reason: string | null;
  classification_engine: string | null;
  classification_model: string | null;
  classified_at: string | null;
  thumbnails: string[] | null;
  view_count_text: string | null;
  sync_capture_method: SyncCaptureMethod | null;
  sync_surface: string | null;
  sync_page: number | null;
  sync_index: number | null;
  sync_source_id: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  imported_at: string;
}

export interface VideoStatusView {
  importedCount: number;
  categorizedCount: number;
  domainCount: number;
  lastClassificationEngine: string | null;
  lastClassificationModel: string | null;
  lastSyncAt: string | null;
  lastSyncMethod: SyncCaptureMethod | null;
  lastSyncModelStopReason: string | null;
  lastSyncLatestIndex: number | null;
  syncExceededWall: boolean;
  lastSync: SyncReport | null;
}

export interface VideoSearchResult {
  id: string;
  url: string;
  title: string;
  description: string | null;
  channelTitle: string | null;
  likedAt: string | null;
  primaryCategory: string | null;
  primaryDomain: string | null;
  score: number;
}

export interface VideoTimelineFilters {
  query?: string;
  channel?: string;
  after?: string;
  before?: string;
  category?: string;
  domain?: string;
  privacy?: string;
  sort?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface LabelCount {
  label: string;
  count: number;
}

export interface ChannelCount {
  channelTitle: string;
  count: number;
}

export interface VideoVizView {
  importedCount: number;
  categorizedCount: number;
  domainCount: number;
  uncategorizedCount: number;
  undomainedCount: number;
  topCategories: LabelCount[];
  topDomains: LabelCount[];
  topChannels: ChannelCount[];
  monthlyLikes: LabelCount[];
  privacyBreakdown: LabelCount[];
  distinctChannelTitles: number;
  distinctChannelIds: number;
  channelMetadataLikelyOwnerFallback: boolean;
  dominantFallbackChannelTitle: string | null;
  dominantFallbackChannelCount: number;
}

export interface ClassificationItem {
  id: string;
  title: string;
  description: string | null;
  channelTitle: string | null;
  duration: string | null;
  privacyStatus: string | null;
  existingCategories: string[] | null;
}

export interface ClassificationResult {
  id: string;
  categories: string[];
  primary: string;
  reason: string | null;
}

export type Engine = 'gemini' | 'claude' | 'codex';

export interface ClassifyRunSummary {
  engine: Engine;
  model?: string;
  totalPending: number;
  classified: number;
  failed: number;
  batches: number;
}

export interface ChannelEnrichmentSummary {
  attempted: number;
  updated: number;
  failed: number;
  skipped: number;
  dominantFallbackTitle: string | null;
  dominantFallbackId: string | null;
}
