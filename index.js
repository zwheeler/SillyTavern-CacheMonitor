/**
 * Claude Cache Monitor Extension for SillyTavern
 *
 * Monitors Claude API cache performance by intercepting SSE responses.
 * Works with OpenRouter and direct Claude API.
 */

import { saveSettingsDebounced, chat } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

const extensionName = 'SillyTavern-CacheMonitor';
const DEBUG = true; // Set to true to see console logs

function log(...args) {
    if (DEBUG) console.log('[CacheMonitor]', ...args);
}

// Default settings
const defaultSettings = {
    enabled: true,
    panelCollapsed: false,
    autoPauseOnWaste: true,
    wasteThreshold: 3,
    showPanel: true,
    openrouterApiKey: '', // User's OpenRouter API key for generation stats
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
    messages: null, // Store the messages sent
};

/**
 * Track if we've seen any Claude usage this session
 */
let detectedClaudeUsage = false;

/**
 * Store previous request data for comparison
 */
let previousRequest = {
    messages: null,
    messageHashes: null,
    systemPrompt: null,
    systemPromptHash: null,
    timestamp: null,
};

/**
 * Simple string hash function
 */
function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(16);
}

/**
 * Hash each message in the array
 */
function hashMessages(messages) {
    if (!messages || !Array.isArray(messages)) return [];
    return messages.map((msg, idx) => ({
        index: idx,
        role: msg.role,
        contentPreview: typeof msg.content === 'string'
            ? msg.content.substring(0, 100)
            : JSON.stringify(msg.content).substring(0, 100),
        hash: hashString(JSON.stringify(msg)),
        hasCacheControl: !!msg.cache_control,
    }));
}

/**
 * Find where messages diverge between two requests
 */
function findDivergencePoint(prevHashes, currHashes) {
    if (!prevHashes || !currHashes) return { divergeIndex: 0, reason: 'No previous data' };

    const minLen = Math.min(prevHashes.length, currHashes.length);

    for (let i = 0; i < minLen; i++) {
        if (prevHashes[i].hash !== currHashes[i].hash) {
            return {
                divergeIndex: i,
                reason: `Message ${i} changed`,
                prevContent: prevHashes[i].contentPreview,
                currContent: currHashes[i].contentPreview,
                role: currHashes[i].role,
            };
        }
    }

    if (prevHashes.length !== currHashes.length) {
        return {
            divergeIndex: minLen,
            reason: `Message count changed (${prevHashes.length} → ${currHashes.length})`,
        };
    }

    return { divergeIndex: -1, reason: 'No divergence detected' };
}

/**
 * Analyze why cache missed
 */
function analyzeCacheMiss(currentMessages, currentHashes) {
    const analysis = {
        reasons: [],
        divergence: null,
        ttlWarning: false,
        timeSinceLastRequest: null,
    };

    // Check TTL (5 minutes = 300000ms)
    if (previousRequest.timestamp) {
        const timeSince = Date.now() - previousRequest.timestamp;
        analysis.timeSinceLastRequest = timeSince;
        if (timeSince > 300000) {
            analysis.reasons.push(`TTL expired (${Math.round(timeSince / 1000)}s since last request, max 300s)`);
            analysis.ttlWarning = true;
        }
    } else {
        analysis.reasons.push('First request - no previous cache');
    }

    // Check for divergence
    if (previousRequest.messageHashes) {
        const divergence = findDivergencePoint(previousRequest.messageHashes, currentHashes);
        analysis.divergence = divergence;

        if (divergence.divergeIndex >= 0) {
            analysis.reasons.push(divergence.reason);
        }
    }

    // Check if system prompt changed
    if (currentMessages && currentMessages.length > 0) {
        const firstMsg = currentMessages[0];
        if (firstMsg.role === 'system') {
            const currSysHash = hashString(JSON.stringify(firstMsg));
            if (previousRequest.systemPromptHash && previousRequest.systemPromptHash !== currSysHash) {
                analysis.reasons.push('System prompt changed');
            }
        }
    }

    return analysis;
}

/**
 * Fetch detailed generation stats from OpenRouter API
 * @param {string} generationId - The generation ID from the response
 * @returns {Promise<object|null>} Generation details with cache info
 */
async function fetchOpenRouterGenerationStats(generationId) {
    try {
        // Get the OpenRouter API key from extension settings
        const settings = extension_settings[extensionName];
        const apiKey = settings?.openrouterApiKey;

        if (!apiKey) {
            log('OpenRouter API key not configured in extension settings');
            return null;
        }

        // Query OpenRouter's generation endpoint
        const genResponse = await fetch(`https://openrouter.ai/api/v1/generation?id=${generationId}`, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
            },
        });

        if (!genResponse.ok) {
            log('OpenRouter generation query failed:', genResponse.status);
            return null;
        }

        const genData = await genResponse.json();
        log('OpenRouter generation data:', genData);
        return genData?.data;
    } catch (e) {
        log('Error fetching OpenRouter generation stats:', e);
        return null;
    }
}

/**
 * Parse usage data from SSE event
 * Handles both OpenRouter (OpenAI format) and direct Claude format
 * Returns { usage, model } or null
 */
function parseUsageFromEvent(eventData) {
    try {
        const data = JSON.parse(eventData);

        // OpenRouter/OpenAI format - usage in root or in choices
        if (data.usage) {
            log('Found usage in OpenAI format:', data.usage, 'model:', data.model);
            return {
                model: data.model || '',
                input_tokens: data.usage.prompt_tokens || data.usage.input_tokens || 0,
                output_tokens: data.usage.completion_tokens || data.usage.output_tokens || 0,
                // OpenRouter passes through Claude's cache tokens
                cache_read_input_tokens: data.usage.cache_read_input_tokens ||
                                         data.usage.prompt_tokens_details?.cached_tokens || 0,
                cache_creation_input_tokens: data.usage.cache_creation_input_tokens || 0,
            };
        }

        // Direct Claude API - message_delta with usage
        if (data.type === 'message_delta' && data.usage) {
            log('Found usage in Claude message_delta:', data.usage);
            return {
                model: 'claude', // Direct Claude API
                input_tokens: data.usage.input_tokens || 0,
                output_tokens: data.usage.output_tokens || 0,
                cache_read_input_tokens: data.usage.cache_read_input_tokens || 0,
                cache_creation_input_tokens: data.usage.cache_creation_input_tokens || 0,
            };
        }

        // Direct Claude API - message_start contains initial usage
        if (data.type === 'message_start' && data.message?.usage) {
            log('Found usage in Claude message_start:', data.message.usage);
            return {
                model: data.message?.model || 'claude', // Direct Claude API
                input_tokens: data.message.usage.input_tokens || 0,
                output_tokens: data.message.usage.output_tokens || 0,
                cache_read_input_tokens: data.message.usage.cache_read_input_tokens || 0,
                cache_creation_input_tokens: data.message.usage.cache_creation_input_tokens || 0,
            };
        }

    } catch (e) {
        // Not JSON or parse error - that's normal for non-data events
    }
    return null;
}

/**
 * Process captured usage data
 */
function processUsageData(usage) {
    if (!usage) return;

    // Check if this is a Claude model by looking at the model field in the response
    const model = usage.model || '';
    const isClaude = /claude/i.test(model);

    if (!isClaude) {
        log('Not a Claude model, skipping. Model:', model);
        return;
    }

    log('Claude model detected:', model);

    const hadCacheRead = (usage.cache_read_input_tokens || 0) > 0;
    const hadCacheWrite = (usage.cache_creation_input_tokens || 0) > 0;

    // Mark that we've detected Claude usage
    detectedClaudeUsage = true;

    currentRequest.usage = usage;
    sessionStats.totalRequests++;
    sessionStats.totalInputTokens += usage.input_tokens || 0;
    sessionStats.totalCacheReadTokens += usage.cache_read_input_tokens || 0;
    sessionStats.totalCacheWriteTokens += usage.cache_creation_input_tokens || 0;
    sessionStats.lastUsage = usage;

    if (hadCacheRead) {
        sessionStats.cacheHits++;
        sessionStats.consecutiveMisses = 0;
    } else if (hadCacheWrite) {
        sessionStats.cacheMisses++;
        sessionStats.consecutiveMisses++;
    }

    // Store in history with cost calculation and analysis
    const responseTime = currentRequest.startTime ? Date.now() - currentRequest.startTime : 0;
    const costs = calculateCosts(usage);

    // Analyze current request
    const currentHashes = hashMessages(currentRequest.messages);
    let analysis = null;

    // If cache miss (write but no read), analyze why
    if (hadCacheWrite && !hadCacheRead) {
        analysis = analyzeCacheMiss(currentRequest.messages, currentHashes);
        log('Cache miss analysis:', analysis);
    }

    sessionStats.requestHistory.push({
        timestamp: Date.now(),
        responseTimeMs: responseTime,
        usage: { ...usage },
        cacheHit: hadCacheRead,
        cacheWrite: hadCacheWrite,
        costs,
        analysis,
        messageHashes: currentHashes,
        messageCount: currentRequest.messages?.length || 0,
    });

    // Store current request as previous for next comparison
    if (currentRequest.messages) {
        previousRequest = {
            messages: currentRequest.messages,
            messageHashes: currentHashes,
            systemPrompt: currentRequest.messages[0]?.role === 'system' ? currentRequest.messages[0] : null,
            systemPromptHash: currentRequest.messages[0]?.role === 'system'
                ? hashString(JSON.stringify(currentRequest.messages[0]))
                : null,
            timestamp: Date.now(),
        };
    }

    if (sessionStats.requestHistory.length > 100) {
        sessionStats.requestHistory.shift();
    }

    // Warn on waste
    const settings = extension_settings[extensionName];
    if (settings?.autoPauseOnWaste && sessionStats.consecutiveMisses >= settings.wasteThreshold) {
        toastr.warning(
            `${sessionStats.consecutiveMisses} consecutive cache misses. Check prompt stability.`,
            'Cache Waste Warning',
            { timeOut: 10000 }
        );
    }

    saveUsageToMessage(usage);
    updatePanel();

    log('Usage processed:', usage);
}

/**
 * Calculate costs for a request based on Claude pricing
 * Prices per 1M tokens (Sonnet 4.5): Input $3, Output $15, Cache Write $3.75, Cache Read $0.30
 */
function calculateCosts(usage) {
    const model = usage.model || '';

    // Default to Sonnet pricing, adjust for other models
    let inputPrice = 3.0;    // per 1M tokens
    let outputPrice = 15.0;
    let cacheWritePrice = 3.75;  // 25% more than input
    let cacheReadPrice = 0.30;   // 90% less than input

    if (/opus/i.test(model)) {
        inputPrice = 15.0;
        outputPrice = 75.0;
        cacheWritePrice = 18.75;
        cacheReadPrice = 1.50;
    } else if (/haiku/i.test(model)) {
        inputPrice = 0.80;
        outputPrice = 4.0;
        cacheWritePrice = 1.0;
        cacheReadPrice = 0.08;
    }

    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const cacheRead = usage.cache_read_input_tokens || 0;
    const cacheWrite = usage.cache_creation_input_tokens || 0;

    // Non-cached input tokens = total input - cache read
    const nonCachedInput = Math.max(0, inputTokens - cacheRead);

    const inputCost = (nonCachedInput / 1_000_000) * inputPrice;
    const outputCost = (outputTokens / 1_000_000) * outputPrice;
    const cacheWriteCost = (cacheWrite / 1_000_000) * cacheWritePrice;
    const cacheReadCost = (cacheRead / 1_000_000) * cacheReadPrice;

    const totalCost = inputCost + outputCost + cacheWriteCost + cacheReadCost;

    // What it would have cost without caching
    const costWithoutCache = ((inputTokens / 1_000_000) * inputPrice) + outputCost;
    const savings = costWithoutCache - totalCost;

    return {
        inputCost,
        outputCost,
        cacheWriteCost,
        cacheReadCost,
        totalCost,
        costWithoutCache,
        savings,
    };
}

/**
 * Format a timestamp as a time string
 */
function formatTime(timestamp) {
    const d = new Date(timestamp);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * Format cost as currency
 */
function formatCost(cost) {
    if (cost < 0.0001) return '<$0.0001';
    if (cost < 0.01) return `$${cost.toFixed(4)}`;
    return `$${cost.toFixed(4)}`;
}

/**
 * Show the history modal
 */
function showHistoryModal() {
    // Remove existing modal
    const existing = document.getElementById('cache_history_modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'cache_history_modal';
    modal.innerHTML = `
        <div class="cache_modal_backdrop"></div>
        <div class="cache_modal_content">
            <div class="cache_modal_header">
                <h3>Request History</h3>
                <button class="cache_modal_close">&times;</button>
            </div>
            <div class="cache_modal_body">
                <table class="cache_history_table">
                    <thead>
                        <tr>
                            <th>Time</th>
                            <th>Model</th>
                            <th>Msgs</th>
                            <th>Input</th>
                            <th>Cache Read</th>
                            <th>Cache Write</th>
                            <th>Status</th>
                            <th>Cost</th>
                            <th>Analysis</th>
                        </tr>
                    </thead>
                    <tbody id="cache_history_tbody">
                    </tbody>
                </table>
                ${sessionStats.requestHistory.length === 0 ? '<p style="text-align: center; opacity: 0.7; margin-top: 20px;">No requests recorded yet</p>' : ''}
            </div>
            <div class="cache_modal_footer">
                <div class="cache_modal_summary">
                    <span>Total Requests: <b>${sessionStats.totalRequests}</b></span>
                    <span>Total Cost: <b>${formatCost(sessionStats.requestHistory.reduce((sum, r) => sum + (r.costs?.totalCost || 0), 0))}</b></span>
                    <span>Total Savings: <b class="good">${formatCost(sessionStats.requestHistory.reduce((sum, r) => sum + (r.costs?.savings || 0), 0))}</b></span>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    // Populate table
    const tbody = document.getElementById('cache_history_tbody');
    const history = [...sessionStats.requestHistory].reverse(); // Most recent first

    for (let i = 0; i < history.length; i++) {
        const entry = history[i];
        const row = document.createElement('tr');
        row.className = 'cache_history_row';
        row.dataset.index = i;
        const u = entry.usage;
        const c = entry.costs || {};

        let status = '';
        let statusClass = '';
        if (entry.cacheHit) {
            status = 'HIT ✓';
            statusClass = 'good';
        } else if (entry.cacheWrite) {
            status = 'WRITE';
            statusClass = 'neutral';
        } else {
            status = 'MISS';
            statusClass = 'bad';
        }

        // Shorten model name
        let modelShort = u.model || 'Unknown';
        modelShort = modelShort.replace('claude-', '').replace('-20250929', '').replace('-20251124', '');

        // Analysis summary
        let analysisText = '';
        let analysisClass = '';
        if (entry.cacheHit) {
            analysisText = 'Cache working';
            analysisClass = 'good';
        } else if (entry.analysis) {
            if (entry.analysis.reasons.length > 0) {
                analysisText = entry.analysis.reasons[0];
                if (entry.analysis.reasons.length > 1) {
                    analysisText += ` (+${entry.analysis.reasons.length - 1})`;
                }
            }
            analysisClass = entry.analysis.ttlWarning ? 'neutral' : 'bad';
        } else {
            analysisText = '--';
        }

        row.innerHTML = `
            <td>${formatTime(entry.timestamp)}</td>
            <td title="${u.model}">${modelShort}</td>
            <td>${entry.messageCount || '--'}</td>
            <td>${(u.input_tokens || 0).toLocaleString()}</td>
            <td class="good">${(u.cache_read_input_tokens || 0).toLocaleString()}</td>
            <td class="neutral">${(u.cache_creation_input_tokens || 0).toLocaleString()}</td>
            <td class="${statusClass}">${status}</td>
            <td>${formatCost(c.totalCost || 0)}</td>
            <td class="${analysisClass} analysis-cell" title="Click for details">${analysisText}</td>
        `;

        // Add click handler to show detailed analysis
        row.addEventListener('click', () => showAnalysisDetail(entry, i));
        tbody.appendChild(row);
    }

    // Close handlers
    modal.querySelector('.cache_modal_backdrop').addEventListener('click', () => modal.remove());
    modal.querySelector('.cache_modal_close').addEventListener('click', () => modal.remove());
}

/**
 * Show detailed analysis for a request
 */
function showAnalysisDetail(entry, index) {
    const existing = document.getElementById('cache_analysis_detail');
    if (existing) existing.remove();

    const u = entry.usage;
    const a = entry.analysis;

    let detailHtml = `
        <div class="analysis_section">
            <h4>Request Details</h4>
            <div class="analysis_row"><span>Time:</span> <span>${formatTime(entry.timestamp)}</span></div>
            <div class="analysis_row"><span>Model:</span> <span>${u.model}</span></div>
            <div class="analysis_row"><span>Messages:</span> <span>${entry.messageCount || 'Unknown'}</span></div>
            <div class="analysis_row"><span>Input Tokens:</span> <span>${(u.input_tokens || 0).toLocaleString()}</span></div>
            <div class="analysis_row"><span>Output Tokens:</span> <span>${(u.output_tokens || 0).toLocaleString()}</span></div>
            <div class="analysis_row"><span>Cache Read:</span> <span class="good">${(u.cache_read_input_tokens || 0).toLocaleString()}</span></div>
            <div class="analysis_row"><span>Cache Write:</span> <span class="neutral">${(u.cache_creation_input_tokens || 0).toLocaleString()}</span></div>
        </div>
    `;

    if (entry.cacheHit) {
        detailHtml += `
            <div class="analysis_section success">
                <h4>✓ Cache Hit</h4>
                <p>The prompt prefix matched the cached version. ${(u.cache_read_input_tokens || 0).toLocaleString()} tokens were read from cache.</p>
            </div>
        `;
    } else if (a) {
        detailHtml += `
            <div class="analysis_section warning">
                <h4>⚠ Cache Miss - Why?</h4>
                <ul class="analysis_reasons">
                    ${a.reasons.map(r => `<li>${r}</li>`).join('')}
                </ul>
            </div>
        `;

        if (a.divergence && a.divergence.divergeIndex >= 0) {
            detailHtml += `
                <div class="analysis_section">
                    <h4>Divergence Point</h4>
                    <p>Messages diverged at index <b>${a.divergence.divergeIndex}</b> (${a.divergence.role || 'unknown'} role)</p>
                    ${a.divergence.prevContent ? `
                        <div class="diff_box">
                            <div class="diff_label">Previous:</div>
                            <div class="diff_content">${escapeHtml(a.divergence.prevContent)}...</div>
                        </div>
                        <div class="diff_box">
                            <div class="diff_label">Current:</div>
                            <div class="diff_content">${escapeHtml(a.divergence.currContent)}...</div>
                        </div>
                    ` : ''}
                </div>
            `;
        }

        if (a.timeSinceLastRequest) {
            const seconds = Math.round(a.timeSinceLastRequest / 1000);
            const ttlClass = seconds > 300 ? 'bad' : (seconds > 240 ? 'neutral' : 'good');
            detailHtml += `
                <div class="analysis_section">
                    <h4>TTL Status</h4>
                    <p>Time since last request: <span class="${ttlClass}">${seconds}s</span> (TTL: 300s)</p>
                    <div class="ttl_bar">
                        <div class="ttl_fill ${ttlClass}" style="width: ${Math.min(100, (seconds / 300) * 100)}%"></div>
                    </div>
                </div>
            `;
        }
    }

    // Message structure visualization
    if (entry.messageHashes && entry.messageHashes.length > 0) {
        detailHtml += `
            <div class="analysis_section">
                <h4>Message Structure</h4>
                <div class="message_structure">
                    ${entry.messageHashes.map((h, i) => `
                        <div class="msg_block ${h.hasCacheControl ? 'has_cache' : ''}" title="${h.contentPreview}">
                            <span class="msg_index">${i}</span>
                            <span class="msg_role">${h.role}</span>
                            ${h.hasCacheControl ? '<span class="cache_marker">⚡</span>' : ''}
                        </div>
                    `).join('')}
                </div>
                <p class="structure_legend">
                    <span class="legend_item"><span class="cache_marker">⚡</span> = cache_control marker</span>
                </p>
            </div>
        `;
    }

    const detail = document.createElement('div');
    detail.id = 'cache_analysis_detail';
    detail.innerHTML = `
        <div class="cache_modal_backdrop"></div>
        <div class="cache_detail_content">
            <div class="cache_modal_header">
                <h3>Request Analysis #${sessionStats.requestHistory.length - index}</h3>
                <button class="cache_modal_close">&times;</button>
            </div>
            <div class="cache_detail_body">
                ${detailHtml}
            </div>
        </div>
    `;

    document.body.appendChild(detail);

    detail.querySelector('.cache_modal_backdrop').addEventListener('click', () => detail.remove());
    detail.querySelector('.cache_modal_close').addEventListener('click', () => detail.remove());
}

/**
 * Escape HTML special characters
 */
function escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Save usage data to the current chat message
 */
function saveUsageToMessage(usage) {
    if (!chat || chat.length === 0) return;

    const lastMessage = chat[chat.length - 1];
    if (lastMessage && !lastMessage.is_user) {
        if (!lastMessage.extra) lastMessage.extra = {};
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
        const urlStr = typeof url === 'string' ? url : url?.url || '';

        // Check if this is a chat completion request
        const isChatRequest = urlStr.includes('/api/backends/chat-completions/generate');

        if (!isChatRequest) {
            return originalFetch.apply(this, args);
        }

        // Intercept ALL chat completion requests - we'll check for cache data in the response
        log('Intercepting chat completion request:', urlStr);

        // Check if streaming and capture messages
        let isStreaming = false;
        let requestMessages = null;
        try {
            if (options?.body) {
                const body = JSON.parse(options.body);
                isStreaming = body.stream === true;
                // SillyTavern may nest messages in different places
                requestMessages = body.messages || body.prompt?.messages || null;
                log('Request body keys:', Object.keys(body));
                log('Request streaming:', isStreaming, 'Messages:', requestMessages?.length || 0);
                if (requestMessages && requestMessages.length > 0) {
                    log('First message role:', requestMessages[0]?.role);
                    log('Last message role:', requestMessages[requestMessages.length - 1]?.role);
                }
            }
        } catch (e) {
            log('Could not parse request body:', e.message);
        }

        currentRequest.active = true;
        currentRequest.startTime = Date.now();
        currentRequest.usage = null;
        currentRequest.messages = requestMessages;

        const response = await originalFetch.apply(this, args);

        log('Response status:', response.status);

        if (!isStreaming) {
            // Non-streaming: clone and read response
            try {
                const cloned = response.clone();
                const data = await cloned.json();
                log('Non-streaming response:', data);

                // Check if this is an OpenRouter response (has generation id starting with "gen-")
                const isOpenRouter = data.id && data.id.startsWith('gen-');
                let cacheRead = data.usage?.cache_read_input_tokens || 0;
                let cacheWrite = data.usage?.cache_creation_input_tokens || 0;

                // If OpenRouter and no cache data in response, fetch from their API
                if (isOpenRouter && cacheRead === 0 && cacheWrite === 0 && /claude/i.test(data.model)) {
                    log('Fetching OpenRouter generation stats for:', data.id);
                    const genStats = await fetchOpenRouterGenerationStats(data.id);
                    if (genStats) {
                        // OpenRouter returns native_tokens_cached for cache reads
                        // We need to estimate cache writes from usage_cache cost
                        cacheRead = genStats.native_tokens_cached || 0;
                        // If usage_cache > 0 but native_tokens_cached is 0, it's a cache write
                        // Cache write cost is 25% more, so tokens ~= usage_cache / (input_price * 1.25)
                        // For simplicity, we'll estimate based on prompt tokens if there's cache activity
                        if (genStats.usage_cache > 0 && cacheRead === 0) {
                            // This was a cache write - estimate tokens written
                            // We'll use native_tokens_prompt as an approximation
                            cacheWrite = genStats.native_tokens_prompt || 0;
                        }
                        log('OpenRouter cache stats - read:', cacheRead, 'write:', cacheWrite);
                    }
                }

                if (data.usage) {
                    processUsageData({
                        model: data.model || '',
                        input_tokens: data.usage.prompt_tokens || data.usage.input_tokens || 0,
                        output_tokens: data.usage.completion_tokens || data.usage.output_tokens || 0,
                        cache_read_input_tokens: cacheRead,
                        cache_creation_input_tokens: cacheWrite,
                    });
                }
            } catch (e) {
                log('Could not parse non-streaming response:', e);
            }
            return response;
        }

        // Streaming: intercept the readable stream
        const originalBody = response.body;
        if (!originalBody) {
            log('No response body');
            return response;
        }

        const reader = originalBody.getReader();
        const decoder = new TextDecoder();
        let sseBuffer = '';
        let usageFound = false;

        const interceptedStream = new ReadableStream({
            async start(controller) {
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) {
                            log('Stream complete. Usage found:', usageFound);
                            controller.close();
                            currentRequest.active = false;
                            break;
                        }

                        // Pass through original data
                        controller.enqueue(value);

                        // Parse for usage data
                        const chunk = decoder.decode(value, { stream: true });
                        sseBuffer += chunk;

                        // Parse SSE events
                        const events = sseBuffer.split(/\n\n/);
                        sseBuffer = events.pop() || '';

                        for (const event of events) {
                            const lines = event.split('\n');
                            for (const line of lines) {
                                if (line.startsWith('data: ')) {
                                    const eventData = line.slice(6).trim();
                                    if (eventData && eventData !== '[DONE]') {
                                        const usage = parseUsageFromEvent(eventData);
                                        if (usage && usage.input_tokens > 0) {
                                            usageFound = true;
                                            processUsageData(usage);
                                        }
                                    }
                                }
                            }
                        }
                    }
                } catch (error) {
                    log('Stream error:', error);
                    controller.error(error);
                    currentRequest.active = false;
                }
            },
            cancel() {
                reader.cancel();
                currentRequest.active = false;
            },
        });

        return new Response(interceptedStream, {
            headers: response.headers,
            status: response.status,
            statusText: response.statusText,
        });
    };

    log('Fetch interceptor installed');
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

    const totalWithCache = sessionStats.cacheHits + sessionStats.cacheMisses;
    const hitRate = totalWithCache > 0
        ? Math.round((sessionStats.cacheHits / totalWithCache) * 100)
        : 0;

    const cacheReadTokens = sessionStats.totalCacheReadTokens;
    const cacheWriteTokens = sessionStats.totalCacheWriteTokens;
    const savingsTokens = Math.round(cacheReadTokens * 0.9 - cacheWriteTokens * 0.25);

    document.getElementById('cache_total_requests').textContent = sessionStats.totalRequests;
    document.getElementById('cache_hit_rate').textContent = totalWithCache > 0 ? `${hitRate}%` : '--';
    document.getElementById('cache_read_tokens').textContent = cacheReadTokens.toLocaleString();
    document.getElementById('cache_write_tokens').textContent = cacheWriteTokens.toLocaleString();
    document.getElementById('cache_savings').textContent = savingsTokens > 0 ? `+${savingsTokens.toLocaleString()}` : savingsTokens.toLocaleString();

    const hitRateEl = document.getElementById('cache_hit_rate');
    hitRateEl.className = 'cache_stat_value';
    if (hitRate >= 70) hitRateEl.classList.add('good');
    else if (hitRate >= 40) hitRateEl.classList.add('neutral');
    else if (totalWithCache > 0) hitRateEl.classList.add('bad');

    const savingsEl = document.getElementById('cache_savings');
    savingsEl.className = 'cache_stat_value';
    if (savingsTokens > 0) savingsEl.classList.add('good');
    else if (savingsTokens < 0) savingsEl.classList.add('bad');

    document.getElementById('cache_efficiency_fill').style.width = `${hitRate}%`;

    const recEl = document.getElementById('cache_recommendation');
    if (!detectedClaudeUsage && sessionStats.totalRequests === 0) {
        recEl.textContent = 'Waiting for Claude requests...';
        recEl.style.color = '';
    } else if (sessionStats.consecutiveMisses >= settings.wasteThreshold) {
        recEl.textContent = `Warning: ${sessionStats.consecutiveMisses} consecutive misses`;
        recEl.style.color = '#f87171';
    } else if (hitRate >= 70 && totalWithCache > 2) {
        recEl.textContent = 'Excellent cache efficiency';
        recEl.style.color = '#4ade80';
    } else if (totalWithCache < 2) {
        recEl.textContent = 'Gathering data...';
        recEl.style.color = '';
    } else if (cacheWriteTokens > 0 && cacheReadTokens === 0) {
        recEl.textContent = 'Only cache writes - no hits yet';
        recEl.style.color = '#fbbf24';
    } else {
        recEl.textContent = 'Low efficiency - check prompt stability';
        recEl.style.color = '#fbbf24';
    }

    if (sessionStats.lastUsage) {
        const u = sessionStats.lastUsage;
        document.getElementById('cache_last_usage').textContent =
            `In: ${u.input_tokens} | Read: ${u.cache_read_input_tokens} | Write: ${u.cache_creation_input_tokens}`;
    }
}

/**
 * Create the monitoring panel
 */
function createPanel() {
    const existingPanel = document.getElementById('cache_monitor_panel');
    if (existingPanel) existingPanel.remove();

    const settings = extension_settings[extensionName];
    const panel = document.createElement('div');
    panel.id = 'cache_monitor_panel';
    if (settings?.panelCollapsed) panel.classList.add('collapsed');

    panel.innerHTML = `
        <div id="cache_monitor_header">
            <span id="cache_monitor_title">Cache Monitor</span>
            <span id="cache_monitor_toggle">${settings?.panelCollapsed ? '+' : '-'}</span>
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
            <div id="cache_recommendation">Waiting for requests...</div>
            <div class="cache_btn_row">
                <button id="cache_show_history" class="cache_action_btn">View History</button>
                <button id="cache_reset_stats" class="cache_action_btn">Reset</button>
            </div>
        </div>
    `;

    document.body.appendChild(panel);

    document.getElementById('cache_monitor_header').addEventListener('click', () => {
        panel.classList.toggle('collapsed');
        document.getElementById('cache_monitor_toggle').textContent = panel.classList.contains('collapsed') ? '+' : '-';
        extension_settings[extensionName].panelCollapsed = panel.classList.contains('collapsed');
        saveSettingsDebounced();
    });

    document.getElementById('cache_show_history').addEventListener('click', () => {
        showHistoryModal();
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
        detectedClaudeUsage = false;
        updatePanel();
        toastr.info('Cache stats reset');
    });

    updatePanel();
}

/**
 * Initialize settings
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
 * Add settings UI
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
                    <label class="checkbox_label">
                        <input type="checkbox" id="cache_monitor_show_panel" />
                        <span>Show Floating Panel</span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="cache_monitor_auto_warn" />
                        <span>Warn on Cache Waste</span>
                    </label>
                    <div>
                        <label>Waste Threshold:</label>
                        <input type="number" id="cache_monitor_waste_threshold" min="1" max="10" value="3" style="width: 50px" />
                        <small>misses</small>
                    </div>
                    <hr>
                    <div>
                        <label for="cache_monitor_openrouter_key">OpenRouter API Key:</label>
                        <input type="password" id="cache_monitor_openrouter_key" class="text_pole" placeholder="sk-or-..." style="width: 100%; margin-top: 5px;" />
                        <small style="opacity: 0.7;">Required to fetch cache stats from OpenRouter</small>
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
    $('#cache_monitor_openrouter_key').val(settings.openrouterApiKey || '').on('change', function () {
        settings.openrouterApiKey = this.value.trim();
        saveSettingsDebounced();
        if (this.value) {
            toastr.success('OpenRouter API key saved');
        }
    });
}

// Initialize
jQuery(async () => {
    log('Initializing...');
    loadSettings();
    await addSettingsUI();
    createPanel();
    setupFetchInterceptor();
    log('Extension loaded! Open browser console to see debug output.');
});
