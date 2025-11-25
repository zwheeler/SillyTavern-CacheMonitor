/**
 * Claude Cache Monitor Extension for SillyTavern
 *
 * Monitors Claude API cache performance by intercepting SSE responses.
 * For streaming requests, we can capture the message_delta event which
 * contains cache_read_input_tokens and cache_creation_input_tokens.
 */

import { eventSource, event_types, saveSettingsDebounced, chat } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { oai_settings, chat_completion_sources } from '../../../openai.js';

const extensionName = 'Extension-CacheMonitor';

// Default settings
const defaultSettings = {
    enabled: true,
    panelCollapsed: false,
    autoPauseOnWaste: true,
    wasteThreshold: 3,
    showPanel: true,
};

// Session statistics
let sessionStats = {
    totalRequests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    consecutiveMisses: 0,
    totalInputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    lastUsage: null,
    requestHistory: [],
};

// Current request tracking
let currentRequest = {
    active: false,
    startTime: null,
    usage: null,
};

/**
 * Check if the current model is a Claude model (direct or via OpenRouter)
 */
function isClaudeModel() {
    const source = oai_settings?.chat_completion_source;
    const model = oai_settings?.openai_model || '';

    if (source === chat_completion_sources.CLAUDE) {
        return true;
    }
    if (source === chat_completion_sources.OPENROUTER && /claude/i.test(model)) {
        return true;
    }
    return false;
}

/**
 * Parse Claude SSE event for usage data
 * Claude sends usage in message_delta events with type "message_delta"
 */
function parseClaudeUsage(eventData) {
    try {
        const data = JSON.parse(eventData);

        // Direct Claude API format
        if (data.type === 'message_delta' && data.usage) {
            return {
                input_tokens: data.usage.input_tokens,
                output_tokens: data.usage.output_tokens,
                cache_read_input_tokens: data.usage.cache_read_input_tokens || 0,
                cache_creation_input_tokens: data.usage.cache_creation_input_tokens || 0,
            };
        }

        // Message stop event (also contains usage)
        if (data.type === 'message_stop' && data.message?.usage) {
            return {
                input_tokens: data.message.usage.input_tokens,
                output_tokens: data.message.usage.output_tokens,
                cache_read_input_tokens: data.message.usage.cache_read_input_tokens || 0,
                cache_creation_input_tokens: data.message.usage.cache_creation_input_tokens || 0,
            };
        }

        // OpenRouter format (wraps Claude response)
        if (data.usage) {
            return {
                input_tokens: data.usage.prompt_tokens || data.usage.input_tokens || 0,
                output_tokens: data.usage.completion_tokens || data.usage.output_tokens || 0,
                cache_read_input_tokens: data.usage.cache_read_input_tokens || 0,
                cache_creation_input_tokens: data.usage.cache_creation_input_tokens || 0,
            };
        }
    } catch (e) {
        // Not JSON or doesn't have usage, that's fine
    }
    return null;
}

/**
 * Process captured usage data
 */
function processUsageData(usage) {
    if (!usage) return;

    currentRequest.usage = usage;
    sessionStats.totalRequests++;
    sessionStats.totalInputTokens += usage.input_tokens || 0;
    sessionStats.totalCacheReadTokens += usage.cache_read_input_tokens || 0;
    sessionStats.totalCacheWriteTokens += usage.cache_creation_input_tokens || 0;
    sessionStats.lastUsage = usage;

    // Determine if this was a cache hit
    // A "hit" means we read from cache, a "miss" means we wrote to cache (or neither)
    const hadCacheRead = (usage.cache_read_input_tokens || 0) > 0;
    const hadCacheWrite = (usage.cache_creation_input_tokens || 0) > 0;

    if (hadCacheRead) {
        sessionStats.cacheHits++;
        sessionStats.consecutiveMisses = 0;
    } else if (hadCacheWrite) {
        // Writing to cache without reading = miss (first request or cache expired)
        sessionStats.cacheMisses++;
        sessionStats.consecutiveMisses++;
    } else {
        // No cache activity at all - might be below threshold or caching disabled
        sessionStats.consecutiveMisses++;
    }

    // Store in history
    const responseTime = currentRequest.startTime ? Date.now() - currentRequest.startTime : 0;
    sessionStats.requestHistory.push({
        timestamp: Date.now(),
        responseTimeMs: responseTime,
        usage: { ...usage },
        cacheHit: hadCacheRead,
        cacheWrite: hadCacheWrite,
    });

    // Keep only last 50 requests
    if (sessionStats.requestHistory.length > 50) {
        sessionStats.requestHistory.shift();
    }

    // Check for waste warning
    const settings = extension_settings[extensionName];
    if (settings?.autoPauseOnWaste && sessionStats.consecutiveMisses >= settings.wasteThreshold) {
        toastr.warning(
            `${sessionStats.consecutiveMisses} consecutive cache misses detected. ` +
            'Cache writes cost 25% more than regular input. Consider checking prompt stability.',
            'Cache Waste Warning',
            { timeOut: 10000 }
        );
    }

    // Save usage to the current chat message
    saveUsageToMessage(usage);

    updatePanel();

    console.log('[CacheMonitor] Usage captured:', usage);
}

/**
 * Save usage data to the current chat message's extra field
 */
function saveUsageToMessage(usage) {
    if (!chat || chat.length === 0) return;

    const lastMessage = chat[chat.length - 1];
    if (lastMessage && !lastMessage.is_user) {
        if (!lastMessage.extra) {
            lastMessage.extra = {};
        }
        lastMessage.extra.cache_read_input_tokens = usage.cache_read_input_tokens;
        lastMessage.extra.cache_creation_input_tokens = usage.cache_creation_input_tokens;
        lastMessage.extra.input_tokens = usage.input_tokens;
        lastMessage.extra.output_tokens = usage.output_tokens;
    }
}

/**
 * Intercept fetch to capture SSE responses
 */
function setupFetchInterceptor() {
    const originalFetch = window.fetch;

    window.fetch = async function (...args) {
        const [url, options] = args;

        // Check if this is a Claude API request
        const isClaudeRequest = (
            (typeof url === 'string' && (
                url.includes('/api/backends/chat-completions/generate') ||
                url.includes('/v1/messages') ||
                url.includes('anthropic')
            )) ||
            (url instanceof Request && (
                url.url.includes('/api/backends/chat-completions/generate') ||
                url.url.includes('/v1/messages')
            ))
        );

        if (!isClaudeRequest || !isClaudeModel()) {
            return originalFetch.apply(this, args);
        }

        // Check if streaming
        let isStreaming = false;
        try {
            if (options?.body) {
                const body = JSON.parse(options.body);
                isStreaming = body.stream === true;
            }
        } catch (e) {
            // Can't parse body, assume not streaming
        }

        currentRequest.active = true;
        currentRequest.startTime = Date.now();
        currentRequest.usage = null;

        const response = await originalFetch.apply(this, args);

        if (!isStreaming) {
            // For non-streaming, try to clone and read the response
            try {
                const cloned = response.clone();
                const data = await cloned.json();
                if (data.usage) {
                    processUsageData({
                        input_tokens: data.usage.input_tokens || 0,
                        output_tokens: data.usage.output_tokens || 0,
                        cache_read_input_tokens: data.usage.cache_read_input_tokens || 0,
                        cache_creation_input_tokens: data.usage.cache_creation_input_tokens || 0,
                    });
                }
            } catch (e) {
                // Couldn't parse response
            }
            return response;
        }

        // For streaming, we need to intercept the readable stream
        const originalBody = response.body;
        if (!originalBody) {
            return response;
        }

        const reader = originalBody.getReader();
        const decoder = new TextDecoder();

        let sseBuffer = '';

        const interceptedStream = new ReadableStream({
            async start(controller) {
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) {
                            controller.close();
                            currentRequest.active = false;
                            break;
                        }

                        // Pass through the original data
                        controller.enqueue(value);

                        // Also parse it for usage data
                        const chunk = decoder.decode(value, { stream: true });
                        sseBuffer += chunk;

                        // Parse SSE events
                        const events = sseBuffer.split(/\n\n/);
                        sseBuffer = events.pop() || ''; // Keep incomplete event in buffer

                        for (const event of events) {
                            const lines = event.split('\n');
                            for (const line of lines) {
                                if (line.startsWith('data: ')) {
                                    const eventData = line.slice(6);
                                    if (eventData !== '[DONE]') {
                                        const usage = parseClaudeUsage(eventData);
                                        if (usage && (usage.input_tokens || usage.cache_read_input_tokens)) {
                                            processUsageData(usage);
                                        }
                                    }
                                }
                            }
                        }
                    }
                } catch (error) {
                    controller.error(error);
                    currentRequest.active = false;
                }
            },
            cancel() {
                reader.cancel();
                currentRequest.active = false;
            },
        });

        // Return a new response with our intercepted stream
        return new Response(interceptedStream, {
            headers: response.headers,
            status: response.status,
            statusText: response.statusText,
        });
    };

    console.log('[CacheMonitor] Fetch interceptor installed');
}

/**
 * Update the monitoring panel UI
 */
function updatePanel() {
    const panel = document.getElementById('cache_monitor_panel');
    if (!panel) return;

    const settings = extension_settings[extensionName];
    if (!settings?.showPanel) {
        panel.style.display = 'none';
        return;
    }

    panel.style.display = 'block';

    // Calculate hit rate
    const totalWithCache = sessionStats.cacheHits + sessionStats.cacheMisses;
    const hitRate = totalWithCache > 0
        ? Math.round((sessionStats.cacheHits / totalWithCache) * 100)
        : 0;

    // Calculate savings
    const cacheReadTokens = sessionStats.totalCacheReadTokens;
    const cacheWriteTokens = sessionStats.totalCacheWriteTokens;
    // Cache reads are 90% cheaper, cache writes are 25% more expensive
    const savingsTokens = Math.round(cacheReadTokens * 0.9 - cacheWriteTokens * 0.25);

    // Update display
    document.getElementById('cache_total_requests').textContent = sessionStats.totalRequests;
    document.getElementById('cache_hit_rate').textContent = totalWithCache > 0 ? `${hitRate}%` : '--';
    document.getElementById('cache_read_tokens').textContent = cacheReadTokens.toLocaleString();
    document.getElementById('cache_write_tokens').textContent = cacheWriteTokens.toLocaleString();
    document.getElementById('cache_savings').textContent = savingsTokens > 0 ? `+${savingsTokens.toLocaleString()}` : savingsTokens.toLocaleString();

    // Update hit rate styling
    const hitRateEl = document.getElementById('cache_hit_rate');
    hitRateEl.className = 'cache_stat_value';
    if (hitRate >= 70) {
        hitRateEl.classList.add('good');
    } else if (hitRate >= 40) {
        hitRateEl.classList.add('neutral');
    } else if (totalWithCache > 0) {
        hitRateEl.classList.add('bad');
    }

    // Update savings styling
    const savingsEl = document.getElementById('cache_savings');
    savingsEl.className = 'cache_stat_value';
    if (savingsTokens > 0) {
        savingsEl.classList.add('good');
    } else if (savingsTokens < 0) {
        savingsEl.classList.add('bad');
    }

    // Update efficiency bar
    document.getElementById('cache_efficiency_fill').style.width = `${hitRate}%`;

    // Update recommendation
    const recEl = document.getElementById('cache_recommendation');
    if (!isClaudeModel()) {
        recEl.textContent = 'Not using Claude model';
        recEl.style.color = '';
    } else if (sessionStats.consecutiveMisses >= settings.wasteThreshold) {
        recEl.textContent = `⚠️ ${sessionStats.consecutiveMisses} consecutive misses - check prompt stability`;
        recEl.style.color = '#f87171';
    } else if (hitRate >= 70 && totalWithCache > 2) {
        recEl.textContent = '✓ Excellent cache efficiency';
        recEl.style.color = '#4ade80';
    } else if (totalWithCache < 2) {
        recEl.textContent = 'Gathering data...';
        recEl.style.color = '';
    } else if (cacheWriteTokens > 0 && cacheReadTokens === 0) {
        recEl.textContent = 'Only writing cache - no hits yet';
        recEl.style.color = '#fbbf24';
    } else {
        recEl.textContent = 'Low cache efficiency - prompts may be unstable';
        recEl.style.color = '#fbbf24';
    }

    // Update last usage display
    if (sessionStats.lastUsage) {
        const u = sessionStats.lastUsage;
        document.getElementById('cache_last_usage').textContent =
            `In: ${u.input_tokens} | Read: ${u.cache_read_input_tokens} | Write: ${u.cache_creation_input_tokens}`;
    }
}

/**
 * Create and inject the monitoring panel
 */
function createPanel() {
    const existingPanel = document.getElementById('cache_monitor_panel');
    if (existingPanel) {
        existingPanel.remove();
    }

    const settings = extension_settings[extensionName];
    const panel = document.createElement('div');
    panel.id = 'cache_monitor_panel';
    if (settings?.panelCollapsed) {
        panel.classList.add('collapsed');
    }

    panel.innerHTML = `
        <div id="cache_monitor_header">
            <span id="cache_monitor_title">Cache Monitor</span>
            <span id="cache_monitor_toggle">${settings?.panelCollapsed ? '▶' : '▼'}</span>
        </div>
        <div class="cache_monitor_content">
            <div class="cache_stat_row">
                <span class="cache_stat_label">Requests:</span>
                <span id="cache_total_requests" class="cache_stat_value">0</span>
            </div>
            <div class="cache_stat_row">
                <span class="cache_stat_label">Hit Rate:</span>
                <span id="cache_hit_rate" class="cache_stat_value">--</span>
            </div>
            <div class="cache_stat_row">
                <span class="cache_stat_label">Cache Read:</span>
                <span id="cache_read_tokens" class="cache_stat_value good">0</span>
            </div>
            <div class="cache_stat_row">
                <span class="cache_stat_label">Cache Write:</span>
                <span id="cache_write_tokens" class="cache_stat_value neutral">0</span>
            </div>
            <div class="cache_stat_row">
                <span class="cache_stat_label">Net Savings:</span>
                <span id="cache_savings" class="cache_stat_value">0</span>
            </div>
            <div id="cache_efficiency_bar">
                <div id="cache_efficiency_fill" style="width: 0%"></div>
            </div>
            <div id="cache_last_usage" style="font-size: 10px; opacity: 0.7; margin-top: 4px;">--</div>
            <div id="cache_recommendation">Waiting for Claude requests...</div>
            <button id="cache_reset_stats" class="cache_action_btn">Reset Stats</button>
        </div>
    `;

    document.body.appendChild(panel);

    // Event handlers
    document.getElementById('cache_monitor_header').addEventListener('click', () => {
        panel.classList.toggle('collapsed');
        const toggle = document.getElementById('cache_monitor_toggle');
        toggle.textContent = panel.classList.contains('collapsed') ? '▶' : '▼';
        extension_settings[extensionName].panelCollapsed = panel.classList.contains('collapsed');
        saveSettingsDebounced();
    });

    document.getElementById('cache_reset_stats').addEventListener('click', () => {
        sessionStats = {
            totalRequests: 0,
            cacheHits: 0,
            cacheMisses: 0,
            consecutiveMisses: 0,
            totalInputTokens: 0,
            totalCacheReadTokens: 0,
            totalCacheWriteTokens: 0,
            lastUsage: null,
            requestHistory: [],
        };
        updatePanel();
        toastr.info('Cache stats reset');
    });

    updatePanel();
}

/**
 * Initialize extension settings
 */
function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};

    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[extensionName][key] === undefined) {
            extension_settings[extensionName][key] = value;
        }
    }
}

/**
 * Add settings UI to the extensions panel
 */
async function addSettingsUI() {
    const settingsHtml = `
        <div class="cache_monitor_settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Cache Monitor</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="cache_monitor_settings_content">
                        <label class="checkbox_label">
                            <input type="checkbox" id="cache_monitor_show_panel" />
                            <span>Show Floating Panel</span>
                        </label>
                        <label class="checkbox_label">
                            <input type="checkbox" id="cache_monitor_auto_warn" />
                            <span>Warn on Cache Waste</span>
                        </label>
                        <div>
                            <label for="cache_monitor_waste_threshold">Waste Threshold:</label>
                            <input type="number" id="cache_monitor_waste_threshold" min="1" max="10" value="3" style="width: 50px" />
                            <small>consecutive misses</small>
                        </div>
                        <hr />
                        <p style="font-size: 11px; opacity: 0.7;">
                            This extension intercepts Claude API responses to capture
                            <code>cache_read_input_tokens</code> and <code>cache_creation_input_tokens</code>.
                            Works with streaming requests.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    `;

    $('#extensions_settings').append(settingsHtml);

    const settings = extension_settings[extensionName];

    $('#cache_monitor_show_panel').prop('checked', settings.showPanel).on('change', function () {
        settings.showPanel = this.checked;
        updatePanel();
        saveSettingsDebounced();
    });

    $('#cache_monitor_auto_warn').prop('checked', settings.autoPauseOnWaste).on('change', function () {
        settings.autoPauseOnWaste = this.checked;
        saveSettingsDebounced();
    });

    $('#cache_monitor_waste_threshold').val(settings.wasteThreshold).on('change', function () {
        settings.wasteThreshold = parseInt(this.value) || 3;
        saveSettingsDebounced();
    });
}

// Initialize
jQuery(async () => {
    loadSettings();
    await addSettingsUI();
    createPanel();
    setupFetchInterceptor();

    console.log('[CacheMonitor] Extension loaded - intercepting Claude API responses');
});
