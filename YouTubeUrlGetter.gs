/**
 * @fileoverview
 * YouTube Data APIから動画URLを取得するGoogle Apps Script。
 * WebアプリUI経由での検索やチャンネル全動画取得をサポートし、
 * 日付検索ではスクリプトのタイムゾーンに合わせたRFC3339に変換する。
 */

// =================================================================
//
//   SECTION 1: CONSTANTS
//
// =================================================================

const YOUTUBE_SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';
const YOUTUBE_CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels';
const YOUTUBE_PLAYLIST_ITEMS_URL = 'https://www.googleapis.com/youtube/v3/playlistItems';
const MAX_SEARCH_PAGES = 10; // YouTube検索APIは最大500件（10ページ）まで

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
 * 指定したチャンネル内で、キーワードや日付に一致する動画を検索し、動画情報の配列を返す。
 * @param {string} channelId 検索対象のチャンネルID
 * @param {string} searchQuery 検索キーワード
 * @param {string} publishedAfter 開始日 (例: '2025-01-01')
 * @param {string} publishedBefore 終了日 (例: '2025-10-14')
 * @returns {{title: string, url: string, publishedAt: string}[]} 動画情報の配列
 */
function searchVideosInChannel(channelId, searchQuery, publishedAfter, publishedBefore) {
  if (!channelId) { throw new Error('チャンネルIDを指定してください。'); }

  const API_KEY = PropertiesService.getScriptProperties().getProperty('YOUTUBE_API_KEY');
  if (!API_KEY) { throw new Error('APIキーが設定されていません。'); }

  const timezone = Session.getScriptTimeZone();
  const params = {
    part: 'snippet',
    channelId: channelId,
    type: 'video',
    maxResults: 50,
    order: 'date',
    key: API_KEY
  };

  if (searchQuery) {
    params.q = searchQuery;
  }

  const publishedAfterParam = buildRfc3339Timestamp(publishedAfter, timezone, false);
  if (publishedAfterParam) {
    params.publishedAfter = publishedAfterParam;
  }

  const publishedBeforeParam = buildRfc3339Timestamp(publishedBefore, timezone, true);
  if (publishedBeforeParam) {
    params.publishedBefore = publishedBeforeParam;
  }

  try {
    const videos = [];
    let nextPageToken = null;
    let page = 0;
    do {
      page += 1;
      const url = `${YOUTUBE_SEARCH_URL}?${buildQueryString(params, nextPageToken)}`;
      const response = UrlFetchApp.fetch(url);
      const data = JSON.parse(response.getContentText());

      if (!data.items || data.items.length === 0) {
        break;
      }

      data.items.forEach(item => {
        if (item.id && item.id.videoId && item.snippet) {
          videos.push({
            title: item.snippet.title || '',
            url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
            publishedAt: item.snippet.publishedAt || ''
          });
        }
      });

      nextPageToken = data.nextPageToken || null;
    } while (nextPageToken && page < MAX_SEARCH_PAGES);

    return videos;
  } catch (e) {
    console.error('APIリクエスト中にエラーが発生しました: ' + e.toString());
    throw new Error('APIリクエストに失敗しました。詳細はログを確認してください。');
  }
}

/**
 * 【HTMLから呼び出し】
 * 指定されたチャンネルIDから、すべての動画情報を取得して返す。
 * @param {string} channelId 取得対象のチャンネルID
 * @returns {{title: string, url: string, publishedAt: string}[]} 動画情報の配列
 */
function getAllVideoUrlsFromChannelId(channelId) {
  if (!channelId) { throw new Error('チャンネルIDを指定してください。'); }

  const API_KEY = PropertiesService.getScriptProperties().getProperty('YOUTUBE_API_KEY');
  if (!API_KEY) { throw new Error('APIキーが設定されていません。'); }

  try {
    const channelUrl = `${YOUTUBE_CHANNELS_URL}?part=contentDetails&id=${channelId}&key=${API_KEY}`;
    const channelRes = UrlFetchApp.fetch(channelUrl);
    const channelData = JSON.parse(channelRes.getContentText());
    if (!channelData.items || channelData.items.length === 0) {
      throw new Error('チャンネルが見つかりませんでした。');
    }

    const uploadsPlaylistId = channelData.items[0].contentDetails.relatedPlaylists.uploads;
    const videos = [];
    let nextPageToken = null;
    do {
      let playlistUrl = `${YOUTUBE_PLAYLIST_ITEMS_URL}?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=50&key=${API_KEY}`;
      if (nextPageToken) {
        playlistUrl += `&pageToken=${nextPageToken}`;
      }
      const playlistRes = UrlFetchApp.fetch(playlistUrl);
      const playlistData = JSON.parse(playlistRes.getContentText());
      if (playlistData.items && playlistData.items.length > 0) {
        playlistData.items.forEach(item => {
          if (item.snippet && item.snippet.resourceId && item.snippet.resourceId.videoId) {
            videos.push({
              title: item.snippet.title || '',
              url: `https://www.youtube.com/watch?v=${item.snippet.resourceId.videoId}`,
              publishedAt: item.snippet.publishedAt || ''
            });
          }
        });
      }
      nextPageToken = playlistData.nextPageToken || null;
    } while (nextPageToken);

    return videos;
  } catch (e) {
    console.error('APIリクエスト中にエラーが発生しました: ' + e.toString());
    throw new Error('APIリクエストに失敗しました。詳細はログを確認してください。');
  }
}

// =================================================================
//
//   SECTION 4: UTILITY HELPERS
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
//   SECTION 5: STANDALONE TEST FUNCTIONS (For Editor Use)
//
// =================================================================

function test_searchInChannelWithDate() {
  const targetChannelId = 'UCVAkt5l6kD4igMdVoEGTGIg';
  const keyword = '';
  const startDate = '2023-01-01';
  const endDate = '2023-12-31';

  console.log(`日付範囲 [${startDate}] ~ [${endDate}] で検索を実行します...`);
  const videos = searchVideosInChannel(targetChannelId, keyword, startDate, endDate);
  if (videos) {
    console.log(`検索結果: ${videos.length}件`);
    videos.forEach(video => {
      console.log(`${video.publishedAt} | ${video.title} | ${video.url}`);
    });
  }
}
