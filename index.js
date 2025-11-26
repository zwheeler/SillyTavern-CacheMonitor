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

// Persistent daily statistics (stored in localStorage)
const DAILY_STATS_KEY = 'cache_monitor_daily_stats';

/**
 * Get today's date string in local time (YYYY-MM-DD)
 */
function getTodayKey() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * Load daily stats from localStorage
 */
function loadDailyStats() {
    try {
        const stored = localStorage.getItem(DAILY_STATS_KEY);
        return stored ? JSON.parse(stored) : {};
    } catch (e) {
        log('Error loading daily stats:', e);
        return {};
    }
}

/**
 * Save daily stats to localStorage
 */
function saveDailyStats(stats) {
    try {
        localStorage.setItem(DAILY_STATS_KEY, JSON.stringify(stats));
    } catch (e) {
        log('Error saving daily stats:', e);
    }
}

/**
 * Get or create today's stats entry
 */
function getTodayStats() {
    const allStats = loadDailyStats();
    const today = getTodayKey();
    if (!allStats[today]) {
        allStats[today] = {
            date: today,
            requests: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalCost: 0,
            savings: 0,
        };
        saveDailyStats(allStats);
    }
    return allStats[today];
}

/**
 * Update today's stats with a new request
 */
function updateDailyStats(usage, costs) {
    const allStats = loadDailyStats();
    const today = getTodayKey();

    if (!allStats[today]) {
        allStats[today] = {
            date: today,
            requests: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalCost: 0,
            savings: 0,
        };
    }

    allStats[today].requests++;
    allStats[today].inputTokens += usage.input_tokens || 0;
    allStats[today].outputTokens += usage.output_tokens || 0;
    allStats[today].cacheReadTokens += usage.cache_read_input_tokens || 0;
    allStats[today].cacheWriteTokens += usage.cache_creation_input_tokens || 0;
    allStats[today].totalCost += costs?.totalCost || 0;
    allStats[today].savings += costs?.savings || 0;

    saveDailyStats(allStats);
    return allStats[today];
}

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
    return messages.map((msg, idx) => {
        const fullContent = typeof msg.content === 'string'
            ? msg.content
            : JSON.stringify(msg.content);
        return {
            index: idx,
            role: msg.role,
            contentPreview: fullContent.substring(0, 100),
            fullContent: fullContent, // Store full content for diff
            hash: hashString(JSON.stringify(msg)),
            hasCacheControl: !!msg.cache_control,
        };
    });
}

/**
 * Find the first difference between two strings and return context around it
 */
function findStringDiff(str1, str2, contextChars = 200) {
    if (!str1 || !str2) return { diffIndex: 0, context1: str1?.substring(0, 500) || '', context2: str2?.substring(0, 500) || '' };

    // Find first differing character
    let diffIndex = 0;
    const minLen = Math.min(str1.length, str2.length);
    while (diffIndex < minLen && str1[diffIndex] === str2[diffIndex]) {
        diffIndex++;
    }

    // Get context around the diff point
    const start = Math.max(0, diffIndex - contextChars);
    const end1 = Math.min(str1.length, diffIndex + contextChars);
    const end2 = Math.min(str2.length, diffIndex + contextChars);

    const context1 = (start > 0 ? '...' : '') + str1.substring(start, end1) + (end1 < str1.length ? '...' : '');
    const context2 = (start > 0 ? '...' : '') + str2.substring(start, end2) + (end2 < str2.length ? '...' : '');

    // Mark the diff position in context
    const markerPos = diffIndex - start + (start > 0 ? 3 : 0);

    return {
        diffIndex,
        markerPos,
        context1,
        context2,
        lengthDiff: str1.length !== str2.length ? `Length: ${str1.length} → ${str2.length}` : null,
    };
}

/**
 * Find where messages diverge between two requests
 */
function findDivergencePoint(prevHashes, currHashes) {
    if (!prevHashes || !currHashes) return { divergeIndex: 0, reason: 'No previous data' };

    const minLen = Math.min(prevHashes.length, currHashes.length);

    for (let i = 0; i < minLen; i++) {
        if (prevHashes[i].hash !== currHashes[i].hash) {
            // Find exactly where in the content the difference is
            const diff = findStringDiff(prevHashes[i].fullContent, currHashes[i].fullContent);
            return {
                divergeIndex: i,
                reason: `Message ${i} (${currHashes[i].role}) changed at char ${diff.diffIndex}`,
                prevContent: prevHashes[i].fullContent,
                currContent: currHashes[i].fullContent,
                diff: diff,
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
 * Detect patterns in content that suggest specific issues
 */
function detectContentPatterns(content) {
    const patterns = {
        hasLoreEntries: false,
        loreEntryNames: [],
        hasDepthMarkers: false,
        depthValues: [],
        hasSystemPrompt: false,
        hasChatHistory: false,
        hasCharacterCard: false,
        hasPersona: false,
    };

    if (!content) return patterns;

    // Detect lorebook entries (common SillyTavern format)
    const loreEntryRegex = /<lore_entry\s+([^>]+)>/gi;
    let match;
    while ((match = loreEntryRegex.exec(content)) !== null) {
        patterns.hasLoreEntries = true;
        patterns.loreEntryNames.push(match[1].trim());
    }

    // Alternative lorebook formats
    const altLoreRegex = /\[Lore:\s*([^\]]+)\]/gi;
    while ((match = altLoreRegex.exec(content)) !== null) {
        patterns.hasLoreEntries = true;
        patterns.loreEntryNames.push(match[1].trim());
    }

    // Detect depth markers
    const depthRegex = /depth[:\s=]+(\d+)/gi;
    while ((match = depthRegex.exec(content)) !== null) {
        patterns.hasDepthMarkers = true;
        patterns.depthValues.push(parseInt(match[1]));
    }

    // Detect common prompt components
    if (/system\s*prompt|you are|your role is/i.test(content)) {
        patterns.hasSystemPrompt = true;
    }
    if (/\[character\]|\{\{char\}\}|<character>|character card/i.test(content)) {
        patterns.hasCharacterCard = true;
    }
    if (/\[user\]|\{\{user\}\}|<user>|persona/i.test(content)) {
        patterns.hasPersona = true;
    }
    if (/\[assistant\]|\[human\]|<msg>|<message>/i.test(content)) {
        patterns.hasChatHistory = true;
    }

    return patterns;
}

/**
 * Compare two arrays of lorebook entries to detect ordering issues
 */
function detectLoreOrderingIssues(prevEntries, currEntries) {
    if (!prevEntries || !currEntries || prevEntries.length === 0 || currEntries.length === 0) {
        return null;
    }

    // Check if same entries but different order
    const prevSet = new Set(prevEntries);
    const currSet = new Set(currEntries);

    const sameEntries = prevEntries.length === currEntries.length &&
        prevEntries.every(e => currSet.has(e));

    if (sameEntries) {
        // Same entries, check order
        for (let i = 0; i < prevEntries.length; i++) {
            if (prevEntries[i] !== currEntries[i]) {
                return {
                    type: 'reordering',
                    message: `Lorebook entries reordered (${prevEntries[i]} ↔ ${currEntries[i]})`,
                    recommendation: 'Fix lorebook entry ordering: Set unique "Order" values for each entry to ensure deterministic sorting.',
                    details: {
                        prevOrder: prevEntries.slice(0, 5),
                        currOrder: currEntries.slice(0, 5),
                    },
                };
            }
        }
    } else {
        // Different entries triggered
        const added = currEntries.filter(e => !prevSet.has(e));
        const removed = prevEntries.filter(e => !currSet.has(e));

        if (added.length > 0 || removed.length > 0) {
            return {
                type: 'different_entries',
                message: `Different lorebook entries triggered`,
                recommendation: 'If entries change due to keywords, this is expected. For stable caching, set frequently-used entries to "Constant" mode.',
                details: {
                    added,
                    removed,
                },
            };
        }
    }

    return null;
}

/**
 * Analyze divergence location to determine likely cause
 */
function analyzeDivergenceLocation(divergeIndex, totalMessages, prevContent, currContent, prevPatterns, currPatterns) {
    const analysis = {
        location: 'unknown',
        likelyCause: null,
        recommendation: null,
        severity: 'medium', // low, medium, high
    };

    const positionRatio = divergeIndex / totalMessages;

    // Early divergence (first 20% of messages) - likely system prompt or lorebook
    if (positionRatio < 0.2 || divergeIndex < 3) {
        analysis.location = 'early';

        // Check for lorebook content
        if (prevPatterns?.hasLoreEntries || currPatterns?.hasLoreEntries) {
            const loreIssue = detectLoreOrderingIssues(
                prevPatterns?.loreEntryNames || [],
                currPatterns?.loreEntryNames || []
            );
            if (loreIssue) {
                analysis.likelyCause = loreIssue.type === 'reordering' ? 'lorebook_ordering' : 'lorebook_keywords';
                analysis.recommendation = loreIssue.recommendation;
                analysis.details = loreIssue.details;
                analysis.severity = loreIssue.type === 'reordering' ? 'high' : 'medium';
                return analysis;
            }
        }

        // Check for depth-related issues
        if (prevPatterns?.hasDepthMarkers || currPatterns?.hasDepthMarkers) {
            analysis.likelyCause = 'depth_configuration';
            analysis.recommendation = 'Check preset depth settings. Entries with depth > 0 are inserted relative to chat history, causing instability. Set constant entries to depth 0.';
            analysis.severity = 'high';
            return analysis;
        }

        // Generic early divergence
        analysis.likelyCause = 'system_prompt_change';
        analysis.recommendation = 'Early prompt content changed. Check: system prompt, character card, or author\'s notes injected at top.';
        analysis.severity = 'medium';
    }
    // Middle divergence (20-80%) - likely injected content or author's notes
    else if (positionRatio < 0.8) {
        analysis.location = 'middle';

        if (prevPatterns?.hasLoreEntries || currPatterns?.hasLoreEntries) {
            analysis.likelyCause = 'lorebook_depth_injection';
            analysis.recommendation = 'Lorebook entries injected at non-zero depth cause instability. Set all constant entries to depth 0 for better caching.';
            analysis.severity = 'high';
        } else {
            analysis.likelyCause = 'injected_content';
            analysis.recommendation = 'Content injected mid-prompt (author\'s notes, world info, etc.). Check depth settings in your preset.';
            analysis.severity = 'medium';
        }
    }
    // Late divergence (last 20%) - likely chat history or user input
    else {
        analysis.location = 'late';
        analysis.likelyCause = 'chat_history';
        analysis.recommendation = 'Change is in recent chat history - this is expected behavior.';
        analysis.severity = 'low';
    }

    return analysis;
}

/**
 * Generate smart recommendations based on analysis
 */
function generateSmartRecommendations(analysis) {
    const recommendations = [];

    // Priority 1: Specific diagnosed issues
    if (analysis.locationAnalysis?.recommendation) {
        recommendations.push({
            priority: 1,
            type: analysis.locationAnalysis.likelyCause,
            message: analysis.locationAnalysis.recommendation,
            severity: analysis.locationAnalysis.severity,
        });
    }

    // Priority 2: TTL warnings
    if (analysis.ttlWarning) {
        recommendations.push({
            priority: 2,
            type: 'ttl_expired',
            message: 'Cache expired due to 5-minute TTL. Send messages more frequently to maintain cache.',
            severity: 'medium',
        });
    }

    // Priority 3: Lorebook-specific issues
    if (analysis.loreIssue) {
        recommendations.push({
            priority: 1,
            type: analysis.loreIssue.type,
            message: analysis.loreIssue.message,
            severity: analysis.loreIssue.type === 'reordering' ? 'high' : 'medium',
            actionable: analysis.loreIssue.recommendation,
        });
    }

    // Sort by priority
    recommendations.sort((a, b) => a.priority - b.priority);

    return recommendations;
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
        locationAnalysis: null,
        loreIssue: null,
        recommendations: [],
        primaryDiagnosis: null,
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

            // Analyze the divergent content for patterns
            const prevContent = divergence.prevContent || '';
            const currContent = divergence.currContent || '';
            const prevPatterns = detectContentPatterns(prevContent);
            const currPatterns = detectContentPatterns(currContent);

            // Store patterns for detailed analysis
            analysis.prevPatterns = prevPatterns;
            analysis.currPatterns = currPatterns;

            // Check for lorebook ordering issues specifically
            if (prevPatterns.hasLoreEntries || currPatterns.hasLoreEntries) {
                analysis.loreIssue = detectLoreOrderingIssues(
                    prevPatterns.loreEntryNames,
                    currPatterns.loreEntryNames
                );
            }

            // Analyze divergence location
            analysis.locationAnalysis = analyzeDivergenceLocation(
                divergence.divergeIndex,
                currentHashes.length,
                prevContent,
                currContent,
                prevPatterns,
                currPatterns
            );

            // Set primary diagnosis based on analysis
            if (analysis.loreIssue?.type === 'reordering') {
                analysis.primaryDiagnosis = {
                    issue: 'Lorebook Ordering Issue',
                    icon: '📚',
                    color: '#f87171',
                    shortMessage: 'Lorebook entries are reordering between requests',
                    action: 'Set unique Order values for each lorebook entry',
                };
            } else if (analysis.loreIssue?.type === 'different_entries') {
                analysis.primaryDiagnosis = {
                    issue: 'Different Lorebook Entries',
                    icon: '📖',
                    color: '#fbbf24',
                    shortMessage: 'Different lorebook entries triggered by keywords',
                    action: 'Set frequently-used entries to Constant mode',
                };
            } else if (analysis.locationAnalysis?.likelyCause === 'depth_configuration') {
                analysis.primaryDiagnosis = {
                    issue: 'Depth Configuration Issue',
                    icon: '⬇️',
                    color: '#f87171',
                    shortMessage: 'Content at non-zero depth causing instability',
                    action: 'Set constant entries to depth 0 in lorebook settings',
                };
            } else if (analysis.locationAnalysis?.likelyCause === 'lorebook_depth_injection') {
                analysis.primaryDiagnosis = {
                    issue: 'Lorebook Depth Issue',
                    icon: '📍',
                    color: '#f87171',
                    shortMessage: 'Lorebook injected mid-prompt at non-zero depth',
                    action: 'Set lorebook entries to depth 0 and position "@ Depth"',
                };
            } else if (analysis.locationAnalysis?.location === 'late') {
                analysis.primaryDiagnosis = {
                    issue: 'Chat History Change',
                    icon: '💬',
                    color: '#4ade80',
                    shortMessage: 'Normal - new messages added to history',
                    action: null, // No action needed
                };
            } else if (analysis.locationAnalysis?.location === 'early') {
                analysis.primaryDiagnosis = {
                    issue: 'Early Prompt Instability',
                    icon: '⚠️',
                    color: '#fbbf24',
                    shortMessage: 'System prompt or early content changed',
                    action: 'Check character card, system prompt, and author\'s notes',
                };
            }
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

    // Generate smart recommendations
    analysis.recommendations = generateSmartRecommendations(analysis);

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

    // Update persistent daily stats
    updateDailyStats(usage, costs);

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
 * Calculate costs for a request based on Claude pricing (Nov 2025)
 * https://claude.com/pricing#api
 */
function calculateCosts(usage) {
    const model = usage.model || '';

    // Default to Sonnet 4.5 pricing, adjust for other models
    let inputPrice = 3.0;       // per 1M tokens
    let outputPrice = 15.0;
    let cacheWritePrice = 3.75; // 25% more than input
    let cacheReadPrice = 0.30;  // 90% less than input

    // Opus 4.5 pricing
    if (/opus-4-5|opus-4\.5/i.test(model)) {
        inputPrice = 5.0;
        outputPrice = 25.0;
        cacheWritePrice = 6.25;
        cacheReadPrice = 0.50;
    }
    // Opus 4.1 (legacy) pricing
    else if (/opus-4-1|opus-4\.1/i.test(model)) {
        inputPrice = 15.0;
        outputPrice = 75.0;
        cacheWritePrice = 18.75;
        cacheReadPrice = 1.50;
    }
    // Generic opus fallback (assume 4.5)
    else if (/opus/i.test(model)) {
        inputPrice = 5.0;
        outputPrice = 25.0;
        cacheWritePrice = 6.25;
        cacheReadPrice = 0.50;
    }
    // Haiku 4.5 pricing
    else if (/haiku-4-5|haiku-4\.5/i.test(model)) {
        inputPrice = 1.0;
        outputPrice = 5.0;
        cacheWritePrice = 1.25;
        cacheReadPrice = 0.10;
    }
    // Haiku 3.5 (legacy) pricing
    else if (/haiku/i.test(model)) {
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
 * Format a date key as a readable date
 */
function formatDateKey(dateKey) {
    const [year, month, day] = dateKey.split('-');
    const date = new Date(year, month - 1, day);
    return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * Show the history modal
 */
function showHistoryModal() {
    // Remove existing modal
    const existing = document.getElementById('cache_history_modal');
    if (existing) existing.remove();

    // Get daily stats
    const allDailyStats = loadDailyStats();
    const today = getTodayKey();
    const todayStats = allDailyStats[today] || { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0, savings: 0 };

    // Get sorted days (most recent first)
    const sortedDays = Object.keys(allDailyStats).sort().reverse();

    // Build daily stats HTML
    let dailyStatsHtml = '';
    if (sortedDays.length > 0) {
        dailyStatsHtml = `
            <div class="daily_stats_section">
                <h4>Daily Statistics</h4>
                <div class="daily_stats_grid">
                    ${sortedDays.slice(0, 7).map(day => {
                        const s = allDailyStats[day];
                        const isToday = day === today;
                        return `
                            <div class="daily_stat_card ${isToday ? 'today' : ''}">
                                <div class="daily_stat_date">${isToday ? 'Today' : formatDateKey(day)}</div>
                                <div class="daily_stat_row"><span>Requests:</span> <b>${s.requests}</b></div>
                                <div class="daily_stat_row"><span>Input:</span> <b>${(s.inputTokens || 0).toLocaleString()}</b></div>
                                <div class="daily_stat_row"><span>Output:</span> <b>${(s.outputTokens || 0).toLocaleString()}</b></div>
                                <div class="daily_stat_row"><span>Cache Read:</span> <b class="good">${(s.cacheReadTokens || 0).toLocaleString()}</b></div>
                                <div class="daily_stat_row"><span>Cache Write:</span> <b class="neutral">${(s.cacheWriteTokens || 0).toLocaleString()}</b></div>
                                <div class="daily_stat_row"><span>Cost:</span> <b>${formatCost(s.totalCost || 0)}</b></div>
                                <div class="daily_stat_row"><span>Savings:</span> <b class="good">${formatCost(s.savings || 0)}</b></div>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `;
    }

    const modal = document.createElement('div');
    modal.id = 'cache_history_modal';
    modal.innerHTML = `
        <div class="cache_modal_backdrop"></div>
        <div class="cache_modal_content">
            <div class="cache_modal_header">
                <h3>Cache Monitor History</h3>
                <button class="cache_modal_close">&times;</button>
            </div>
            <div class="cache_modal_body">
                ${dailyStatsHtml}
                <div class="session_history_section">
                    <h4>Session Requests</h4>
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
                    ${sessionStats.requestHistory.length === 0 ? '<p style="text-align: center; opacity: 0.7; margin-top: 20px;">No requests recorded this session</p>' : ''}
                </div>
            </div>
            <div class="cache_modal_footer">
                <div class="cache_modal_summary">
                    <span>Session Requests: <b>${sessionStats.totalRequests}</b></span>
                    <span>Session Cost: <b>${formatCost(sessionStats.requestHistory.reduce((sum, r) => sum + (r.costs?.totalCost || 0), 0))}</b></span>
                    <span>Session Savings: <b class="good">${formatCost(sessionStats.requestHistory.reduce((sum, r) => sum + (r.costs?.savings || 0), 0))}</b></span>
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
        // Show primary diagnosis prominently if available
        if (a.primaryDiagnosis) {
            const pd = a.primaryDiagnosis;
            detailHtml += `
                <div class="analysis_section ${pd.action ? 'warning' : 'success'}" style="border-left-color: ${pd.color}">
                    <h4>${pd.icon} ${pd.issue}</h4>
                    <p>${pd.shortMessage}</p>
                    ${pd.action ? `<p style="margin-top: 10px;"><strong>Recommended Action:</strong> ${pd.action}</p>` : ''}
                </div>
            `;
        }

        detailHtml += `
            <div class="analysis_section warning">
                <h4>⚠ Cache Miss Details</h4>
                <ul class="analysis_reasons">
                    ${a.reasons.map(r => `<li>${r}</li>`).join('')}
                </ul>
            </div>
        `;

        if (a.divergence && a.divergence.divergeIndex >= 0) {
            const d = a.divergence;
            const diff = d.diff;
            detailHtml += `
                <div class="analysis_section">
                    <h4>Divergence Point</h4>
                    <p>Message <b>${d.divergeIndex}</b> (${d.role || 'unknown'}) changed at character <b>${diff?.diffIndex || 0}</b></p>
                    ${diff?.lengthDiff ? `<p class="diff_length">${diff.lengthDiff}</p>` : ''}
                    ${diff ? `
                        <div class="diff_container">
                            <div class="diff_box prev">
                                <div class="diff_label">Previous content around change:</div>
                                <div class="diff_content"><span class="diff_match">${escapeHtml(diff.context1.substring(0, diff.markerPos))}</span><span class="diff_changed">${escapeHtml(diff.context1.substring(diff.markerPos))}</span></div>
                            </div>
                            <div class="diff_box curr">
                                <div class="diff_label">Current content around change:</div>
                                <div class="diff_content"><span class="diff_match">${escapeHtml(diff.context2.substring(0, diff.markerPos))}</span><span class="diff_changed">${escapeHtml(diff.context2.substring(diff.markerPos))}</span></div>
                            </div>
                        </div>
                    ` : ''}
                </div>
            `;
        }

        // Show lorebook-specific analysis if detected
        if (a.loreIssue) {
            const lore = a.loreIssue;
            detailHtml += `
                <div class="analysis_section" style="border-left: 3px solid ${lore.type === 'reordering' ? '#f87171' : '#fbbf24'}">
                    <h4>📚 Lorebook Analysis</h4>
                    <p><strong>Issue:</strong> ${lore.message}</p>
                    <p><strong>Fix:</strong> ${lore.recommendation}</p>
                    ${lore.details ? `
                        <div style="margin-top: 10px; font-size: 12px;">
                            ${lore.details.prevOrder ? `<p><span style="color: #f87171;">Previous order:</span> ${lore.details.prevOrder.join(' → ')}</p>` : ''}
                            ${lore.details.currOrder ? `<p><span style="color: #4ade80;">Current order:</span> ${lore.details.currOrder.join(' → ')}</p>` : ''}
                            ${lore.details.added?.length > 0 ? `<p><span style="color: #4ade80;">Added:</span> ${lore.details.added.join(', ')}</p>` : ''}
                            ${lore.details.removed?.length > 0 ? `<p><span style="color: #f87171;">Removed:</span> ${lore.details.removed.join(', ')}</p>` : ''}
                        </div>
                    ` : ''}
                </div>
            `;
        }

        // Show location analysis
        if (a.locationAnalysis) {
            const loc = a.locationAnalysis;
            const locColors = { early: '#f87171', middle: '#fbbf24', late: '#4ade80' };
            detailHtml += `
                <div class="analysis_section">
                    <h4>📍 Divergence Location</h4>
                    <p>Location: <span style="color: ${locColors[loc.location] || '#ccc'}">${loc.location.toUpperCase()}</span> in prompt</p>
                    <p>Likely cause: ${loc.likelyCause?.replace(/_/g, ' ') || 'Unknown'}</p>
                    <p>Severity: <span class="${loc.severity}">${loc.severity.toUpperCase()}</span></p>
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

    const cacheReadTokens = sessionStats.totalCacheReadTokens;
    const cacheWriteTokens = sessionStats.totalCacheWriteTokens;
    const reportedInputTokens = sessionStats.totalInputTokens;

    // Total input = max of reported input_tokens OR (cache_read + cache_write)
    // This handles cases where input_tokens is incorrectly reported (e.g., streaming)
    const totalInputTokens = Math.max(reportedInputTokens, cacheReadTokens + cacheWriteTokens);

    // Token-based hit rate: what % of input tokens came from cache
    const hitRate = totalInputTokens > 0
        ? Math.round((cacheReadTokens / totalInputTokens) * 100)
        : 0;

    const savingsTokens = Math.round(cacheReadTokens * 0.9 - cacheWriteTokens * 0.25);

    document.getElementById('cache_total_requests').textContent = sessionStats.totalRequests;
    document.getElementById('cache_hit_rate').textContent = totalInputTokens > 0 ? `${hitRate}%` : '--';
    document.getElementById('cache_read_tokens').textContent = cacheReadTokens.toLocaleString();
    document.getElementById('cache_write_tokens').textContent = cacheWriteTokens.toLocaleString();
    document.getElementById('cache_savings').textContent = savingsTokens > 0 ? `+${savingsTokens.toLocaleString()}` : savingsTokens.toLocaleString();

    const hitRateEl = document.getElementById('cache_hit_rate');
    hitRateEl.className = 'cache_stat_value';
    if (hitRate >= 70) hitRateEl.classList.add('good');
    else if (hitRate >= 40) hitRateEl.classList.add('neutral');
    else if (totalInputTokens > 0) hitRateEl.classList.add('bad');

    const savingsEl = document.getElementById('cache_savings');
    savingsEl.className = 'cache_stat_value';
    if (savingsTokens > 0) savingsEl.classList.add('good');
    else if (savingsTokens < 0) savingsEl.classList.add('bad');

    document.getElementById('cache_efficiency_fill').style.width = `${hitRate}%`;

    const recEl = document.getElementById('cache_recommendation');
    // Check if last request had a good cache hit
    const lastHadGoodHit = sessionStats.lastUsage?.cache_read_input_tokens > 1000;
    const lastHadMiss = sessionStats.lastUsage &&
        sessionStats.lastUsage.cache_read_input_tokens === 0 &&
        sessionStats.lastUsage.cache_creation_input_tokens > 0;

    // Get the last request's analysis for smart recommendations
    const lastRequest = sessionStats.requestHistory[sessionStats.requestHistory.length - 1];
    const lastAnalysis = lastRequest?.analysis;
    const primaryDiagnosis = lastAnalysis?.primaryDiagnosis;

    if (!detectedClaudeUsage && sessionStats.totalRequests === 0) {
        recEl.textContent = 'Waiting for Claude requests...';
        recEl.style.color = '';
    } else if (sessionStats.consecutiveMisses >= settings.wasteThreshold) {
        // Show smart diagnosis if available for consecutive misses
        if (primaryDiagnosis && primaryDiagnosis.action) {
            recEl.innerHTML = `<span style="color: ${primaryDiagnosis.color}">${primaryDiagnosis.icon} ${primaryDiagnosis.issue}</span><br><small>${primaryDiagnosis.action}</small>`;
            recEl.style.color = '';
        } else {
            recEl.textContent = `Warning: ${sessionStats.consecutiveMisses} consecutive misses`;
            recEl.style.color = '#f87171';
        }
    } else if (lastHadGoodHit) {
        // Prioritize showing current request status
        const readTokens = sessionStats.lastUsage.cache_read_input_tokens.toLocaleString();
        recEl.textContent = `Cache hit! ${readTokens} tokens from cache`;
        recEl.style.color = '#4ade80';
    } else if (lastHadMiss && primaryDiagnosis) {
        // Show smart diagnosis for cache miss
        if (primaryDiagnosis.action) {
            recEl.innerHTML = `<span style="color: ${primaryDiagnosis.color}">${primaryDiagnosis.icon} ${primaryDiagnosis.shortMessage}</span>`;
        } else {
            recEl.innerHTML = `<span style="color: ${primaryDiagnosis.color}">${primaryDiagnosis.icon} ${primaryDiagnosis.shortMessage}</span>`;
        }
        recEl.style.color = '';
    } else if (lastHadMiss) {
        recEl.textContent = `Cache miss - new content written`;
        recEl.style.color = '#fbbf24';
    } else if (hitRate >= 70 && sessionStats.totalRequests > 2) {
        recEl.textContent = 'Excellent cache efficiency';
        recEl.style.color = '#4ade80';
    } else if (sessionStats.totalRequests < 2) {
        recEl.textContent = 'Gathering data...';
        recEl.style.color = '';
    } else if (cacheWriteTokens > 0 && cacheReadTokens === 0) {
        recEl.textContent = 'Only cache writes - no hits yet';
        recEl.style.color = '#fbbf24';
    } else {
        // Show token-based stats
        recEl.textContent = `${cacheReadTokens.toLocaleString()} tokens from cache (${hitRate}%)`;
        recEl.style.color = hitRate >= 40 ? '#fbbf24' : '#f87171';
    }

    if (sessionStats.lastUsage) {
        const u = sessionStats.lastUsage;
        document.getElementById('cache_last_usage').textContent =
            `In: ${u.input_tokens} | Read: ${u.cache_read_input_tokens} | Write: ${u.cache_creation_input_tokens}`;
    }

    // Update TTL timer
    updateTTLTimer();
}

/**
 * Update the TTL countdown timer
 */
function updateTTLTimer() {
    const ttlEl = document.getElementById('cache_ttl_timer');
    if (!ttlEl) return;

    if (!previousRequest.timestamp) {
        ttlEl.textContent = 'TTL: No cache yet';
        ttlEl.style.color = '';
        return;
    }

    const elapsed = Date.now() - previousRequest.timestamp;
    const remaining = Math.max(0, 300000 - elapsed); // 5 min = 300000ms
    const remainingSec = Math.floor(remaining / 1000);
    const min = Math.floor(remainingSec / 60);
    const sec = remainingSec % 60;

    if (remaining <= 0) {
        ttlEl.textContent = 'TTL: EXPIRED';
        ttlEl.style.color = '#f87171';
    } else if (remaining < 60000) {
        ttlEl.textContent = `TTL: ${sec}s`;
        ttlEl.style.color = '#f87171';
    } else if (remaining < 120000) {
        ttlEl.textContent = `TTL: ${min}:${sec.toString().padStart(2, '0')}`;
        ttlEl.style.color = '#fbbf24';
    } else {
        ttlEl.textContent = `TTL: ${min}:${sec.toString().padStart(2, '0')}`;
        ttlEl.style.color = '#4ade80';
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
            <div id="cache_ttl_timer" style="font-size: 11px; margin-top: 4px;">TTL: --</div>
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

    // Update TTL timer every second
    setInterval(updateTTLTimer, 1000);

    log('Extension loaded! Open browser console to see debug output.');
});
