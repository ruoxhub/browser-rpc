/**
 * Popup UI - Vanilla JavaScript Implementation
 *
 * Manages state, config, platform detection, searchable dropdown selection, and UI interactions.
 */

/* global chrome */

/**
 * @typedef {Object} PlatformDef
 * @property {string} id
 * @property {string} name
 * @property {string} [category]
 * @property {string[]} domains
 * @property {string} defaultUrl
 * @property {string} icon
 */

// ============================================================================
// Constants & State
// ============================================================================

/** @type {PlatformDef[]} */
const PLATFORMS = globalThis.CRAWLER_RPC_PLATFORMS || [];

const DEFAULT_WS_HOST = 'ws://127.0.0.1:5612';
const STORAGE_KEY = 'crawler_rpc_config';
const TOAST_DURATION = 2500;

// State
const state = {
    status: 'loading', // 'loading' | 'active' | 'inactive'
    currentPlatform: null,
    selectedPlatform: null,
    isDropdownOpen: false,
    wsHost: DEFAULT_WS_HOST,
    rpcToken: '',
    actionDelay: 0,
    isSaving: false,
    toastTimer: null,
    searchKeyword: '',
    selectedCategory: 'all',
};

// ============================================================================
// DOM Helpers
// ============================================================================

/**
 * Query element
 * @param {string} selector
 * @returns {HTMLElement|null}
 */
function $(selector) {
    return document.querySelector(selector);
}

/**
 * Render platform icon (emoji or image path)
 * @param {string} icon
 * @returns {string} HTML string
 */
function renderIcon(icon) {
    const isImage = typeof icon === 'string' && icon.startsWith('/');
    const iconHtml = isImage
        ? `<img src="${icon}" alt="" />`
        : (icon || '🌐');
    return `<span>${iconHtml}</span>`;
}

// ============================================================================
// Chrome API Helpers
// ============================================================================

/**
 * Promise wrapper for chrome.storage.local.get
 * @param {string|string[]} keys
 * @returns {Promise<Object>}
 */
function storageGet(keys) {
    return new Promise((resolve) => {
        chrome.storage.local.get(keys, (result) => {
            if (chrome.runtime?.lastError) {
                console.error('Storage get error:', chrome.runtime.lastError);
            }
            resolve(result || {});
        });
    });
}

/**
 * Get current active tab
 * @returns {Promise<chrome.tabs.Tab|undefined>}
 */
function getActiveTab() {
    return new Promise((resolve) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            resolve(tabs?.[0]);
        });
    });
}

// ============================================================================
// Config Management
// ============================================================================

/**
 * Load config from browser.storage.local
 */
async function loadConfig() {
    const result = await storageGet(STORAGE_KEY);
    const config = result[STORAGE_KEY] || {};

    if (config.wsHost) {
        state.wsHost = config.wsHost;
        const input = $('#wsHostInput');
        if (input) input.value = state.wsHost;
    }

    if (typeof config.rpcToken === 'string') {
        state.rpcToken = config.rpcToken;
        const tokenInput = $('#rpcTokenInput');
        if (tokenInput) tokenInput.value = state.rpcToken;
    }

    if (typeof config.actionDelay === 'number') {
        state.actionDelay = config.actionDelay;
        updateDelayUI();
    }

    // Cloudflare autopilot config
    const cf = config.cf_autopilot || {};
    const toggle = $('#cfAutopilotToggle');
    if (toggle) toggle.checked = !!cf.enabled;

    const wlInput = $('#cfWhitelistInput');
    if (wlInput) {
        wlInput.value = Array.isArray(cf.whitelist) ? cf.whitelist.join(',') : '';
    }
}

/**
 * Save config to browser.storage.local
 * @param {Object} config
 * @returns {Promise<boolean>}
 */
async function saveConfig(config) {
    try {
        const result = await chrome.runtime.sendMessage({ action: 'saveConfig', config });
        return Boolean(result && result.success);
    } catch (error) {
        return false;
    }
}

// ============================================================================
// Platform Detection & Status
// ============================================================================

/**
 * Detect platform from URL
 * @param {string} url
 * @param {PlatformDef[]} platforms
 * @returns {PlatformDef|null}
 */
function detectPlatform(url, platforms = PLATFORMS) {
    if (!url) return null;

    // Skip internal browser pages
    const internalPrefixes = ['about:', 'moz-extension:', 'chrome:'];
    if (internalPrefixes.some(prefix => url.startsWith(prefix))) return null;

    let hostname;
    try {
        hostname = new URL(url).hostname.toLowerCase();
    } catch (_) {
        return null;
    }
    return platforms.find(p => p.domains && p.domains.some(domain => {
        const normalizedDomain = domain.toLowerCase();
        return hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`);
    })) || null;
}

/**
 * Update platform status based on current active tab
 */
async function updatePlatformStatus() {
    const tab = await getActiveTab();

    if (tab?.url) {
        state.currentPlatform = detectPlatform(tab.url);
        state.status = state.currentPlatform ? 'active' : 'inactive';
        if (state.currentPlatform && !state.selectedPlatform) {
            setSelectedPlatform(state.currentPlatform);
        }
    } else {
        state.status = 'inactive';
    }

    renderStatus();
    renderPlatformGrid();
}

/**
 * Render status indicator in the DOM
 */
function renderStatus() {
    const dot = $('#statusDot');
    const text = $('#statusText');
    const platformTag = $('#platformTag');

    if (dot) {
        dot.className = `status-dot ${state.status}`;
    }

    if (text) {
        const statusMessages = {
            loading: '检测中...',
            active: '已连接',
            inactive: '未检测到支持的平台',
        };
        text.textContent = statusMessages[state.status] || '';
    }

    if (platformTag) {
        if (state.currentPlatform) {
            const { icon, name } = state.currentPlatform;
            platformTag.style.display = '';
            platformTag.innerHTML = `${renderIcon(icon)}<span>${name}</span>`;
            platformTag.title = `当前平台: ${name}`;
        } else {
            platformTag.style.display = 'none';
        }
    }
}

// ============================================================================
// Dropdown & Filter Logic
// ============================================================================

/**
 * Toggle custom dropdown menu visibility
 * @param {boolean} [forceState]
 */
function toggleDropdown(forceState) {
    const isOpen = typeof forceState === 'boolean' ? forceState : !state.isDropdownOpen;
    state.isDropdownOpen = isOpen;

    const trigger = $('#selectTrigger');
    const menu = $('#dropdownMenu');
    const searchInput = $('#dropdownSearchInput');

    if (trigger) trigger.classList.toggle('open', isOpen);
    if (menu) {
        menu.style.display = isOpen ? 'flex' : 'none';
        if (isOpen && searchInput) {
            setTimeout(() => searchInput.focus(), 50);
        }
    }
}

/**
 * Set selected platform and update trigger display
 * @param {PlatformDef} platform
 */
function setSelectedPlatform(platform) {
    state.selectedPlatform = platform;

    const triggerText = $('#selectedPlatformText');
    if (triggerText && platform) {
        triggerText.innerHTML = `${renderIcon(platform.icon)} <span>${platform.name}</span> <small style="color:var(--text-muted);font-size:11px;">(${platform.id})</small>`;
    }

    // Highlight matching chip if available
    document.querySelectorAll('.quick-chip').forEach(chip => {
        chip.classList.toggle('active', chip.dataset.platformId === platform.id);
    });

    renderPlatformGrid();
}

/**
 * Filter platforms according to category and search keyword
 * @returns {PlatformDef[]}
 */
function getFilteredPlatforms() {
    const kw = state.searchKeyword.trim().toLowerCase();
    const cat = state.selectedCategory;

    let list = PLATFORMS.filter(p => {
        // Category match
        if (cat !== 'all') {
            const platformCat = (p.category || '').toLowerCase();
            if (platformCat !== cat) return false;
        }

        // Keyword match
        if (kw) {
            const nameMatch = (p.name || '').toLowerCase().includes(kw);
            const idMatch = (p.id || '').toLowerCase().includes(kw);
            const domainMatch = p.domains && p.domains.some(d => d.toLowerCase().includes(kw));
            return nameMatch || idMatch || domainMatch;
        }

        return true;
    });

    // If a platform is selected, sort it to the front
    const activeId = state.selectedPlatform?.id || state.currentPlatform?.id;
    if (activeId) {
        list = [...list].sort((a, b) => {
            if (a.id === activeId) return -1;
            if (b.id === activeId) return 1;
            return 0;
        });
    }

    return list;
}

/**
 * Render platform list items in the dropdown menu
 * (Uses #platformGrid selector to maintain unit-test compatibility)
 */
function renderPlatformGrid() {
    const grid = $('#platformGrid');
    const emptyState = $('#noPlatformResult');
    if (!grid) return;

    const filtered = getFilteredPlatforms();

    if (filtered.length === 0) {
        grid.innerHTML = '';
        grid.style.display = 'none';
        if (emptyState) emptyState.style.display = 'flex';
        return;
    }

    grid.style.display = 'flex';
    if (emptyState) emptyState.style.display = 'none';

    const activeId = state.selectedPlatform?.id || state.currentPlatform?.id;

    grid.innerHTML = filtered.map(p => {
        const isActive = activeId === p.id;
        const activeClass = isActive ? ' active' : '';
        const domainText = p.domains?.[0] || '';
        return `<button type="button" class="platform-btn${activeClass}"
                        data-platform-url="${p.defaultUrl}"
                        data-platform-id="${p.id}"
                        title="${p.name} (${p.id})">
                    <span>${renderIcon(p.icon)}</span>
                    <small>${p.name}</small>
                    <span class="platform-meta">${domainText}</span>
                </button>`;
    }).join('');
}

// ============================================================================
// UI Helpers
// ============================================================================

/**
 * Show toast notification
 * @param {string} message
 * @param {'success'|'error'|'info'} type
 */
function showToast(message, type) {
    const toastEl = $('#toastNotification');
    if (!toastEl) return;

    toastEl.textContent = message;
    toastEl.className = `toast ${type}`;
    toastEl.style.display = 'flex';

    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
        toastEl.classList.add('hiding');
        setTimeout(() => {
            toastEl.style.display = 'none';
            toastEl.classList.remove('hiding');
        }, 250);
    }, TOAST_DURATION);
}

/**
 * Update delay slider and number input UI
 */
function updateDelayUI() {
    const slider = $('#actionDelaySlider');
    const numberInput = $('#delayNumberInput');

    if (slider) slider.value = state.actionDelay;
    if (numberInput) numberInput.value = state.actionDelay;

    // Update preset button active states
    document.querySelectorAll('.delay-preset-btn').forEach(btn => {
        const val = parseInt(btn.dataset.value, 10);
        btn.classList.toggle('active', val === state.actionDelay);
    });
}

// ============================================================================
// Event Handlers
// ============================================================================

/**
 * Handle save config button click
 */
async function handleSaveConfig() {
    if (!state.wsHost.startsWith('ws://') && !state.wsHost.startsWith('wss://')) {
        showToast('地址必须以 ws:// 或 wss:// 开头', 'error');
        return;
    }

    state.isSaving = true;
    const btn = $('#saveConfigBtn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '保存中...';
    }

    const success = await saveConfig({
        wsHost: state.wsHost,
        rpcToken: state.rpcToken,
        actionDelay: state.actionDelay,
        cf_autopilot: collectCfConfig(),
    });

    state.isSaving = false;
    if (btn) {
        btn.disabled = false;
        btn.textContent = '保存';
    }

    showToast(
        success ? '配置已保存' : '保存失败，请重试',
        success ? 'success' : 'error'
    );
}

/**
 * Handle platform button click - navigate to platform URL
 * @param {string} platformUrl
 */
async function handlePlatformClick(platformUrl) {
    const tab = await getActiveTab();
    if (tab?.id) {
        chrome.tabs.update(tab.id, { url: platformUrl }, () => {
            window.close();
        });
    }
}

/**
 * Handle refresh button click
 */
async function handleRefresh() {
    const tab = await getActiveTab();
    if (tab?.id) {
        chrome.tabs.reload(tab.id, {}, () => window.close());
    }
}

/**
 * Handle open platform button click
 */
function handleOpenPlatform() {
    const target = state.selectedPlatform || state.currentPlatform || PLATFORMS[0];
    if (target?.defaultUrl) {
        handlePlatformClick(target.defaultUrl);
    }
}

// ============================================================================
// Cloudflare Config
// ============================================================================

/**
 * Read CF config from popup UI
 * @returns {Object}
 */
function collectCfConfig() {
    const toggle = $('#cfAutopilotToggle');
    const wlInput = $('#cfWhitelistInput');
    const enabled = !!toggle?.checked;
    const raw = wlInput?.value || '';

    const whitelist = raw
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);

    return {
        enabled,
        whitelist,
        blacklist: [],
        pollInterval: 2000,
        maxAttemptsPerPage: 3,
        retries: 1,
        timeout: 5000,
    };
}

/**
 * Persist CF config to storage immediately
 */
async function persistCfConfig() {
    const result = await storageGet(STORAGE_KEY);
    const cfg = result[STORAGE_KEY] || {};
    cfg.cf_autopilot = collectCfConfig();
    await saveConfig(cfg);
}

// ============================================================================
// Event Listeners
// ============================================================================

/**
 * Initialize all event listeners
 */
function initEventListeners() {
    // Dropdown trigger button
    const trigger = $('#selectTrigger');
    if (trigger) {
        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleDropdown();
        });
    }

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        const wrapper = $('#customSelectWrapper');
        if (wrapper && !wrapper.contains(e.target)) {
            toggleDropdown(false);
        }
    });

    // Dropdown Search Input
    const searchInput = $('#dropdownSearchInput');
    const clearBtn = $('#clearDropdownSearchBtn');

    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            state.searchKeyword = e.target.value;
            if (clearBtn) {
                clearBtn.style.display = state.searchKeyword ? 'block' : 'none';
            }
            renderPlatformGrid();
        });

        searchInput.addEventListener('click', (e) => {
            e.stopPropagation();
        });
    }

    if (clearBtn) {
        clearBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            state.searchKeyword = '';
            if (searchInput) {
                searchInput.value = '';
                searchInput.focus();
            }
            clearBtn.style.display = 'none';
            renderPlatformGrid();
        });
    }

    // Category Filter Chips
    const categoryFilters = $('#categoryFilters');
    if (categoryFilters) {
        categoryFilters.addEventListener('click', (e) => {
            e.stopPropagation();
            const chip = e.target.closest('.category-chip');
            if (!chip) return;

            const category = chip.dataset.category || 'all';
            state.selectedCategory = category;

            categoryFilters.querySelectorAll('.category-chip').forEach(c => {
                c.classList.toggle('active', c.dataset.category === category);
            });

            renderPlatformGrid();
        });
    }

    // Dropdown Platform selection (event delegation on #platformGrid)
    const grid = $('#platformGrid');
    if (grid) {
        grid.addEventListener('click', (e) => {
            const btn = e.target.closest('.platform-btn');
            const platformId = btn?.dataset.platformId;
            if (platformId) {
                const found = PLATFORMS.find(p => p.id === platformId);
                if (found) {
                    setSelectedPlatform(found);
                    toggleDropdown(false);
                }
            }
        });
    }

    // Quick favorite chips
    const quickChips = $('#quickChips');
    if (quickChips) {
        quickChips.addEventListener('click', (e) => {
            const chip = e.target.closest('.quick-chip');
            const id = chip?.dataset.platformId;
            if (id) {
                const found = PLATFORMS.find(p => p.id === id);
                if (found) {
                    setSelectedPlatform(found);
                    handlePlatformClick(found.defaultUrl);
                }
            }
        });
    }

    // Save config button
    const saveBtn = $('#saveConfigBtn');
    if (saveBtn) saveBtn.addEventListener('click', handleSaveConfig);

    // WebSocket host input
    const wsInput = $('#wsHostInput');
    if (wsInput) {
        wsInput.addEventListener('input', (e) => {
            state.wsHost = e.target.value;
        });
    }

    const tokenInput = $('#rpcTokenInput');
    if (tokenInput) {
        tokenInput.addEventListener('input', (e) => {
            state.rpcToken = e.target.value;
        });
    }

    // Delay slider
    const slider = $('#actionDelaySlider');
    if (slider) {
        slider.addEventListener('input', (e) => {
            state.actionDelay = parseInt(e.target.value, 10);
            updateDelayUI();
        });
    }

    // Delay number input
    const delayInput = $('#delayNumberInput');
    if (delayInput) {
        delayInput.addEventListener('input', (e) => {
            const val = parseInt(e.target.value, 10);
            if (!isNaN(val) && val >= 0) {
                state.actionDelay = val;
                updateDelayUI();
            }
        });
    }

    // Delay preset buttons
    document.querySelectorAll('.delay-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            state.actionDelay = parseInt(btn.dataset.value, 10);
            updateDelayUI();
        });
    });

    // Refresh button
    const refreshBtn = $('#refreshBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', handleRefresh);

    // Open platform button
    const openBtn = $('#openBtn');
    if (openBtn) openBtn.addEventListener('click', handleOpenPlatform);

    // CF autopilot toggle (instant save)
    const cfToggle = $('#cfAutopilotToggle');
    if (cfToggle) {
        cfToggle.addEventListener('change', (e) => {
            persistCfConfig();
            showToast(e.target.checked ? 'CF 自动绕过已开启' : 'CF 自动绕过已关闭', 'info');
        });
    }

    const cfWl = $('#cfWhitelistInput');
    if (cfWl) {
        cfWl.addEventListener('change', persistCfConfig);
    }
}

// ============================================================================
// Initialization
// ============================================================================

/**
 * Initialize popup on DOM ready
 */
function init() {
    loadConfig();
    const totalBadge = $('#platformTotalBadge');
    if (totalBadge) {
        totalBadge.textContent = `共 ${PLATFORMS.length} 平台`;
    }
    renderPlatformGrid();
    initEventListeners();
    updatePlatformStatus();
}

// Run when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
