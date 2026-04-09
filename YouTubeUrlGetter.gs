/**
 * @fileoverview
 * YouTube Data APIから動画URLを取得するGoogle Apps Script。
 * チャンネル指定の有無に関わらずキーワード検索を行い、
 * 公開期間・再生数・高評価数で絞り込んだ動画一覧を返す。
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
const SEARCH_ORDER_OPTIONS = ['relevance', 'date', 'viewCount', 'title'];
const CHANNEL_ORDER_OPTIONS = ['date', 'viewCount', 'title'];

// =================================================================
//
//   SECTION 2: WEB APP CORE FUNCTIONS
//
// =================================================================

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('YouTube URL Getter');
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
  let options = enrichDateFilters_(
    normalizeSearchOptions_(rawOptions, {
      allowedOrders: SEARCH_ORDER_OPTIONS,
      fallbackOrder: 'relevance'
    }),
    Session.getScriptTimeZone()
  );

  if (!options.channelId && !options.searchQuery) {
    throw new Error('YouTube全体を検索する場合は、検索キーワードを入力してください。');
  }

  if (!options.searchQuery && options.order === 'relevance') {
    options = Object.assign({}, options, { order: 'date' });
  }

  const apiKey = getApiKeyOrThrow_();
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
  if (options.searchQuery) {
    params.q = options.searchQuery;
  }
  if (options.publishedAfterRfc3339) {
    params.publishedAfter = options.publishedAfterRfc3339;
  }
  if (options.publishedBeforeRfc3339Exclusive) {
    params.publishedBefore = options.publishedBeforeRfc3339Exclusive;
  }

  try {
    const collectedVideos = [];
    const seenVideoIds = {};
    let nextPageToken = null;
    let page = 0;

    do {
      page += 1;
      const url = `${YOUTUBE_SEARCH_URL}?${buildQueryString(params, nextPageToken)}`;
      const data = fetchJson_(url);
      const searchItems = Array.isArray(data.items) ? data.items : [];

      if (!searchItems.length) {
        break;
      }

      const detailedVideos = hydrateSearchResultsWithVideoDetails_(searchItems, apiKey);
      const filteredVideos = applyVideoFilters_(detailedVideos, options);

      filteredVideos.forEach(video => {
        if (!seenVideoIds[video.videoId]) {
          seenVideoIds[video.videoId] = true;
          collectedVideos.push(video);
        }
      });

      nextPageToken = data.nextPageToken || null;
    } while (nextPageToken && page < MAX_SEARCH_PAGES && collectedVideos.length < options.maxResults);

    return finalizeVideoResults_(collectedVideos, options, {
      preserveApiOrder: options.order === 'relevance'
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

  const options = enrichDateFilters_(
    normalizeSearchOptions_(Object.assign({}, rawOptions, { channelId: channelId }), {
      allowedOrders: CHANNEL_ORDER_OPTIONS,
      fallbackOrder: 'date'
    }),
    Session.getScriptTimeZone()
  );

  const apiKey = getApiKeyOrThrow_();

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

    const filteredVideos = applyVideoFilters_(videos, options);
    return finalizeVideoResults_(filteredVideos, options, {
      preserveApiOrder: false
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
//   SECTION 4: FETCH / FILTER HELPERS
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
      : null
  };
}

function applyVideoFilters_(videos, options) {
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
  const preserveApiOrder = config && config.preserveApiOrder;
  const sortedVideos = preserveApiOrder ? uniqueVideos : sortVideos_(uniqueVideos, options.order);
  return sortedVideos.slice(0, options.maxResults);
}

function sortVideos_(videos, order) {
  const clonedVideos = videos.slice();

  switch (order) {
    case 'viewCount':
      return clonedVideos.sort((a, b) => {
        return compareNumberDesc_(a.viewCount, b.viewCount)
          || compareDateDesc_(a.publishedAt, b.publishedAt)
          || compareTextAsc_(a.title, b.title);
      });
    case 'title':
      return clonedVideos.sort((a, b) => {
        return compareTextAsc_(a.title, b.title)
          || compareDateDesc_(a.publishedAt, b.publishedAt);
      });
    case 'date':
    default:
      return clonedVideos.sort((a, b) => {
        return compareDateDesc_(a.publishedAt, b.publishedAt)
          || compareNumberDesc_(a.viewCount, b.viewCount)
          || compareTextAsc_(a.title, b.title);
      });
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
//   SECTION 5: OPTION / DATA NORMALIZATION
//
// =================================================================

function normalizeSearchOptions_(rawOptions, config) {
  const options = rawOptions || {};
  const normalized = {
    channelId: normalizeTrimmedString_(options.channelId),
    searchQuery: normalizeTrimmedString_(options.searchQuery || options.q),
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
//   SECTION 6: DATE / QUERY HELPERS
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
//   SECTION 7: STANDALONE TEST FUNCTIONS (For Editor Use)
//
// =================================================================

function test_searchInChannelWithDate() {
  const videos = searchYouTubeVideos({
    channelId: 'UCVAkt5l6kD4igMdVoEGTGIg',
    searchQuery: '',
    publishedAfter: '2023-01-01',
    publishedBefore: '2023-12-31',
    order: 'date',
    maxResults: 20
  });

  console.log(`検索結果: ${videos.length}件`);
  videos.forEach(video => {
    console.log(`${video.publishedAt} | ${video.title} | ${video.viewCount}再生 | ${video.url}`);
  });
}

function test_searchByKeywordAcrossYouTube() {
  const videos = searchYouTubeVideos({
    searchQuery: '肩こり ストレッチ',
    publishedAfter: '2025-01-01',
    minViews: 10000,
    minLikes: 100,
    order: 'viewCount',
    maxResults: 10
  });

  console.log(`検索結果: ${videos.length}件`);
  videos.forEach(video => {
    console.log(`${video.channelTitle} | ${video.title} | ${video.viewCount}再生 | ${video.likeCount}高評価`);
  });
}
