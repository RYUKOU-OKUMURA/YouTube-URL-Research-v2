/**
 * @fileoverview
 * YouTube Data APIから動画URLを取得するGoogle Apps Script。
 * 曖昧なキーワードでも精度高く候補を集めるため、
 * 候補収集 -> プロフィール解決 -> 関連度スコアリング -> 閾値判定で結果を返す。
 */

// =================================================================
//
//   SECTION 1: CONSTANTS
//
// =================================================================

const YOUTUBE_SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';
const YOUTUBE_CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels';
const YOUTUBE_PLAYLIST_ITEMS_URL = 'https://www.googleapis.com/youtube/v3/playlistItems';
const YOUTUBE_VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos';

const SEARCH_PAGE_SIZE = 50;
const MAX_SEARCH_PAGES = 10; // search.list は最大 500 件まで
const DEFAULT_MAX_RESULTS = 25;
const MAX_RESULTS_LIMIT = SEARCH_PAGE_SIZE * MAX_SEARCH_PAGES;
const MAX_CANDIDATE_POOL = 150;
const CANDIDATE_POOL_MULTIPLIER = 5;

const SEARCH_ORDER_OPTIONS = ['relevance', 'date', 'viewCount', 'title'];
const CHANNEL_ORDER_OPTIONS = ['date', 'viewCount', 'title'];
const STRICTNESS_OPTIONS = ['precision', 'balanced', 'recall'];
const DEFAULT_STRICTNESS = 'precision';
const RELAXED_STRICTNESS_MAP = {
  precision: 'balanced',
  balanced: 'recall'
};
const RELEVANCE_SCORE_THRESHOLDS = {
  precision: 12,
  balanced: 8,
  recall: 4
};

const DEFAULT_RELEVANCE_LANGUAGE = '';
const DEFAULT_REGION_CODE = '';
const SUPPORTED_RELEVANCE_LANGUAGES = ['', 'ja', 'en'];
const SUPPORTED_REGION_CODES = ['', 'JP', 'US'];
const LANGUAGE_SCORE_BOOST = 3;

const CATEGORY_IDS = {
  FILM_ANIMATION: '1',
  MUSIC: '10',
  GAMING: '20',
  ENTERTAINMENT: '24',
  EDUCATION: '27',
  SCIENCE_TECHNOLOGY: '28'
};

const SEARCH_PROFILES = [
  {
    id: 'obsidian',
    aliases: ['obsidian', 'obsidian app'],
    positiveTerms: ['notes', 'markdown', 'vault', 'pkm', 'plugin'],
    negativeTerms: ['game', 'gaming', 'movie', 'soundtrack', 'trailer', 'ost'],
    hardNegativeTerms: ['game', 'gaming', 'movie', 'soundtrack', 'trailer', 'ost'],
    preferredCategories: [CATEGORY_IDS.EDUCATION, CATEGORY_IDS.SCIENCE_TECHNOLOGY],
    blockedCategories: [
      CATEGORY_IDS.FILM_ANIMATION,
      CATEGORY_IDS.MUSIC,
      CATEGORY_IDS.GAMING,
      CATEGORY_IDS.ENTERTAINMENT
    ],
    requiredSignals: ['notes', 'markdown', 'vault', 'pkm', 'plugin', 'second brain']
  },
  {
    id: 'google-ai-studio',
    aliases: ['google ai studio', 'gemini ai studio'],
    positiveTerms: ['google', 'gemini', 'prompt', 'api', 'studio google', 'developers'],
    negativeTerms: ['music', 'artist', 'movie', 'trailer', 'fanmade'],
    hardNegativeTerms: ['music', 'artist', 'movie', 'trailer', 'fanmade'],
    preferredCategories: [CATEGORY_IDS.EDUCATION, CATEGORY_IDS.SCIENCE_TECHNOLOGY],
    blockedCategories: [
      CATEGORY_IDS.FILM_ANIMATION,
      CATEGORY_IDS.MUSIC,
      CATEGORY_IDS.ENTERTAINMENT
    ],
    requiredSignals: ['google', 'gemini', 'prompt', 'api', 'studio google', 'developers']
  }
];

// =================================================================
//
//   SECTION 2: WEB APP CORE FUNCTIONS
//
// =================================================================

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('YouTube URL Research v2');
}

// =================================================================
//
//   SECTION 3: BACKEND FUNCTIONS CALLED FROM HTML
//
// =================================================================

/**
 * 【HTMLから呼び出し】
 * YouTube全体または特定チャンネル内を対象に動画検索を行う。
 * @param {{
 *   channelId?: string,
 *   searchQuery?: string,
 *   requiredTerms?: string[]|string,
 *   excludedTerms?: string[]|string,
 *   exactPhrases?: string[]|string,
 *   strictness?: string,
 *   relevanceLanguage?: string,
 *   regionCode?: string,
 *   publishedAfter?: string,
 *   publishedBefore?: string,
 *   minViews?: number|string,
 *   maxViews?: number|string,
 *   minLikes?: number|string,
 *   maxLikes?: number|string,
 *   order?: string,
 *   maxResults?: number|string
 * }} rawOptions
 * @returns {Array<Object>}
 */
function searchYouTubeVideos(rawOptions) {
  let options = prepareSearchOptions_(rawOptions, {
    allowedOrders: SEARCH_ORDER_OPTIONS,
    fallbackOrder: 'relevance'
  });

  if (!options.channelId && !hasPositiveQuery_(options)) {
    throw new Error('YouTube全体を検索する場合は、検索キーワード・必須語・完全一致フレーズのいずれかを入力してください。');
  }

  if (!hasRelevanceIntent_(options, null) && options.order === 'relevance') {
    options = Object.assign({}, options, { order: 'date' });
  }

  const apiKey = getApiKeyOrThrow_();
  const profile = resolveSearchProfile_(options);

  try {
    const candidateVideos = fetchSearchModeCandidateVideos_(options, profile, apiKey);
    return finalizeVideoCollection_(candidateVideos, options, profile, {
      forceRelevanceRanking: true,
      preserveApiOrderWithoutRelevance: false
    });
  } catch (e) {
    console.error('検索中にエラーが発生しました: ' + e.toString());
    throw new Error(e.message || 'YouTube検索に失敗しました。');
  }
}

/**
 * 【HTMLから呼び出し】
 * 指定されたチャンネルIDから動画一覧を取得し、条件で絞り込んで返す。
 * @param {string} channelId
 * @param {{
 *   searchQuery?: string,
 *   requiredTerms?: string[]|string,
 *   excludedTerms?: string[]|string,
 *   exactPhrases?: string[]|string,
 *   strictness?: string,
 *   relevanceLanguage?: string,
 *   regionCode?: string,
 *   publishedAfter?: string,
 *   publishedBefore?: string,
 *   minViews?: number|string,
 *   maxViews?: number|string,
 *   minLikes?: number|string,
 *   maxLikes?: number|string,
 *   order?: string,
 *   maxResults?: number|string
 * }} rawOptions
 * @returns {Array<Object>}
 */
function getAllVideoUrlsFromChannelId(channelId, rawOptions) {
  if (!channelId) {
    throw new Error('チャンネルIDを指定してください。');
  }

  const options = prepareSearchOptions_(
    Object.assign({}, rawOptions, { channelId: channelId }),
    {
      allowedOrders: CHANNEL_ORDER_OPTIONS,
      fallbackOrder: 'date'
    }
  );
  const apiKey = getApiKeyOrThrow_();
  const profile = resolveSearchProfile_(options);

  try {
    const uploadsPlaylistId = fetchUploadsPlaylistId_(options.channelId, apiKey);
    const videos = [];
    const seenVideoIds = {};
    let nextPageToken = null;

    do {
      const params = {
        part: 'contentDetails',
        playlistId: uploadsPlaylistId,
        maxResults: SEARCH_PAGE_SIZE,
        key: apiKey
      };
      const url = `${YOUTUBE_PLAYLIST_ITEMS_URL}?${buildQueryString(params, nextPageToken)}`;
      const playlistData = fetchJson_(url);
      const playlistItems = Array.isArray(playlistData.items) ? playlistData.items : [];

      if (playlistItems.length) {
        const videoIds = playlistItems
          .map(extractVideoIdFromPlaylistItem_)
          .filter(Boolean);

        const detailedVideos = fetchVideosByIds_(videoIds, apiKey);
        detailedVideos.forEach(video => {
          if (!seenVideoIds[video.videoId]) {
            seenVideoIds[video.videoId] = true;
            videos.push(video);
          }
        });
      }

      nextPageToken = playlistData.nextPageToken || null;
    } while (nextPageToken);

    return finalizeVideoCollection_(videos, options, profile, {
      forceRelevanceRanking: false,
      preserveApiOrderWithoutRelevance: false
    });
  } catch (e) {
    console.error('チャンネル動画取得中にエラーが発生しました: ' + e.toString());
    throw new Error(e.message || 'チャンネル動画の取得に失敗しました。');
  }
}

/**
 * 旧フロントエンド互換ラッパー。
 * @param {string} channelId
 * @param {string} searchQuery
 * @param {string} publishedAfter
 * @param {string} publishedBefore
 * @returns {Array<Object>}
 */
function searchVideosInChannel(channelId, searchQuery, publishedAfter, publishedBefore) {
  return searchYouTubeVideos({
    channelId: channelId,
    searchQuery: searchQuery,
    publishedAfter: publishedAfter,
    publishedBefore: publishedBefore,
    order: 'date',
    maxResults: MAX_RESULTS_LIMIT
  });
}

// =================================================================
//
//   SECTION 4: SEARCH PIPELINE
//
// =================================================================

function finalizeVideoCollection_(videos, options, profile, config) {
  const uniqueVideos = dedupeVideos_(videos);
  const shouldUseRelevance = config.forceRelevanceRanking || hasRelevanceIntent_(options, profile);
  const processedVideos = shouldUseRelevance
    ? rankAndThresholdVideos_(uniqueVideos, options, profile)
    : uniqueVideos.slice();
  const filteredVideos = applyPostRelevanceFilters_(processedVideos, options);

  return finalizeVideoResults_(filteredVideos, options, {
    useRelevanceRanking: shouldUseRelevance,
    preserveApiOrder: Boolean(config.preserveApiOrderWithoutRelevance) && !shouldUseRelevance
  });
}

function fetchSearchModeCandidateVideos_(options, profile, apiKey) {
  const targetCandidateCount = getTargetCandidateCount_(options.maxResults);
  const queries = buildSearchPassQueries_(options, profile);
  const collectedVideos = [];
  const seenVideoIds = {};
  let pagesRemaining = MAX_SEARCH_PAGES;

  queries.forEach((query, index) => {
    if (pagesRemaining <= 0) {
      return;
    }
    if (!query && !options.channelId) {
      return;
    }

    let nextPageToken = null;

    do {
      if (pagesRemaining <= 0 || Object.keys(seenVideoIds).length >= targetCandidateCount) {
        break;
      }

      pagesRemaining -= 1;
      const params = buildSearchApiParams_(options, apiKey, query);
      const url = `${YOUTUBE_SEARCH_URL}?${buildQueryString(params, nextPageToken)}`;
      const data = fetchJson_(url);
      const searchItems = Array.isArray(data.items) ? data.items : [];

      if (!searchItems.length) {
        break;
      }

      const detailedVideos = hydrateSearchResultsWithVideoDetails_(searchItems, apiKey);
      detailedVideos.forEach(video => {
        if (!seenVideoIds[video.videoId]) {
          seenVideoIds[video.videoId] = true;
          collectedVideos.push(video);
        }
      });

      nextPageToken = data.nextPageToken || null;
    } while (nextPageToken);

    if (index === 0 && Object.keys(seenVideoIds).length >= targetCandidateCount) {
      return;
    }
  });

  return collectedVideos;
}

function buildSearchApiParams_(options, apiKey, query) {
  const params = {
    part: 'snippet',
    type: 'video',
    maxResults: SEARCH_PAGE_SIZE,
    order: options.order,
    key: apiKey
  };

  if (options.channelId) {
    params.channelId = options.channelId;
  }
  if (query) {
    params.q = query;
  }
  if (options.publishedAfterRfc3339) {
    params.publishedAfter = options.publishedAfterRfc3339;
  }
  if (options.publishedBeforeRfc3339Exclusive) {
    params.publishedBefore = options.publishedBeforeRfc3339Exclusive;
  }
  if (options.relevanceLanguage) {
    params.relevanceLanguage = options.relevanceLanguage;
  }
  if (options.regionCode) {
    params.regionCode = options.regionCode;
  }

  return params;
}

function buildSearchPassQueries_(options, profile) {
  const baseQuery = buildBaseSearchQuery_(options);
  const passA = buildSearchQueryString_(
    [baseQuery],
    options.exactPhrases,
    options.excludedTerms
  );

  const queries = [];
  if (passA) {
    queries.push(passA);
  }

  if (profile) {
    const supplementalTerms = profile.positiveTerms
      .filter(term => options.searchTokens.indexOf(normalizeMatchText_(term)) < 0)
      .slice(0, 2);
    const passB = buildSearchQueryString_(
      [baseQuery].concat(supplementalTerms),
      options.exactPhrases,
      options.excludedTerms
    );
    if (passB && queries.indexOf(passB) < 0) {
      queries.push(passB);
    }
  }

  if (!queries.length && options.channelId) {
    queries.push('');
  }

  return queries;
}

function buildBaseSearchQuery_(options) {
  if (options.searchQuery) {
    return options.searchQuery;
  }
  if (options.exactPhrases.length) {
    return options.exactPhrases[0];
  }
  if (options.requiredTerms.length) {
    return options.requiredTerms.slice(0, 2).join(' ');
  }
  return '';
}

function buildSearchQueryString_(baseParts, exactPhrases, excludedTerms) {
  const parts = [];

  baseParts.forEach(part => {
    if (part) {
      parts.push(String(part).trim());
    }
  });

  exactPhrases.forEach(phrase => {
    const trimmedPhrase = String(phrase).trim();
    if (!trimmedPhrase) {
      return;
    }
    const quotedPhrase = trimmedPhrase.indexOf(' ') >= 0
      ? `"${trimmedPhrase}"`
      : trimmedPhrase;
    if (parts.indexOf(quotedPhrase) < 0 && parts.indexOf(trimmedPhrase) < 0) {
      parts.push(quotedPhrase);
    }
  });

  excludedTerms.forEach(term => {
    const trimmedTerm = String(term).trim();
    if (!trimmedTerm) {
      return;
    }
    const excludedValue = trimmedTerm.indexOf(' ') >= 0
      ? `-"${trimmedTerm}"`
      : `-${trimmedTerm}`;
    if (parts.indexOf(excludedValue) < 0) {
      parts.push(excludedValue);
    }
  });

  return parts.join(' ').trim();
}

function rankAndThresholdVideos_(videos, options, profile) {
  const analyses = videos.map(video => buildRelevanceAnalysis_(video, options, profile));
  let filteredVideos = filterRelevanceAnalyses_(analyses, options.strictness);

  const relaxedStrictness = RELAXED_STRICTNESS_MAP[options.strictness];
  if (!filteredVideos.length && relaxedStrictness) {
    filteredVideos = filterRelevanceAnalyses_(analyses, relaxedStrictness);
    if (filteredVideos.length) {
      filteredVideos.forEach(video => {
        if (video.relevanceReasons.indexOf('しきい値緩和') < 0) {
          video.relevanceReasons.push('しきい値緩和');
        }
      });
    }
  }

  return sortVideosByRelevance_(filteredVideos, options.order);
}

function filterRelevanceAnalyses_(analyses, strictness) {
  const threshold = RELEVANCE_SCORE_THRESHOLDS[strictness] || RELEVANCE_SCORE_THRESHOLDS[DEFAULT_STRICTNESS];

  return analyses
    .filter(analysis => {
      if (analysis.userExcludedInTitle) {
        return false;
      }
      if (analysis.missingRequiredTerms.length) {
        return false;
      }
      if (strictness === 'precision' && analysis.profileHardNegativeInTitle) {
        return false;
      }
      if (strictness === 'precision' && analysis.profileRequiredSignalsMissing) {
        return false;
      }
      if (analysis.score < threshold) {
        return false;
      }
      return true;
    })
    .map(analysis => analysis.video);
}

function buildRelevanceAnalysis_(video, options, profile) {
  const document = buildVideoSearchDocument_(video);
  const reasonEntries = [];
  const positiveTerms = dedupeStringArray_(options.requiredTerms.concat(profile ? profile.positiveTerms : []));
  const negativeTerms = dedupeStringArray_(options.excludedTerms.concat(profile ? profile.negativeTerms : []));
  let score = 0;

  options.exactPhrases.forEach(phrase => {
    if (matchesField_(document.title, phrase)) {
      score += 15;
      reasonEntries.push({ weight: 15, label: `タイトル完全一致: ${phrase}` });
    }
  });

  if (profile) {
    const matchedAlias = findMatchedAlias_(document.title, profile.aliases);
    if (matchedAlias) {
      score += 10;
      reasonEntries.push({ weight: 10, label: `プロフィール一致: ${matchedAlias}` });
    }
  }

  options.searchTokens.forEach(token => {
    if (matchesField_(document.title, token)) {
      score += 6;
      reasonEntries.push({ weight: 6, label: `タイトル一致: ${token}` });
    }
  });

  positiveTerms.forEach(term => {
    if (matchesField_(document.title, term)) {
      score += 6;
      reasonEntries.push({ weight: 6, label: `タイトル補強: ${term}` });
    }
    if (matchesField_(document.tags, term)) {
      score += 4;
      reasonEntries.push({ weight: 4, label: `タグ補強: ${term}` });
    }
    if (matchesField_(document.channelTitle, term)) {
      score += 3;
      reasonEntries.push({ weight: 3, label: `チャンネル一致: ${term}` });
    }
    if (matchesField_(document.description, term)) {
      score += 2;
      reasonEntries.push({ weight: 2, label: `説明文一致: ${term}` });
    }
  });

  negativeTerms.forEach(term => {
    if (matchesField_(document.title, term)) {
      score -= 12;
      reasonEntries.push({ weight: -12, label: `除外語ヒット: ${term}` });
    }
    if (matchesField_(document.tags, term)) {
      score -= 8;
      reasonEntries.push({ weight: -8, label: `タグ除外語: ${term}` });
    }
    if (matchesField_(document.channelTitle, term)) {
      score -= 6;
      reasonEntries.push({ weight: -6, label: `チャンネル除外語: ${term}` });
    }
    if (matchesField_(document.description, term)) {
      score -= 4;
      reasonEntries.push({ weight: -4, label: `説明文除外語: ${term}` });
    }
  });

  if (profile && profile.preferredCategories.indexOf(video.categoryId) >= 0) {
    score += 6;
    reasonEntries.push({ weight: 6, label: '技術系カテゴリ' });
  }

  if (profile && profile.blockedCategories.indexOf(video.categoryId) >= 0) {
    score -= 8;
    reasonEntries.push({ weight: -8, label: 'ノイズカテゴリ' });
  }

  if (options.relevanceLanguage && videoMatchesLanguage_(video, options.relevanceLanguage)) {
    score += LANGUAGE_SCORE_BOOST;
    reasonEntries.push({ weight: LANGUAGE_SCORE_BOOST, label: `言語一致: ${options.relevanceLanguage}` });
  }

  const userExcludedInTitle = options.excludedTerms.some(term => matchesField_(document.title, term));
  const profileHardNegativeInTitle = Boolean(profile)
    && (profile.hardNegativeTerms || []).some(term => matchesField_(document.title, term));
  const missingRequiredTerms = options.requiredTerms.filter(term => !matchesField_(document.all, term));
  const profileRequiredSignalsMissing = Boolean(profile)
    && profile.requiredSignals.length > 0
    && !profile.requiredSignals.some(signal => matchesField_(document.all, signal));

  const orderedReasons = buildOrderedReasonLabels_(reasonEntries);
  video.relevanceScore = score;
  video.relevanceReasons = orderedReasons;
  video.matchedProfile = profile ? profile.id : null;

  return {
    video: video,
    score: score,
    userExcludedInTitle: userExcludedInTitle,
    profileHardNegativeInTitle: profileHardNegativeInTitle,
    missingRequiredTerms: missingRequiredTerms,
    profileRequiredSignalsMissing: profileRequiredSignalsMissing
  };
}

// =================================================================
//
//   SECTION 5: FETCH HELPERS
//
// =================================================================

function getApiKeyOrThrow_() {
  const apiKey = PropertiesService.getScriptProperties().getProperty('YOUTUBE_API_KEY');
  if (!apiKey) {
    throw new Error('APIキーが設定されていません。');
  }
  return apiKey;
}

function fetchUploadsPlaylistId_(channelId, apiKey) {
  const params = {
    part: 'contentDetails',
    id: channelId,
    key: apiKey
  };
  const url = `${YOUTUBE_CHANNELS_URL}?${buildQueryString(params)}`;
  const data = fetchJson_(url);

  if (!data.items || !data.items.length) {
    throw new Error('チャンネルが見つかりませんでした。');
  }

  return data.items[0].contentDetails.relatedPlaylists.uploads;
}

function hydrateSearchResultsWithVideoDetails_(searchItems, apiKey) {
  const orderedVideoIds = [];
  const fallbackSnippets = {};

  searchItems.forEach(item => {
    const videoId = item && item.id && item.id.videoId;
    if (!videoId) {
      return;
    }
    orderedVideoIds.push(videoId);
    fallbackSnippets[videoId] = item.snippet || {};
  });

  const detailedVideos = fetchVideosByIds_(orderedVideoIds, apiKey);
  const detailedVideoMap = {};
  detailedVideos.forEach(video => {
    detailedVideoMap[video.videoId] = video;
  });

  return orderedVideoIds.map(videoId => {
    if (detailedVideoMap[videoId]) {
      return detailedVideoMap[videoId];
    }
    return buildVideoResult_({
      id: videoId,
      snippet: fallbackSnippets[videoId],
      statistics: {}
    });
  });
}

function fetchVideosByIds_(videoIds, apiKey) {
  const dedupedIds = dedupeStringArray_(videoIds).filter(Boolean);
  const videos = [];

  for (let i = 0; i < dedupedIds.length; i += SEARCH_PAGE_SIZE) {
    const idBatch = dedupedIds.slice(i, i + SEARCH_PAGE_SIZE);
    const params = {
      part: 'snippet,statistics',
      id: idBatch.join(','),
      key: apiKey
    };
    const url = `${YOUTUBE_VIDEOS_URL}?${buildQueryString(params)}`;
    const data = fetchJson_(url);
    const items = Array.isArray(data.items) ? data.items : [];

    items.forEach(item => {
      videos.push(buildVideoResult_(item));
    });
  }

  return videos;
}

function buildVideoResult_(item) {
  const snippet = item && item.snippet ? item.snippet : {};
  const statistics = item && item.statistics ? item.statistics : {};
  const videoId = item && item.id ? item.id : '';

  return {
    videoId: videoId,
    title: snippet.title || '',
    description: snippet.description || '',
    tags: Array.isArray(snippet.tags) ? snippet.tags.slice() : [],
    categoryId: snippet.categoryId || '',
    defaultLanguage: snippet.defaultLanguage || '',
    defaultAudioLanguage: snippet.defaultAudioLanguage || '',
    url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : '',
    publishedAt: snippet.publishedAt || '',
    channelId: snippet.channelId || '',
    channelTitle: snippet.channelTitle || '',
    viewCount: parseMetricCount_(statistics.viewCount),
    likeCount: hasOwnProperty_(statistics, 'likeCount')
      ? parseMetricCount_(statistics.likeCount)
      : null,
    commentCount: hasOwnProperty_(statistics, 'commentCount')
      ? parseMetricCount_(statistics.commentCount)
      : null,
    relevanceScore: 0,
    relevanceReasons: [],
    matchedProfile: null
  };
}

function fetchJson_(url) {
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const responseCode = response.getResponseCode();
  const responseText = response.getContentText();
  let parsed;

  try {
    parsed = JSON.parse(responseText);
  } catch (e) {
    parsed = null;
  }

  if (responseCode < 200 || responseCode >= 300) {
    const apiMessage = parsed && parsed.error && parsed.error.message
      ? parsed.error.message
      : responseText;
    throw new Error(`YouTube APIエラー (${responseCode}): ${apiMessage}`);
  }

  return parsed || {};
}

// =================================================================
//
//   SECTION 6: OPTION NORMALIZATION
//
// =================================================================

function prepareSearchOptions_(rawOptions, config) {
  return enrichDateFilters_(
    normalizeSearchOptions_(rawOptions, config),
    Session.getScriptTimeZone()
  );
}

function normalizeSearchOptions_(rawOptions, config) {
  const options = rawOptions || {};
  const normalizedSearchQuery = normalizeMatchText_(options.searchQuery || options.q);
  const normalized = {
    channelId: normalizeTrimmedString_(options.channelId),
    searchQuery: normalizeTrimmedString_(options.searchQuery || options.q),
    normalizedSearchQuery: normalizedSearchQuery,
    searchTokens: tokenizeMatchText_(normalizedSearchQuery),
    requiredTerms: normalizeTermList_(options.requiredTerms),
    excludedTerms: normalizeTermList_(options.excludedTerms),
    exactPhrases: normalizePhraseList_(options.exactPhrases),
    strictness: normalizeStrictness_(options.strictness),
    relevanceLanguage: normalizeOptionalValue_(
      options.relevanceLanguage,
      SUPPORTED_RELEVANCE_LANGUAGES,
      DEFAULT_RELEVANCE_LANGUAGE,
      true
    ),
    regionCode: normalizeOptionalValue_(
      options.regionCode,
      SUPPORTED_REGION_CODES,
      DEFAULT_REGION_CODE,
      false
    ),
    publishedAfter: normalizeTrimmedString_(options.publishedAfter),
    publishedBefore: normalizeTrimmedString_(options.publishedBefore),
    minViews: normalizeMetricInput_(options.minViews, '再生数'),
    maxViews: normalizeMetricInput_(options.maxViews, '再生数'),
    minLikes: normalizeMetricInput_(options.minLikes, '高評価数'),
    maxLikes: normalizeMetricInput_(options.maxLikes, '高評価数'),
    order: normalizeOrder_(
      options.order,
      config && config.allowedOrders ? config.allowedOrders : SEARCH_ORDER_OPTIONS,
      config && config.fallbackOrder ? config.fallbackOrder : 'date'
    ),
    maxResults: normalizeMaxResults_(options.maxResults)
  };

  if (normalized.publishedAfter && normalized.publishedBefore
      && normalized.publishedAfter > normalized.publishedBefore) {
    throw new Error('開始日は終了日以前にしてください。');
  }
  if (normalized.minViews !== null && normalized.maxViews !== null
      && normalized.minViews > normalized.maxViews) {
    throw new Error('再生数の最小値は最大値以下にしてください。');
  }
  if (normalized.minLikes !== null && normalized.maxLikes !== null
      && normalized.minLikes > normalized.maxLikes) {
    throw new Error('高評価数の最小値は最大値以下にしてください。');
  }

  return normalized;
}

function enrichDateFilters_(options, timezone) {
  const publishedAfterRfc3339 = buildRfc3339Timestamp(options.publishedAfter, timezone, false);
  const publishedBeforeRfc3339Exclusive = buildRfc3339Timestamp(options.publishedBefore, timezone, true);

  return Object.assign({}, options, {
    publishedAfterRfc3339: publishedAfterRfc3339,
    publishedBeforeRfc3339Exclusive: publishedBeforeRfc3339Exclusive,
    publishedAfterMs: publishedAfterRfc3339 ? Date.parse(publishedAfterRfc3339) : null,
    publishedBeforeMsExclusive: publishedBeforeRfc3339Exclusive
      ? Date.parse(publishedBeforeRfc3339Exclusive)
      : null
  });
}

function normalizeTrimmedString_(value) {
  return value ? String(value).trim() : '';
}

function normalizeTermList_(value) {
  return splitListInput_(value)
    .map(normalizeMatchText_)
    .filter(Boolean)
    .filter(term => term.indexOf(',') < 0);
}

function normalizePhraseList_(value) {
  return splitListInput_(value)
    .map(item => normalizeMatchText_(stripWrappingQuotes_(item)))
    .filter(Boolean);
}

function splitListInput_(value) {
  if (Array.isArray(value)) {
    return value.map(item => String(item)).filter(Boolean);
  }
  if (!value) {
    return [];
  }
  return String(value)
    .split(/[,\n]/)
    .map(item => item.trim())
    .filter(Boolean);
}

function stripWrappingQuotes_(value) {
  return String(value || '').replace(/^["']+|["']+$/g, '');
}

function normalizeMatchText_(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\u3000/g, ' ')
    .replace(/[“”„‟"']/g, ' ')
    .replace(/[‐‑–—―]/g, ' ')
    .replace(/[(){}\[\]<>【】「」『』]/g, ' ')
    .replace(/[.,!?;:|/\\@#$%^&*_+=~`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeMatchText_(value) {
  const normalized = normalizeMatchText_(value);
  return dedupeStringArray_(normalized ? normalized.split(' ') : []);
}

function normalizeStrictness_(value) {
  const strictness = normalizeTrimmedString_(value);
  return STRICTNESS_OPTIONS.indexOf(strictness) >= 0 ? strictness : DEFAULT_STRICTNESS;
}

function normalizeOptionalValue_(value, allowedValues, fallbackValue, lowerCase) {
  const normalized = normalizeTrimmedString_(value);
  if (!normalized) {
    return fallbackValue;
  }

  const candidate = lowerCase ? normalized.toLowerCase() : normalized.toUpperCase();
  return allowedValues.indexOf(candidate) >= 0 ? candidate : fallbackValue;
}

function normalizeMetricInput_(value, label) {
  if (value === '' || value === null || value === undefined) {
    return null;
  }

  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0 || Math.floor(numericValue) !== numericValue) {
    throw new Error(`${label}は0以上の整数で入力してください。`);
  }

  return numericValue;
}

function normalizeOrder_(order, allowedOrders, fallbackOrder) {
  const requestedOrder = normalizeTrimmedString_(order);
  return allowedOrders.indexOf(requestedOrder) >= 0 ? requestedOrder : fallbackOrder;
}

function normalizeMaxResults_(value) {
  if (value === '' || value === null || value === undefined) {
    return DEFAULT_MAX_RESULTS;
  }

  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 1 || Math.floor(numericValue) !== numericValue) {
    throw new Error('取得件数は1以上の整数で指定してください。');
  }

  return Math.min(numericValue, MAX_RESULTS_LIMIT);
}

function parseMetricCount_(value) {
  if (value === '' || value === null || value === undefined) {
    return null;
  }
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

// =================================================================
//
//   SECTION 7: RELEVANCE HELPERS
//
// =================================================================

function resolveSearchProfile_(options) {
  const candidates = [];
  const sourceText = options.normalizedSearchQuery
    || (options.exactPhrases.length ? options.exactPhrases[0] : '');

  if (!sourceText) {
    return null;
  }

  SEARCH_PROFILES.forEach(profile => {
    const normalizedAliases = profile.aliases.map(normalizeMatchText_);
    normalizedAliases.forEach(alias => {
      if (sourceText === alias || sourceText.indexOf(`${alias} `) === 0) {
        candidates.push({ profile: profile, alias: alias });
      }
    });
  });

  if (!candidates.length) {
    return null;
  }

  candidates.sort((left, right) => right.alias.length - left.alias.length);
  return cloneSearchProfile_(candidates[0].profile);
}

function cloneSearchProfile_(profile) {
  return {
    id: profile.id,
    aliases: profile.aliases.map(normalizeMatchText_),
    positiveTerms: profile.positiveTerms.map(normalizeMatchText_),
    negativeTerms: profile.negativeTerms.map(normalizeMatchText_),
    hardNegativeTerms: (profile.hardNegativeTerms || []).map(normalizeMatchText_),
    preferredCategories: profile.preferredCategories.slice(),
    blockedCategories: profile.blockedCategories.slice(),
    requiredSignals: profile.requiredSignals.map(normalizeMatchText_)
  };
}

function buildVideoSearchDocument_(video) {
  return {
    title: buildFieldDocument_(video.title),
    description: buildFieldDocument_(video.description),
    channelTitle: buildFieldDocument_(video.channelTitle),
    tags: buildFieldDocument_(Array.isArray(video.tags) ? video.tags.join(' ') : ''),
    all: buildFieldDocument_([
      video.title,
      video.description,
      video.channelTitle,
      Array.isArray(video.tags) ? video.tags.join(' ') : ''
    ].join(' '))
  };
}

function buildFieldDocument_(value) {
  const normalized = normalizeMatchText_(value);
  return {
    normalized: normalized,
    tokens: tokenizeMatchText_(normalized)
  };
}

function matchesField_(fieldDocument, term) {
  const normalizedTerm = normalizeMatchText_(term);
  if (!normalizedTerm) {
    return false;
  }

  if (normalizedTerm.indexOf(' ') >= 0) {
    return containsNormalizedPhrase_(fieldDocument.normalized, normalizedTerm);
  }

  return fieldDocument.tokens.indexOf(normalizedTerm) >= 0;
}

function containsNormalizedPhrase_(text, phrase) {
  if (!text || !phrase) {
    return false;
  }
  return (` ${text} `).indexOf(` ${phrase} `) >= 0;
}

function findMatchedAlias_(fieldDocument, aliases) {
  for (let i = 0; i < aliases.length; i += 1) {
    if (matchesField_(fieldDocument, aliases[i])) {
      return aliases[i];
    }
  }
  return '';
}

function videoMatchesLanguage_(video, languageCode) {
  if (!languageCode) {
    return false;
  }

  const candidates = [
    normalizeMatchText_(video.defaultLanguage),
    normalizeMatchText_(video.defaultAudioLanguage)
  ].filter(Boolean);

  return candidates.some(candidate => {
    return candidate === languageCode || candidate.indexOf(`${languageCode} `) === 0;
  });
}

function buildOrderedReasonLabels_(reasonEntries) {
  const orderedEntries = reasonEntries
    .slice()
    .sort((left, right) => {
      const leftWeight = Math.abs(left.weight);
      const rightWeight = Math.abs(right.weight);
      if (rightWeight !== leftWeight) {
        return rightWeight - leftWeight;
      }
      return right.weight - left.weight;
    });

  const positiveLabels = orderedEntries
    .filter(entry => entry.weight > 0)
    .map(entry => entry.label)
    .filter((label, index, labels) => labels.indexOf(label) === index);

  if (positiveLabels.length) {
    return positiveLabels.slice(0, 8);
  }

  return orderedEntries
    .map(entry => entry.label)
    .filter((label, index, labels) => labels.indexOf(label) === index)
    .slice(0, 8);
}

function hasPositiveQuery_(options) {
  return Boolean(options.searchQuery)
    || options.requiredTerms.length > 0
    || options.exactPhrases.length > 0;
}

function hasRelevanceIntent_(options, profile) {
  return hasPositiveQuery_(options) || Boolean(profile);
}

function getTargetCandidateCount_(maxResults) {
  return Math.min(maxResults * CANDIDATE_POOL_MULTIPLIER, MAX_CANDIDATE_POOL);
}

// =================================================================
//
//   SECTION 8: POST-FILTER / SORT HELPERS
//
// =================================================================

function applyPostRelevanceFilters_(videos, options) {
  return videos.filter(video => {
    return passesPublishedRange_(video, options)
      && passesNumericRange_(video.viewCount, options.minViews, options.maxViews)
      && passesNumericRange_(video.likeCount, options.minLikes, options.maxLikes);
  });
}

function passesPublishedRange_(video, options) {
  if (!options.publishedAfterMs && !options.publishedBeforeMsExclusive) {
    return true;
  }

  const publishedMs = Date.parse(video.publishedAt || '');
  if (isNaN(publishedMs)) {
    return false;
  }
  if (options.publishedAfterMs && publishedMs < options.publishedAfterMs) {
    return false;
  }
  if (options.publishedBeforeMsExclusive && publishedMs >= options.publishedBeforeMsExclusive) {
    return false;
  }
  return true;
}

function passesNumericRange_(value, min, max) {
  if (min === null && max === null) {
    return true;
  }
  if (value === null || value === undefined || isNaN(value)) {
    return false;
  }
  if (min !== null && value < min) {
    return false;
  }
  if (max !== null && value > max) {
    return false;
  }
  return true;
}

function finalizeVideoResults_(videos, options, config) {
  const uniqueVideos = dedupeVideos_(videos);

  if (config.useRelevanceRanking) {
    return sortVideosByRelevance_(uniqueVideos, options.order).slice(0, options.maxResults);
  }

  const sortedVideos = config.preserveApiOrder
    ? uniqueVideos
    : sortVideos_(uniqueVideos, options.order);
  return sortedVideos.slice(0, options.maxResults);
}

function sortVideosByRelevance_(videos, secondaryOrder) {
  return videos.slice().sort((left, right) => {
    return compareNumberDesc_(left.relevanceScore, right.relevanceScore)
      || compareByOrder_(left, right, secondaryOrder === 'relevance' ? 'date' : secondaryOrder)
      || compareTextAsc_(left.title, right.title);
  });
}

function sortVideos_(videos, order) {
  return videos.slice().sort((left, right) => {
    return compareByOrder_(left, right, order)
      || compareTextAsc_(left.title, right.title);
  });
}

function compareByOrder_(left, right, order) {
  switch (order) {
    case 'viewCount':
      return compareNumberDesc_(left.viewCount, right.viewCount)
        || compareDateDesc_(left.publishedAt, right.publishedAt);
    case 'title':
      return compareTextAsc_(left.title, right.title)
        || compareDateDesc_(left.publishedAt, right.publishedAt);
    case 'date':
    case 'relevance':
    default:
      return compareDateDesc_(left.publishedAt, right.publishedAt)
        || compareNumberDesc_(left.viewCount, right.viewCount);
  }
}

function compareNumberDesc_(left, right) {
  const leftValue = typeof left === 'number' && !isNaN(left) ? left : -1;
  const rightValue = typeof right === 'number' && !isNaN(right) ? right : -1;
  return rightValue - leftValue;
}

function compareDateDesc_(left, right) {
  const leftValue = Date.parse(left || '');
  const rightValue = Date.parse(right || '');
  const safeLeft = isNaN(leftValue) ? 0 : leftValue;
  const safeRight = isNaN(rightValue) ? 0 : rightValue;
  return safeRight - safeLeft;
}

function compareTextAsc_(left, right) {
  return (left || '').localeCompare((right || ''), 'ja');
}

function extractVideoIdFromPlaylistItem_(item) {
  if (item && item.contentDetails && item.contentDetails.videoId) {
    return item.contentDetails.videoId;
  }
  if (item && item.snippet && item.snippet.resourceId && item.snippet.resourceId.videoId) {
    return item.snippet.resourceId.videoId;
  }
  return '';
}

function dedupeStringArray_(values) {
  const seen = {};
  const deduped = [];

  values.forEach(value => {
    if (!value || seen[value]) {
      return;
    }
    seen[value] = true;
    deduped.push(value);
  });

  return deduped;
}

function dedupeVideos_(videos) {
  const seen = {};
  return videos.filter(video => {
    if (!video || !video.videoId || seen[video.videoId]) {
      return false;
    }
    seen[video.videoId] = true;
    return true;
  });
}

function hasOwnProperty_(target, key) {
  return Object.prototype.hasOwnProperty.call(target || {}, key);
}

// =================================================================
//
//   SECTION 9: DATE / QUERY HELPERS
//
// =================================================================

/**
 * スクリプトのタイムゾーンを基に、日付文字列をRFC3339形式へ変換する。
 * @param {string} dateString 'YYYY-MM-DD' 形式
 * @param {string} timezone スクリプトのタイムゾーンID
 * @param {boolean} exclusiveUpper trueの場合は翌日の開始時刻を返す
 * @returns {string|null} RFC3339形式の文字列
 */
function buildRfc3339Timestamp(dateString, timezone, exclusiveUpper) {
  if (!dateString) {
    return null;
  }

  const localMidnight = getLocalMidnight(dateString, timezone);
  if (exclusiveUpper) {
    localMidnight.setUTCDate(localMidnight.getUTCDate() + 1);
  }
  return formatAsRfc3339(localMidnight, timezone);
}

/**
 * 指定日のタイムゾーンにおける午前0時の瞬間をUTCで表現したDateを返す。
 * @param {string} dateString
 * @param {string} timezone
 * @returns {Date}
 */
function getLocalMidnight(dateString, timezone) {
  const parts = dateString.split('-').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new Error(`日付の形式が正しくありません: ${dateString}`);
  }

  const utcDate = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0));
  const offsetMinutes = getTimezoneOffsetMinutes(utcDate, timezone);
  return new Date(utcDate.getTime() - offsetMinutes * 60 * 1000);
}

/**
 * 指定日時におけるタイムゾーンのUTCオフセット（分）を取得する。
 * @param {Date} date
 * @param {string} timezone
 * @returns {number}
 */
function getTimezoneOffsetMinutes(date, timezone) {
  const offset = Utilities.formatDate(date, timezone, 'Z');
  const sign = offset.startsWith('-') ? -1 : 1;
  const hours = parseInt(offset.substr(1, 2), 10);
  const minutes = parseInt(offset.substr(3, 2), 10);
  return sign * (hours * 60 + minutes);
}

/**
 * DateオブジェクトをRFC3339形式の文字列に整形する。
 * @param {Date} date
 * @param {string} timezone
 * @returns {string}
 */
function formatAsRfc3339(date, timezone) {
  const datePart = Utilities.formatDate(date, timezone, "yyyy-MM-dd'T'HH:mm:ss");
  const offsetRaw = Utilities.formatDate(date, timezone, 'Z');
  const offset = `${offsetRaw.substr(0, 3)}:${offsetRaw.substr(3, 2)}`;
  return `${datePart}${offset}`;
}

/**
 * クエリパラメータを組み立てる。
 * @param {Object} params
 * @param {string|null} pageToken
 * @returns {string}
 */
function buildQueryString(params, pageToken) {
  const searchParams = [];
  Object.keys(params).forEach(key => {
    if (params[key] !== undefined && params[key] !== null && params[key] !== '') {
      searchParams.push(`${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`);
    }
  });
  if (pageToken) {
    searchParams.push(`pageToken=${encodeURIComponent(pageToken)}`);
  }
  return searchParams.join('&');
}

// =================================================================
//
//   SECTION 10: STANDALONE TEST FUNCTIONS (For Editor Use)
//
// =================================================================

function test_searchByKeywordAcrossYouTube() {
  const videos = searchYouTubeVideos({
    searchQuery: 'Obsidian',
    strictness: 'precision',
    requiredTerms: ['notes', 'vault'],
    excludedTerms: ['game', 'movie', 'soundtrack'],
    order: 'viewCount',
    maxResults: 10
  });

  console.log(`検索結果: ${videos.length}件`);
  videos.forEach(video => {
    console.log(`${video.relevanceScore} | ${video.title} | ${video.relevanceReasons.join(', ')}`);
  });
}

function test_channelResearchMode() {
  const videos = getAllVideoUrlsFromChannelId('UCVAkt5l6kD4igMdVoEGTGIg', {
    searchQuery: '首こり',
    strictness: 'balanced',
    maxResults: 10,
    order: 'date'
  });

  console.log(`検索結果: ${videos.length}件`);
  videos.forEach(video => {
    console.log(`${video.relevanceScore} | ${video.title} | ${video.url}`);
  });
}
