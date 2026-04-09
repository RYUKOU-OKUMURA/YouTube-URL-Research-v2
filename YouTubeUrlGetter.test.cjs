const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadScript(customFetch) {
  const code = fs.readFileSync(path.join(__dirname, 'YouTubeUrlGetter.gs'), 'utf8');

  const sandbox = {
    console,
    HtmlService: {
      createHtmlOutputFromFile() {
        return {
          setTitle() {
            return this;
          }
        };
      }
    },
    Session: {
      getScriptTimeZone() {
        return 'Asia/Tokyo';
      }
    },
    PropertiesService: {
      getScriptProperties() {
        return {
          getProperty() {
            return 'dummy-api-key';
          }
        };
      }
    },
    Utilities: {
      formatDate(date, timezone, format) {
        const d = new Date(date);
        if (format === 'Z') {
          return '+0900';
        }
        const yyyy = d.getUTCFullYear();
        const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(d.getUTCDate()).padStart(2, '0');
        const hh = String(d.getUTCHours()).padStart(2, '0');
        const mi = String(d.getUTCMinutes()).padStart(2, '0');
        const ss = String(d.getUTCSeconds()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`;
      }
    },
    UrlFetchApp: {
      fetch: customFetch || (() => {
        throw new Error('Unexpected fetch in test');
      })
    }
  };

  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'YouTubeUrlGetter.gs' });
  return sandbox;
}

function makeSearchResponse(items, nextPageToken) {
  return {
    getResponseCode() {
      return 200;
    },
    getContentText() {
      return JSON.stringify({
        items,
        nextPageToken: nextPageToken || undefined
      });
    }
  };
}

function makeVideosResponse(items) {
  return {
    getResponseCode() {
      return 200;
    },
    getContentText() {
      return JSON.stringify({ items });
    }
  };
}

function defaultNormalizeConfig() {
  return {
    allowedOrders: ['relevance', 'date', 'viewCount', 'title'],
    fallbackOrder: 'relevance'
  };
}

test('normalizeSearchOptions_ parses query builder inputs', () => {
  const ctx = loadScript();
  const options = ctx.normalizeSearchOptions_(
    {
      searchQuery: ' Google AI Studio ',
      requiredTerms: 'gemini, api, prompt',
      excludedTerms: 'music, artist',
      exactPhrases: 'Google AI Studio, Gemini API',
      strictness: 'precision',
      relevanceLanguage: 'ja',
      regionCode: 'JP',
      maxResults: '25'
    },
    defaultNormalizeConfig()
  );

  assert.equal(options.searchQuery, 'Google AI Studio');
  assert.deepEqual(Array.from(options.requiredTerms), ['gemini', 'api', 'prompt']);
  assert.deepEqual(Array.from(options.excludedTerms), ['music', 'artist']);
  assert.deepEqual(Array.from(options.exactPhrases), ['google ai studio', 'gemini api']);
  assert.equal(options.strictness, 'precision');
  assert.equal(options.relevanceLanguage, 'ja');
  assert.equal(options.regionCode, 'JP');
  assert.equal(options.maxResults, 25);
});

test('resolveSearchProfile_ matches the strongest alias only on exact/prefix', () => {
  const ctx = loadScript();
  const options = ctx.normalizeSearchOptions_(
    { searchQuery: 'Obsidian plugins for notes' },
    defaultNormalizeConfig()
  );
  const profile = ctx.resolveSearchProfile_(options);

  assert.equal(profile.id, 'obsidian');
  assert(profile.positiveTerms.includes('markdown'));
});

test('buildRelevanceAnalysis_ scores software context above noisy game context', () => {
  const ctx = loadScript();
  const options = ctx.normalizeSearchOptions_(
    {
      searchQuery: 'Obsidian',
      requiredTerms: 'notes, vault',
      excludedTerms: 'game, movie',
      strictness: 'precision'
    },
    defaultNormalizeConfig()
  );
  const profile = ctx.resolveSearchProfile_(options);

  const goodVideo = {
    videoId: 'good',
    title: 'Obsidian vault workflow for markdown notes',
    description: 'Build a PKM system in Obsidian with plugins and markdown.',
    tags: ['Obsidian', 'markdown', 'notes'],
    categoryId: '28',
    defaultLanguage: 'en',
    defaultAudioLanguage: 'en',
    url: 'https://www.youtube.com/watch?v=good',
    publishedAt: '2026-01-01T00:00:00Z',
    channelId: 'channel-good',
    channelTitle: 'PKM Notes Lab',
    viewCount: 120000,
    likeCount: 5000,
    commentCount: 200,
    relevanceScore: 0,
    relevanceReasons: [],
    matchedProfile: null
  };

  const noisyVideo = {
    videoId: 'noisy',
    title: 'Obsidian official game trailer',
    description: 'Gameplay showcase for the new Obsidian adventure.',
    tags: ['game', 'trailer'],
    categoryId: '20',
    defaultLanguage: 'en',
    defaultAudioLanguage: 'en',
    url: 'https://www.youtube.com/watch?v=noisy',
    publishedAt: '2026-01-01T00:00:00Z',
    channelId: 'channel-noisy',
    channelTitle: 'Gaming World',
    viewCount: 800000,
    likeCount: 10000,
    commentCount: 1500,
    relevanceScore: 0,
    relevanceReasons: [],
    matchedProfile: null
  };

  const goodAnalysis = ctx.buildRelevanceAnalysis_(goodVideo, options, profile);
  const noisyAnalysis = ctx.buildRelevanceAnalysis_(noisyVideo, options, profile);

  assert(goodAnalysis.score > noisyAnalysis.score);
  assert.equal(goodAnalysis.profileRequiredSignalsMissing, false);
  assert.equal(noisyAnalysis.profileHardNegativeInTitle, true);
});

test('searchYouTubeVideos() filters noisy results in a smoke flow', () => {
  const fetch = url => {
    const parsed = new URL(url);

    if (parsed.pathname.endsWith('/search')) {
      return makeSearchResponse([
        {
          id: { videoId: 'good-1' },
          snippet: { title: 'Obsidian beginner workflow', publishedAt: '2026-02-01T00:00:00Z' }
        },
        {
          id: { videoId: 'bad-1' },
          snippet: { title: 'Obsidian game trailer', publishedAt: '2026-02-01T00:00:00Z' }
        },
        {
          id: { videoId: 'good-2' },
          snippet: { title: 'Google AI Studio for Gemini API', publishedAt: '2026-02-01T00:00:00Z' }
        }
      ]);
    }

    if (parsed.pathname.endsWith('/videos')) {
      return makeVideosResponse([
        {
          id: 'good-1',
          snippet: {
            title: 'Obsidian beginner workflow',
            description: 'Markdown notes and vault setup tutorial.',
            tags: ['obsidian', 'markdown', 'vault'],
            categoryId: '28',
            defaultLanguage: 'en',
            defaultAudioLanguage: 'en',
            publishedAt: '2026-02-01T00:00:00Z',
            channelId: 'channel-1',
            channelTitle: 'Notes Channel'
          },
          statistics: {
            viewCount: '150000',
            likeCount: '5000',
            commentCount: '300'
          }
        },
        {
          id: 'bad-1',
          snippet: {
            title: 'Obsidian game trailer',
            description: 'Action gameplay trailer.',
            tags: ['game', 'trailer'],
            categoryId: '20',
            defaultLanguage: 'en',
            defaultAudioLanguage: 'en',
            publishedAt: '2026-02-01T00:00:00Z',
            channelId: 'channel-2',
            channelTitle: 'Gaming Channel'
          },
          statistics: {
            viewCount: '900000',
            likeCount: '9000',
            commentCount: '1200'
          }
        },
        {
          id: 'good-2',
          snippet: {
            title: 'Google AI Studio for Gemini API',
            description: 'Prompting and API workflow in Google AI Studio.',
            tags: ['google ai studio', 'gemini', 'api'],
            categoryId: '28',
            defaultLanguage: 'en',
            defaultAudioLanguage: 'en',
            publishedAt: '2026-02-01T00:00:00Z',
            channelId: 'channel-3',
            channelTitle: 'AI Builders'
          },
          statistics: {
            viewCount: '250000',
            likeCount: '14000',
            commentCount: '500'
          }
        }
      ]);
    }

    throw new Error(`Unexpected URL in smoke test: ${url}`);
  };

  const ctx = loadScript(fetch);
  const results = ctx.searchYouTubeVideos({
    searchQuery: 'Obsidian',
    strictness: 'precision',
    excludedTerms: ['game', 'movie'],
    maxResults: 10,
    order: 'relevance'
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].videoId, 'good-1');
  assert(results[0].relevanceReasons.length > 0);
});
