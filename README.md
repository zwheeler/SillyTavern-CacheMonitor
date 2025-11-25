# SillyTavern Cache Monitor

A SillyTavern extension that monitors Claude API prompt caching performance in real-time.

## Features

- **Real-time cache monitoring** - Shows actual `cache_read_input_tokens` and `cache_creation_input_tokens` from Claude API responses
- **Hit rate tracking** - See what percentage of your requests benefit from caching
- **Cost savings calculation** - Estimates token savings (cache reads are 90% cheaper, writes cost 25% more)
- **Consecutive miss warnings** - Alerts you when cache is being wasted due to prompt instability
- **Per-message stats** - Saves cache data to each message's metadata for later analysis

## Installation

### Method 1: Via SillyTavern UI
1. Open SillyTavern
2. Go to Extensions (puzzle piece icon)
3. Click "Install Extension"
4. Paste: `https://github.com/zwheeler/SillyTavern-CacheMonitor`
5. Click Install

### Method 2: Manual
```bash
cd SillyTavern/data/<user>/extensions/
git clone https://github.com/zwheeler/SillyTavern-CacheMonitor
```

## Usage

Once installed, a floating panel appears in the bottom-right showing:

| Stat | Description |
|------|-------------|
| **Requests** | Total Claude API requests this session |
| **Hit Rate** | Percentage of requests with cache reads |
| **Cache Read** | Total tokens read from cache (90% cheaper) |
| **Cache Write** | Total tokens written to cache (25% more expensive) |
| **Net Savings** | Estimated token cost savings |

## How It Works

The extension intercepts `fetch()` requests to capture Claude's SSE streaming responses. When Claude returns a `message_delta` event containing usage data, we extract:

- `cache_read_input_tokens` - Tokens served from cache
- `cache_creation_input_tokens` - Tokens written to cache

This data is then:
1. Displayed in the monitoring panel
2. Saved to each chat message's `extra` field for persistence

## Claude Prompt Caching Basics

- **Minimum tokens**: 1,024 for Sonnet/Opus, 2,048 for Haiku
- **Cache TTL**: 5 minutes (refreshed on each hit)
- **Cache reads**: 90% cheaper than regular input
- **Cache writes**: 25% more expensive than regular input
- **Exact prefix matching**: Cache only works if messages are identical from the start

## Settings

In Extensions > Cache Monitor:

- **Show Floating Panel** - Toggle the stats panel visibility
- **Warn on Cache Waste** - Show alerts on consecutive cache misses
- **Waste Threshold** - Number of misses before warning (default: 3)

## Troubleshooting

**No data showing?**
- Make sure you're using a Claude model (direct or via OpenRouter)
- Streaming must be enabled
- Make a few requests - first request always writes cache

**Always showing cache writes, no reads?**
- Your prompts may be changing between requests
- Check for dynamic content in system prompt (random macros, etc.)
- Cache expires after 5 minutes of inactivity

## License

MIT
