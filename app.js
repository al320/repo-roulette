/**
 * Repo Roulette - Application Logic
 *
 * Handles GitHub REST API queries, candidate repository pooling,
 * local random selection, sessionStorage state persistence,
 * and secure DOM rendering.
 */

'use strict';

// -----------------------------------------------------------------------------
// Constants & Configuration
// -----------------------------------------------------------------------------

/** Versioned sessionStorage key for candidate pool and selection state */
const STORAGE_KEY = 'repo_roulette_state_v2';
const STORAGE_KEY_V1 = 'repo_roulette_state_v1';

/** GitHub Search API endpoint */
const GITHUB_API_URL = 'https://api.github.com/search/repositories';

/** GitHub REST Search API hard maximum accessible results (10 pages @ 100/page) */
const MAX_SEARCH_RESULTS = 1000;
const PER_PAGE = 100;
const MAX_PAGE_LIMIT = Math.floor(MAX_SEARCH_RESULTS / PER_PAGE); // 10

/** Notification timing constants (in milliseconds) */
const NETWORK_ERROR_DISMISS_MS = 7000;
const ONLINE_DISMISS_MS = 4000;
const FADE_OUT_DURATION_MS = 300;

/** Default filter settings */
const DEFAULT_MIN_STARS = 500;
const DEFAULT_MAX_STARS = 100000;
const DEFAULT_LANGUAGE = '';

/** Supported programming language qualifiers */
const ALLOWED_LANGUAGES = ['', 'python', 'javascript', 'typescript', 'java', 'cpp', 'rust', 'go'];

// -----------------------------------------------------------------------------
// Application State
// -----------------------------------------------------------------------------

const state = {
  minStars: DEFAULT_MIN_STARS,       // Applied minimum-star value
  maxStars: DEFAULT_MAX_STARS,       // Applied maximum-star value
  language: DEFAULT_LANGUAGE,        // Applied programming language qualifier
  candidates: [],                    // Array of normalized repository candidate objects remaining in current pool
  displayedIds: [],                  // Session-wide array of repository IDs already shown to avoid duplicates
  nextPage: 1,                       // Next API page number to retrieve when pool is depleted
  maxPage: MAX_PAGE_LIMIT,           // Upper bound of available pages for this query
  unvisitedPages: [],                // Accessible pages not yet fetched in current discovery cycle
  currentRepo: null                  // Most recently selected repository (restored on refresh)
};

/** Request lock to prevent multiple concurrent API or selection calls */
let isProcessing = false;

/** Active timer handles for auto-dismissal and fade-out animations */
let dismissTimerId = null;
let fadeTimerId = null;

// -----------------------------------------------------------------------------
// Data Normalization (SessionStorage Quota & Data Integrity Optimization)
// -----------------------------------------------------------------------------

/**
 * Normalizes raw GitHub repository data to only the fields needed by the UI.
 * Drastically reduces memory and sessionStorage footprint (prevents QuotaExceededError).
 * @param {object} raw - Raw repository object from GitHub API.
 * @returns {object|null} Compact normalized repository object.
 */
function normalizeRepository(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id) {
    return null;
  }

  return {
    id: raw.id,
    name: typeof raw.name === 'string' ? raw.name : '',
    full_name: typeof raw.full_name === 'string' ? raw.full_name : (raw.name || 'Untitled Repository'),
    html_url: typeof raw.html_url === 'string' ? raw.html_url : '#',
    description: typeof raw.description === 'string' ? raw.description : '',
    stargazers_count: typeof raw.stargazers_count === 'number' && !Number.isNaN(raw.stargazers_count)
      ? raw.stargazers_count
      : 0,
    language: typeof raw.language === 'string' ? raw.language : '',
    owner: {
      login: raw.owner && typeof raw.owner.login === 'string' ? raw.owner.login : 'unknown',
      avatar_url: raw.owner && typeof raw.owner.avatar_url === 'string' ? raw.owner.avatar_url : ''
    }
  };
}

// -----------------------------------------------------------------------------
// Validation & Utility Functions
// -----------------------------------------------------------------------------

/**
 * Validates a single star count input (minimum or maximum).
 * Accepts non-negative whole numbers (0, 1, 2, ...).
 * Rejects empty, negative, decimal or invalid values and provides a descriptive message.
 * @param {string|number} rawValue - Raw input from number field.
 * @param {string} fieldName - Descriptive name of the field for error reporting.
 * @returns {{ valid: boolean, value?: number, error?: string }} Validation result.
 */
function validateStarInput(rawValue, fieldName = 'Stars') {
  if (rawValue === null || rawValue === undefined) {
    return { valid: false, error: `Please enter a ${fieldName.toLowerCase()} count.` };
  }

  const str = String(rawValue).trim();
  if (str === '') {
    return { valid: false, error: `Please enter a ${fieldName.toLowerCase()} count.` };
  }

  // Reject decimal values
  if (str.includes('.')) {
    return { valid: false, error: `${fieldName} must be a whole number.` };
  }

  // Reject negative values
  if (str.startsWith('-')) {
    return { valid: false, error: `${fieldName} must be 0 or greater.` };
  }

  // Reject anything that is not solely ASCII digits
  if (!/^\d+$/.test(str)) {
    return { valid: false, error: `${fieldName} must be a valid whole number.` };
  }

  const parsed = Number(str);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return { valid: false, error: `${fieldName} must be a valid non-negative integer.` };
  }

  return { valid: true, value: parsed };
}

/**
 * Validates the minimum and maximum star range.
 * Ensures both are valid non-negative whole numbers and maximum >= minimum.
 * @param {string|number} rawMin - Raw minimum stars value.
 * @param {string|number} rawMax - Raw maximum stars value.
 * @returns {{ valid: boolean, minStars?: number, maxStars?: number, error?: string }} Validation result.
 */
function validateStarRange(rawMin, rawMax) {
  const minResult = validateStarInput(rawMin, 'Minimum stars');
  if (!minResult.valid) {
    return { valid: false, error: minResult.error };
  }

  const maxResult = validateStarInput(rawMax, 'Maximum stars');
  if (!maxResult.valid) {
    return { valid: false, error: maxResult.error };
  }

  if (maxResult.value < minResult.value) {
    return {
      valid: false,
      error: 'Maximum stars must be greater than or equal to minimum stars.'
    };
  }

  return {
    valid: true,
    minStars: minResult.value,
    maxStars: maxResult.value
  };
}

/**
 * Backward compatibility wrapper for minimum star validation.
 * @param {string|number} rawValue - Raw input from number field.
 * @returns {{ valid: boolean, value?: number, error?: string }} Validation result.
 */
function validateMinStars(rawValue) {
  return validateStarInput(rawValue, 'Minimum stars');
}

/**
 * Dynamically calculates the ISO cutoff date (YYYY-MM-DD) for 12 months ago.
 * @returns {string} Cutoff date in YYYY-MM-DD format.
 */
function getCutoffDate() {
  const date = new Date();
  date.setFullYear(date.getFullYear() - 1);
  return date.toISOString().split('T')[0];
}

/**
 * Constructs the GitHub Search API URL with dynamic star range (stars:min..max),
 * pushed cutoff date, and optional programming language qualifier.
 * @param {number} page - Page number to request.
 * @param {number} minStars - Validated minimum star count.
 * @param {number} maxStars - Validated maximum star count.
 * @param {string} language - Programming language qualifier (empty string for all).
 * @returns {string} Fully formed API URL.
 */
function buildApiUrl(
  page = 1,
  minStars = state.minStars,
  maxStars = state.maxStars,
  language = state.language
) {
  const rangeValidation = validateStarRange(minStars, maxStars);
  if (!rangeValidation.valid) {
    throw new Error(rangeValidation.error);
  }
  const safeMin = rangeValidation.minStars;
  const safeMax = rangeValidation.maxStars;

  const cutoffDate = getCutoffDate();
  const safePage = Math.max(1, Math.min(MAX_PAGE_LIMIT, Math.floor(page)));

  const queryParts = [
    `stars:${safeMin}..${safeMax}`,
    `pushed:>=${cutoffDate}`
  ];

  if (typeof language === 'string' && language.trim() !== '') {
    queryParts.push(`language:${language.trim()}`);
  }

  const params = new URLSearchParams({
    q: queryParts.join(' '),
    sort: 'stars',
    order: 'desc',
    per_page: String(PER_PAGE),
    page: String(safePage)
  });

  return `${GITHUB_API_URL}?${params.toString()}`;
}

// -----------------------------------------------------------------------------
// Session Storage Persistence
// -----------------------------------------------------------------------------

/**
 * Saves current application state to sessionStorage.
 */
function saveSessionState() {
  try {
    const payload = JSON.stringify({
      minStars: state.minStars,
      maxStars: state.maxStars,
      language: state.language,
      candidates: state.candidates,
      displayedIds: state.displayedIds,
      nextPage: state.nextPage,
      maxPage: state.maxPage,
      unvisitedPages: state.unvisitedPages,
      currentRepo: state.currentRepo
    });
    sessionStorage.setItem(STORAGE_KEY, payload);
  } catch (error) {
    console.warn('Unable to persist Repo Roulette session state (storage may be full or disabled):', error);
  }
}

/**
 * Restores application state from sessionStorage.
 * Validates data integrity and resets gracefully if corrupted.
 * Automatically migrates session-wide displayedIds from legacy v1 schema without restoring
 * mismatched candidates.
 * @returns {boolean} True if valid state was restored, false otherwise.
 */
function loadSessionState() {
  try {
    let rawData = sessionStorage.getItem(STORAGE_KEY);
    let isV1 = false;

    // Safe migration check for legacy v1 storage key
    if (!rawData) {
      rawData = sessionStorage.getItem(STORAGE_KEY_V1);
      if (rawData) {
        isV1 = true;
      }
    }

    if (!rawData) return false;

    const parsed = JSON.parse(rawData);

    if (parsed && typeof parsed === 'object') {
      // Validate stars
      const rangeValidation = validateStarRange(
        parsed.minStars !== undefined ? parsed.minStars : DEFAULT_MIN_STARS,
        parsed.maxStars !== undefined ? parsed.maxStars : DEFAULT_MAX_STARS
      );

      const minStars = rangeValidation.valid ? rangeValidation.minStars : DEFAULT_MIN_STARS;
      const maxStars = rangeValidation.valid ? rangeValidation.maxStars : DEFAULT_MAX_STARS;

      // Validate language from storage
      const language = typeof parsed.language === 'string' && ALLOWED_LANGUAGES.includes(parsed.language)
        ? parsed.language
        : DEFAULT_LANGUAGE;

      // Restore session-wide displayed repository IDs
      const displayedIds = Array.isArray(parsed.displayedIds)
        ? parsed.displayedIds.filter((id) => typeof id === 'number' || typeof id === 'string')
        : [];

      state.minStars = minStars;
      state.maxStars = maxStars;
      state.language = language;
      state.displayedIds = displayedIds;

      // If migrating from legacy v1, candidates lacked maxStars validation, so clear candidates
      if (isV1) {
        state.candidates = [];
        state.nextPage = 1;
        state.maxPage = MAX_PAGE_LIMIT;
        state.unvisitedPages = [];
        state.currentRepo = null;
        try {
          sessionStorage.removeItem(STORAGE_KEY_V1);
        } catch (_) {}
        saveSessionState();
        return true;
      }

      state.candidates = Array.isArray(parsed.candidates)
        ? parsed.candidates.map(normalizeRepository).filter(Boolean)
        : [];

      state.nextPage = Number.isInteger(parsed.nextPage) && parsed.nextPage >= 1
        ? Math.min(MAX_PAGE_LIMIT, parsed.nextPage)
        : 1;

      state.maxPage = Number.isInteger(parsed.maxPage) && parsed.maxPage >= 1
        ? Math.min(MAX_PAGE_LIMIT, parsed.maxPage)
        : MAX_PAGE_LIMIT;

      state.unvisitedPages = Array.isArray(parsed.unvisitedPages)
        ? parsed.unvisitedPages.filter((p) => Number.isInteger(p) && p >= 1 && p <= MAX_PAGE_LIMIT)
        : [];

      state.currentRepo = normalizeRepository(parsed.currentRepo);
      return true;
    }
  } catch (error) {
    console.warn('Corrupted session data detected. Initializing clean state:', error);
  }

  // Fallback to clean state
  state.minStars = DEFAULT_MIN_STARS;
  state.maxStars = DEFAULT_MAX_STARS;
  state.language = DEFAULT_LANGUAGE;
  state.candidates = [];
  state.displayedIds = [];
  state.nextPage = 1;
  state.maxPage = MAX_PAGE_LIMIT;
  state.unvisitedPages = [];
  state.currentRepo = null;

  try {
    sessionStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem(STORAGE_KEY_V1);
  } catch (_) {
    // Ignore removal errors
  }
  return false;
}

// -----------------------------------------------------------------------------
// UI Status Feedback & Timer Management
// -----------------------------------------------------------------------------

/**
 * Clears any pending auto-dismissal and fade-out timers to prevent race conditions.
 */
function clearDismissTimers() {
  if (dismissTimerId !== null) {
    clearTimeout(dismissTimerId);
    dismissTimerId = null;
  }
  if (fadeTimerId !== null) {
    clearTimeout(fadeTimerId);
    fadeTimerId = null;
  }
}

/**
 * Updates the #status-region with an accessible message.
 * Supports optional auto-dismissal with a smooth fade-out.
 * @param {'loading'|'error'|'warning'|'success'} type - Status message variant.
 * @param {string} message - Descriptive text to display.
 * @param {number|null} autoDismissMs - Milliseconds before auto-dismissal (null for persistent).
 */
function setStatus(type, message, autoDismissMs = null) {
  // Always cancel any existing dismissal timers so an older timer never clears this newer notification
  clearDismissTimers();

  const statusRegion = document.getElementById('status-region');
  if (!statusRegion) return;

  statusRegion.textContent = '';
  if (!message) return;

  const msgElement = document.createElement('div');
  msgElement.className = `status-message status-${type}`;
  msgElement.textContent = message;
  statusRegion.appendChild(msgElement);

  // If an auto-dismissal delay is requested, schedule the fade-out and DOM removal
  if (typeof autoDismissMs === 'number' && autoDismissMs > 0) {
    dismissTimerId = setTimeout(() => {
      msgElement.classList.add('status-fade-out');

      fadeTimerId = setTimeout(() => {
        // Ensure element is still attached to the status region before clearing
        if (msgElement.parentElement === statusRegion) {
          statusRegion.textContent = '';
        }
        dismissTimerId = null;
        fadeTimerId = null;
      }, FADE_OUT_DURATION_MS);
    }, autoDismissMs);
  }
}

/**
 * Clears any active status or error message from #status-region and cancels timers.
 */
function clearStatus() {
  clearDismissTimers();
  const statusRegion = document.getElementById('status-region');
  if (statusRegion) {
    statusRegion.textContent = '';
  }
}

// -----------------------------------------------------------------------------
// GitHub API Client & Candidate Pooling
// -----------------------------------------------------------------------------

/**
 * Fetches a batch of 100 repository candidates from the GitHub API.
 * Excludes repositories in the session-wide displayedIds history.
 * Distributes requests across accessible pages to prevent descending-star bias.
 * Restarts the discovery cycle if all matching repositories have been displayed.
 * @param {number} retryCount - Safety counter to prevent unbounded recursion.
 * @returns {Promise<Array<object>>} Filtered non-duplicate repository candidates.
 */
async function fetchCandidatesBatch(retryCount = 0) {
  let targetPage = state.nextPage;
  if (!Number.isInteger(targetPage) || targetPage < 1 || targetPage > state.maxPage || targetPage > MAX_PAGE_LIMIT) {
    targetPage = 1;
  }

  const requestUrl = buildApiUrl(targetPage, state.minStars, state.maxStars, state.language);

  let response;
  try {
    response = await fetch(requestUrl, {
      headers: {
        Accept: 'application/vnd.github.v3+json'
      }
    });
  } catch (networkError) {
    const error = new Error('Unable to connect to GitHub. Please check your network connection.');
    error.isNetworkError = true;
    throw error;
  }

  // Handle rate limits (HTTP 403 or 429)
  if (response.status === 403 || response.status === 429) {
    const retryAfter = response.headers.get('retry-after');
    const resetHeader = response.headers.get('x-ratelimit-reset');

    if (retryAfter) {
      throw new Error(`Rate limit reached. Please wait ${retryAfter} seconds before requesting again.`);
    }

    if (resetHeader) {
      const resetTimestamp = parseInt(resetHeader, 10) * 1000;
      if (!Number.isNaN(resetTimestamp)) {
        const minutesRemaining = Math.max(1, Math.ceil((resetTimestamp - Date.now()) / 60000));
        throw new Error(`GitHub API rate limit exceeded. Access resets in approx. ${minutesRemaining} minute${minutesRemaining > 1 ? 's' : ''}.`);
      }
    }

    // Try reading specific message from JSON response body if present
    try {
      const errJson = await response.json();
      if (errJson && typeof errJson.message === 'string') {
        throw new Error(errJson.message);
      }
    } catch (parseErr) {
      if (parseErr.message && !parseErr.message.includes('JSON')) {
        throw parseErr;
      }
    }

    throw new Error('GitHub API rate limit exceeded. Please wait a few moments before trying again.');
  }

  // Handle pagination limits or invalid queries (HTTP 422)
  if (response.status === 422) {
    state.nextPage = 1;
    state.unvisitedPages = [];
    throw new Error('Search result limit reached. Starting fresh from page 1 on your next spin.');
  }

  // Handle GitHub server errors (HTTP 5xx)
  if (response.status >= 500) {
    throw new Error('GitHub servers are temporarily unavailable. Please try again shortly.');
  }

  if (!response.ok) {
    throw new Error(`GitHub API request failed with HTTP ${response.status}. Please try again later.`);
  }

  let data;
  try {
    data = await response.json();
  } catch (jsonError) {
    throw new Error('Failed to parse response data from GitHub.');
  }

  if (!data || !Array.isArray(data.items)) {
    throw new Error('Unexpected response format received from GitHub API.');
  }

  // Calculate real maximum available pages based on GitHub's total_count
  if (typeof data.total_count === 'number' && data.total_count >= 0) {
    const totalPages = Math.ceil(data.total_count / PER_PAGE);
    state.maxPage = Math.min(MAX_PAGE_LIMIT, Math.max(1, totalPages));
  }

  // If search returns 0 items
  if (data.items.length === 0) {
    if (targetPage > 1) {
      // Reached an empty page beyond results; reset to page 1 and retry safely
      state.nextPage = 1;
      state.unvisitedPages = [];
      state.maxPage = Math.max(1, targetPage - 1);
      if (retryCount < 2) {
        return await fetchCandidatesBatch(retryCount + 1);
      }
    }
    throw new Error('No repositories match these filters. Try adjusting the star range or selecting All Languages.');
  }

  // Normalize incoming candidates to ensure clean schema and minimal memory footprint
  const normalizedItems = data.items.map(normalizeRepository).filter(Boolean);

  // Maintain unvisited pages set for balanced result distribution across available pages
  if (!Array.isArray(state.unvisitedPages) || state.unvisitedPages.length === 0) {
    state.unvisitedPages = Array.from({ length: state.maxPage }, (_, i) => i + 1);
  }
  state.unvisitedPages = state.unvisitedPages.filter((p) => p !== targetPage);

  // Set the next page randomly from remaining unvisited pages to avoid descending-star bias
  if (state.unvisitedPages.length > 0) {
    const randIdx = Math.floor(Math.random() * state.unvisitedPages.length);
    state.nextPage = state.unvisitedPages[randIdx];
  } else {
    // All accessible pages for this filter query have been visited in this cycle
    state.unvisitedPages = Array.from({ length: state.maxPage }, (_, i) => i + 1);
    state.nextPage = 1;
  }

  // Filter out any candidates already displayed in the session-wide history
  const freshCandidates = normalizedItems.filter((item) => !state.displayedIds.includes(item.id));

  // If all items on this page were previously displayed in session:
  if (freshCandidates.length === 0) {
    // Try another unvisited page if available (capped at 2 retries to prevent network bursts)
    if (state.unvisitedPages.length > 0 && retryCount < 2) {
      return await fetchCandidatesBatch(retryCount + 1);
    }

    // Every matching repository across all accessible search pages has already been displayed!
    // Reset session-wide history and restart the discovery cycle.
    state.displayedIds = [];
    state.unvisitedPages = Array.from({ length: state.maxPage }, (_, i) => i + 1);
    state.unvisitedPages = state.unvisitedPages.filter((p) => p !== targetPage);
    return normalizedItems;
  }

  return freshCandidates;
}

/**
 * Retrieves a single random repository from the candidate pool.
 * Fetches a new batch from GitHub only when the local pool is exhausted.
 * @returns {Promise<object>} Selected repository object.
 */
async function getRandomRepository() {
  // Fetch new candidate pool if local pool is empty
  if (state.candidates.length === 0) {
    const newBatch = await fetchCandidatesBatch();
    if (!newBatch || newBatch.length === 0) {
      throw new Error('No repositories match these filters. Try adjusting the star range or selecting All Languages.');
    }
    state.candidates = newBatch;
  }

  // Pick a random repository without replacement
  const randomIndex = Math.floor(Math.random() * state.candidates.length);
  const [selectedRepo] = state.candidates.splice(randomIndex, 1);

  // Track displayed ID in session-wide collection
  if (selectedRepo && selectedRepo.id) {
    state.displayedIds.push(selectedRepo.id);
  }

  state.currentRepo = selectedRepo;
  saveSessionState();

  return selectedRepo;
}

// -----------------------------------------------------------------------------
// Safe DOM Rendering (XSS Protection via textContent & createElement)
// -----------------------------------------------------------------------------

/**
 * Formats repository star counts using Intl.NumberFormat.
 * @param {number} stars - Raw star count.
 * @returns {string} Formatted number string.
 */
function formatStarCount(stars) {
  const count = typeof stars === 'number' && !Number.isNaN(stars) ? stars : 0;
  return new Intl.NumberFormat('en-US').format(count);
}

/**
 * Safely renders a repository card into #result-container.
 * Avoids innerHTML to prevent untrusted API script injection.
 * @param {object} repo - Repository data object from GitHub API.
 */
function renderRepositoryCard(repo) {
  const container = document.getElementById('result-container');
  if (!container || !repo) return;

  // Clear previous content safely
  container.textContent = '';

  const card = document.createElement('article');
  card.className = 'repo-card';

  // 1. Header (owner identity and repository title)
  const header = document.createElement('div');
  header.className = 'repo-header';

  const ownerDiv = document.createElement('div');
  ownerDiv.className = 'repo-owner';

  // Optional owner avatar with fallback handling
  if (repo.owner && typeof repo.owner.avatar_url === 'string' && repo.owner.avatar_url.trim() !== '') {
    const avatarImg = document.createElement('img');
    avatarImg.src = repo.owner.avatar_url;
    avatarImg.alt = '';
    avatarImg.width = 18;
    avatarImg.height = 18;
    avatarImg.loading = 'lazy';
    avatarImg.style.borderRadius = '50%';
    avatarImg.style.verticalAlign = 'middle';
    avatarImg.style.marginRight = '0.35rem';

    // Remove avatar cleanly if image fails to load (offline or 404)
    avatarImg.onerror = () => {
      avatarImg.remove();
    };

    ownerDiv.appendChild(avatarImg);
  }

  const ownerName = document.createElement('span');
  ownerName.textContent = repo.owner && repo.owner.login ? repo.owner.login : 'unknown';
  ownerDiv.appendChild(ownerName);
  header.appendChild(ownerDiv);

  const titleHeading = document.createElement('h2');
  titleHeading.className = 'repo-name';

  const titleLink = document.createElement('a');
  titleLink.href = repo.html_url || '#';
  titleLink.target = '_blank';
  titleLink.rel = 'noopener noreferrer';
  titleLink.textContent = repo.full_name || repo.name || 'Untitled Repository';
  titleHeading.appendChild(titleLink);
  header.appendChild(titleHeading);

  card.appendChild(header);

  // 2. Repository Description
  const descriptionPara = document.createElement('p');
  descriptionPara.className = 'repo-description';
  descriptionPara.textContent = repo.description && repo.description.trim() !== ''
    ? repo.description
    : 'No description provided for this repository.';
  card.appendChild(descriptionPara);

  // 3. Metadata Bar (stars, language, direct GitHub link)
  const metaBar = document.createElement('div');
  metaBar.className = 'repo-meta';

  // Star count statistic
  const starStat = document.createElement('div');
  starStat.className = 'repo-stat';

  const starIcon = document.createElement('span');
  starIcon.setAttribute('aria-hidden', 'true');
  starIcon.textContent = '★';

  const starCount = document.createElement('span');
  starCount.textContent = `${formatStarCount(repo.stargazers_count)} stars`;

  starStat.appendChild(starIcon);
  starStat.appendChild(starCount);
  metaBar.appendChild(starStat);

  // Primary programming language
  const languageDiv = document.createElement('div');
  languageDiv.className = 'repo-language';

  const langDot = document.createElement('span');
  langDot.className = 'lang-dot';
  langDot.setAttribute('aria-hidden', 'true');

  const langText = document.createElement('span');
  langText.textContent = repo.language && repo.language.trim() !== '' ? repo.language : 'Unspecified';

  languageDiv.appendChild(langDot);
  languageDiv.appendChild(langText);
  metaBar.appendChild(languageDiv);

  // External repository link action
  const linkAction = document.createElement('a');
  linkAction.className = 'repo-link-action';
  linkAction.href = repo.html_url || '#';
  linkAction.target = '_blank';
  linkAction.rel = 'noopener noreferrer';

  const linkLabel = document.createElement('span');
  linkLabel.textContent = 'View on GitHub';

  const linkArrow = document.createElement('span');
  linkArrow.setAttribute('aria-hidden', 'true');
  linkArrow.textContent = ' →';

  linkAction.appendChild(linkLabel);
  linkAction.appendChild(linkArrow);
  metaBar.appendChild(linkAction);

  card.appendChild(metaBar);

  container.appendChild(card);
}

// -----------------------------------------------------------------------------
// Event Handling & Interaction Controller
// -----------------------------------------------------------------------------

/**
 * Resets the #result-container back to the initial empty state message.
 */
function resetResultContainer() {
  const container = document.getElementById('result-container');
  if (!container) return;
  container.textContent = '';
  const p = document.createElement('p');
  p.className = 'empty-state-message';
  p.textContent = 'Ready to discover something?';
  container.appendChild(p);
}

/**
 * Handles clicks on the "Randomize" button.
 * Coordinates filter validation, change detection, candidate retrieval,
 * button lock, status messaging, and rendering.
 */
async function handleRandomizeClick() {
  if (isProcessing) return;

  const randomizeBtn = document.getElementById('randomize-btn');
  const minStarsInput = document.getElementById('min-stars');
  const maxStarsInput = document.getElementById('max-stars');
  const languageSelect = document.getElementById('language-select');
  if (!randomizeBtn) return;

  // 1. Read currently selected filters
  const rawMinStars = minStarsInput ? minStarsInput.value : '';
  const rawMaxStars = maxStarsInput ? maxStarsInput.value : '';
  const selectedLanguage = languageSelect ? languageSelect.value.trim() : '';

  // 2. Validate inputs before constructing API request or modifying state
  const rangeValidation = validateStarRange(rawMinStars, rawMaxStars);
  if (!rangeValidation.valid) {
    setStatus('error', rangeValidation.error);
    return;
  }
  const currentMinStars = rangeValidation.minStars;
  const currentMaxStars = rangeValidation.maxStars;

  if (!ALLOWED_LANGUAGES.includes(selectedLanguage)) {
    setStatus('error', 'Please select a valid programming language.');
    return;
  }

  try {
    isProcessing = true;
    randomizeBtn.disabled = true;

    // 3. Determine whether active filter configuration has changed
    const filtersChanged =
      currentMinStars !== state.minStars ||
      currentMaxStars !== state.maxStars ||
      selectedLanguage !== state.language;

    // 4. Invalidate old pool and reset pagination if filters changed
    // NOTE: state.displayedIds is explicitly PRESERVED to maintain session-wide duplicate prevention!
    if (filtersChanged) {
      state.minStars = currentMinStars;
      state.maxStars = currentMaxStars;
      state.language = selectedLanguage;
      state.candidates = [];
      state.nextPage = 1;
      state.maxPage = MAX_PAGE_LIMIT;
      state.unvisitedPages = [];
      state.currentRepo = null;
      resetResultContainer();
      saveSessionState();
    }

    // Display appropriate loading message based on cache state
    if (state.candidates.length === 0) {
      setStatus('loading', 'Fetching repository batch from GitHub...');
    } else {
      setStatus('loading', 'Selecting a repository...');
    }

    // 5 & 6. Fetch matching repositories if pool is empty and pick a random repository
    const repo = await getRandomRepository();

    // 7. Render repository card
    renderRepositoryCard(repo);
    clearStatus();
  } catch (error) {
    console.error('Repo Roulette Error:', error);

    const isNetwork = Boolean(
      error && (
        error.isNetworkError ||
        (typeof navigator !== 'undefined' && !navigator.onLine) ||
        (typeof error.message === 'string' && error.message.toLowerCase().includes('network'))
      )
    );

    if (isNetwork) {
      setStatus(
        'error',
        error.message || 'Unable to connect to GitHub. Please check your network connection.',
        NETWORK_ERROR_DISMISS_MS
      );
    } else {
      // Non-network errors (e.g., rate limits, empty results) stay persistent until user action
      setStatus('error', error.message || 'An unexpected error occurred. Please try again.');
    }
  } finally {
    isProcessing = false;
    randomizeBtn.disabled = false;
  }
}

// -----------------------------------------------------------------------------
// Application Initialization & Network Listeners
// -----------------------------------------------------------------------------

// Native browser connectivity event listeners
window.addEventListener('offline', () => {
  setStatus('error', 'Connection lost. Please check your internet connection.', NETWORK_ERROR_DISMISS_MS);
});

window.addEventListener('online', () => {
  setStatus('success', "Connection restored. You're back online!", ONLINE_DISMISS_MS);
});

document.addEventListener('DOMContentLoaded', () => {
  // Restore persisted state from sessionStorage if present
  const hasRestored = loadSessionState();

  // Restore filter control inputs from state
  const minStarsInput = document.getElementById('min-stars');
  const maxStarsInput = document.getElementById('max-stars');
  const languageSelect = document.getElementById('language-select');

  if (minStarsInput) {
    minStarsInput.value = state.minStars;
    minStarsInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleRandomizeClick();
      }
    });
  }

  if (maxStarsInput) {
    maxStarsInput.value = state.maxStars;
    maxStarsInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleRandomizeClick();
      }
    });
  }

  if (languageSelect) {
    languageSelect.value = state.language;
    languageSelect.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleRandomizeClick();
      }
    });
  }

  // If a repository was previously active during this session, re-render it
  if (hasRestored && state.currentRepo) {
    renderRepositoryCard(state.currentRepo);
  }

  // Bind the Randomize button trigger
  const randomizeBtn = document.getElementById('randomize-btn');
  if (randomizeBtn) {
    randomizeBtn.addEventListener('click', handleRandomizeClick);
  }
});
