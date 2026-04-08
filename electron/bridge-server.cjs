const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const { app } = require('electron');
const { TOOL_DEFINITIONS, executeTool } = require('./tools.cjs');

// No longer needed — SDK removed, using direct API calls
function enableNodeModeForChildProcesses() {
    console.log('[Engine] Direct API mode — no SDK subprocess needed');
}

// Load custom system prompt (only affects this Electron app, not external CLI usage)
const CUSTOM_SYSTEM_PROMPT_PATH = path.join(__dirname, 'system-prompt.txt');
let customSystemPromptFull = '';  // Full prompt including anti-Kiro sections (for Clawparrot)
let customSystemPromptClean = ''; // Without anti-Kiro sections (for self-hosted)
try {
    if (fs.existsSync(CUSTOM_SYSTEM_PROMPT_PATH)) {
        customSystemPromptFull = fs.readFileSync(CUSTOM_SYSTEM_PROMPT_PATH, 'utf8');
        // Strip <override_instructions> and <identity> blocks for self-hosted users
        customSystemPromptClean = customSystemPromptFull
            .replace(/<override_instructions>[\s\S]*?<\/override_instructions>\s*/g, '')
            .replace(/<identity>[\s\S]*?<\/identity>\s*/g, '');
        console.log(`[System Prompt] Loaded (full=${customSystemPromptFull.length}, clean=${customSystemPromptClean.length} chars)`);
    } else {
        console.warn('[System Prompt] Custom prompt file not found at:', CUSTOM_SYSTEM_PROMPT_PATH);
    }
} catch (e) {
    console.error('[System Prompt] Failed to load:', e.message);
}

function initServer(mainWindow) {
    const server = express();
    server.use(cors());
    server.use(express.json());

    // Track active engine child processes per conversation (for stdin writes like AskUserQuestion)
    const activeChildren = new Map();

    // Stash original AskUserQuestion input per conversation so /answer can merge user answers into updatedInput
    const askUserPendingInputs = new Map();

    // Per-conversation stream state: buffer events so frontend can reconnect mid-stream
    // Key: conversationId, Value: { events: [], listeners: Set<res>, done: boolean }
    const activeStreams = new Map();

    function broadcastSSE(conversationId, event) {
        const stream = activeStreams.get(conversationId);
        if (!stream) return;
        stream.events.push(event);
        const line = 'data: ' + JSON.stringify(event) + '\n\n';
        var arr = Array.from(stream.listeners);
        for (var i = 0; i < arr.length; i++) {
            try { arr[i].write(line); } catch (_) { stream.listeners.delete(arr[i]); }
        }
    }

    function endStream(conversationId) {
        const stream = activeStreams.get(conversationId);
        if (!stream) return;
        stream.done = true;
        // End the primary POST response
        if (stream.primaryRes) {
            try { stream.primaryRes.write('data: [DONE]\n\n'); stream.primaryRes.end(); } catch (_) {}
            stream.primaryRes = null;
        }
        // End all reconnect listeners
        for (const r of stream.listeners) {
            try { r.write('data: [DONE]\n\n'); r.end(); } catch (_) {}
        }
        stream.listeners.clear();
        // Keep buffer for 30s so frontend can still reconnect after slight delay
        setTimeout(() => { if (activeStreams.get(conversationId) === stream) activeStreams.delete(conversationId); }, 30000);
    }

    // Setup paths
    const userDataPath = app.getPath('userData');
    const dbPath = path.join(userDataPath, 'claude-desktop.json');

    // Workspace: use user-chosen path, or default to ~/Documents/Claude Desktop
    const defaultWorkspacesDir = path.join(app.getPath('documents'), 'Claude Desktop');
    // Read saved preference (set by onboarding or settings)
    let workspacesDir;
    try {
        const settingsPath = path.join(userDataPath, 'workspace-config.json');
        if (fs.existsSync(settingsPath)) {
            const cfg = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            workspacesDir = cfg.workspacesDir || defaultWorkspacesDir;
        } else {
            workspacesDir = defaultWorkspacesDir;
        }
    } catch (_) {
        workspacesDir = defaultWorkspacesDir;
    }

    if (!fs.existsSync(workspacesDir)) {
        fs.mkdirSync(workspacesDir, { recursive: true });
    }
    console.log('[Workspace]', workspacesDir);

    // Initialize DB
    let db = { conversations: [], messages: [], projects: [], project_files: [] };
    if (fs.existsSync(dbPath)) {
        try {
            const loaded = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
            db = { ...db, ...loaded };
            // Ensure new arrays exist for older DB files
            if (!db.projects) db.projects = [];
            if (!db.project_files) db.project_files = [];
        } catch (e) { }
    }
    const saveDb = () => fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));

    // ===== Provider Management =====
    const providersPath = path.join(userDataPath, 'providers.json');
    let providers = [];
    try {
        if (fs.existsSync(providersPath)) {
            providers = JSON.parse(fs.readFileSync(providersPath, 'utf8'));
        }
    } catch (_) {}
    const saveProviders = () => fs.writeFileSync(providersPath, JSON.stringify(providers, null, 2));

    // Resolve provider + key + url for a given model ID
    function resolveProvider(modelId) {
        // Search all enabled providers for this model
        let match = null;
        for (const p of providers) {
            if (!p.enabled) continue;
            if (p.models && p.models.some(m => m.id === modelId && m.enabled !== false)) {
                if (!match) {
                    match = p;
                } else {
                    console.warn('[Provider] WARNING: model "' + modelId + '" exists in multiple providers: "' + match.name + '" AND "' + p.name + '". Using first match: "' + match.name + '" (' + match.baseUrl + ')');
                }
            }
        }
        if (match) console.log('[Provider] Resolved "' + modelId + '" → "' + match.name + '" (' + match.baseUrl + ')');
        else console.log('[Provider] No provider found for "' + modelId + '"');
        return match;
    }

    // ===== URL normalization helper =====
    // Strips known endpoint suffixes so base URLs like
    // "https://api.siliconflow.cn/v1/chat/completions" become "https://api.siliconflow.cn/v1"
    function normalizeBaseUrl(url) {
        if (!url) return url;
        let clean = url.replace(/\/+$/, '');
        clean = clean.replace(/\/(chat\/completions|messages)$/, '');
        return clean.replace(/\/+$/, '');
    }

    // ===== OpenAI→Anthropic Conversion Proxy =====
    // Runs on a dynamic port; engine points ANTHROPIC_BASE_URL to it
    // The proxy receives Anthropic-format requests, converts to OpenAI format, calls the real endpoint
    const http = require('http');
    let proxyPort = 0;

    // Stored per-request: the proxy reads these to know where to forward
    let proxyTarget = { apiKey: '', baseUrl: '', model: '', format: 'anthropic' };

    // Pending image blocks to inject into the next API request (per-conversation)
    // The chat handler stores base64 images here; the proxy injects them into the user message
    const pendingImageBlocks = new Map(); // conversationId → [{ type: 'image', source: { type: 'base64', media_type, data } }]

    const proxyServer = http.createServer(async (req, res) => {
        if (req.method === 'POST' && req.url.includes('/messages')) {
            let body = '';
            req.on('data', c => body += c);
            req.on('end', async () => {
                try {
                    const anthropicReq = JSON.parse(body);
                    const target = proxyTarget;

                    // Inject any pending image blocks into the last user message
                    // (images uploaded by the user that need to be embedded in the API request)
                    // Only inject into the initial user message (not tool_result follow-ups).
                    // Don't delete — keep for retries. The chat handler clears after engine exits.
                    if (target.conversationId && pendingImageBlocks.has(target.conversationId)) {
                        const imgBlocks = pendingImageBlocks.get(target.conversationId);
                        if (imgBlocks && imgBlocks.length > 0 && anthropicReq.messages) {
                            // Find the last user message that has text (not just tool_result)
                            for (let i = anthropicReq.messages.length - 1; i >= 0; i--) {
                                const msg = anthropicReq.messages[i];
                                if (msg.role !== 'user') continue;
                                const parts = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }];
                                const hasToolResult = parts.some(b => b.type === 'tool_result');
                                if (hasToolResult) continue; // Skip tool_result messages
                                const existingContent = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }];
                                // Don't inject if images already present (re-injection on retry)
                                if (existingContent.some(b => b.type === 'image')) break;
                                msg.content = [...imgBlocks, ...existingContent];
                                console.log('[Proxy] Injected', imgBlocks.length, 'image block(s) into user message');
                                break;
                            }
                        }
                    }

                    if (target.format === 'openai') {
                        // Convert Anthropic → OpenAI format
                        const openaiMessages = [];
                        if (anthropicReq.system) {
                            const sysText = Array.isArray(anthropicReq.system)
                                ? anthropicReq.system.map(b => typeof b === 'string' ? b : b.text || '').join('\n')
                                : anthropicReq.system;
                            openaiMessages.push({ role: 'system', content: sysText });
                        }
                        for (const msg of (anthropicReq.messages || [])) {
                            if (msg.role === 'user') {
                                // User messages may contain text, image, and tool_result blocks
                                const parts = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }];
                                const textParts = parts.filter(b => b.type === 'text').map(b => b.text || '');
                                const imageParts = parts.filter(b => b.type === 'image');
                                const toolResults = parts.filter(b => b.type === 'tool_result');
                                if (toolResults.length > 0) {
                                    for (const tr of toolResults) {
                                        const trContent = Array.isArray(tr.content) ? tr.content.map(b => b.text || '').join('') : (tr.content || '');
                                        openaiMessages.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: trContent });
                                    }
                                }
                                if (imageParts.length > 0) {
                                    // Build multimodal user message with text + images (OpenAI format)
                                    const contentArray = [];
                                    const joinedText = textParts.join('').trim();
                                    if (joinedText) contentArray.push({ type: 'text', text: joinedText });
                                    for (const img of imageParts) {
                                        if (img.source && img.source.type === 'base64') {
                                            contentArray.push({ type: 'image_url', image_url: { url: `data:${img.source.media_type};base64,${img.source.data}` } });
                                        }
                                    }
                                    if (contentArray.length > 0) openaiMessages.push({ role: 'user', content: contentArray });
                                } else if (textParts.join('').trim()) {
                                    openaiMessages.push({ role: 'user', content: textParts.join('') });
                                }
                            } else if (msg.role === 'assistant') {
                                const parts = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }];
                                const textContent = parts.filter(b => b.type === 'text').map(b => b.text || '').join('');
                                const toolUses = parts.filter(b => b.type === 'tool_use');
                                if (toolUses.length > 0) {
                                    openaiMessages.push({
                                        role: 'assistant',
                                        content: textContent || null,
                                        tool_calls: toolUses.map(tu => ({
                                            id: tu.id, type: 'function',
                                            function: { name: tu.name, arguments: JSON.stringify(tu.input || {}) }
                                        }))
                                    });
                                } else {
                                    openaiMessages.push({ role: 'assistant', content: textContent });
                                }
                            }
                        }

                        // Convert Anthropic tools → OpenAI tools
                        const openaiTools = (anthropicReq.tools || []).map(t => ({
                            type: 'function',
                            function: {
                                name: t.name,
                                description: t.description || '',
                                parameters: t.input_schema || { type: 'object', properties: {} },
                            }
                        }));

                        const openaiBody = {
                            model: target.model || anthropicReq.model,
                            messages: openaiMessages,
                            max_tokens: Math.min(anthropicReq.max_tokens || 4096, 8192),
                            stream: true,
                        };
                        if (openaiTools.length > 0) openaiBody.tools = openaiTools;
                        if (anthropicReq.temperature != null) openaiBody.temperature = anthropicReq.temperature;
                        // Convert Anthropic thinking config → OpenAI-compatible thinking params
                        // Qwen uses enable_thinking, DeepSeek uses similar pattern
                        if (anthropicReq.thinking && anthropicReq.thinking.type === 'enabled') {
                            // Qwen (and similar models) have a known issue where thinking + tool_calls
                            // don't work reliably together — the model puts tool arguments into
                            // reasoning_content instead of function.arguments, causing empty tool inputs.
                            // Only enable thinking when there are no tools in the request.
                            if (openaiTools.length > 0) {
                                console.log('[Proxy] Tools present — disabling thinking to avoid empty tool args (thinking+tools incompatibility)');
                            } else {
                                openaiBody.enable_thinking = true;
                            }
                        }

                        let endpoint = normalizeBaseUrl(target.baseUrl);
                        if (!endpoint.endsWith('/v1')) endpoint += '/v1';
                        endpoint += '/chat/completions';

                        // Retry fetch up to 2 times on network errors (DNS cold-start, connection reset, etc.)
                        // This avoids the much slower engine-level api_retry which adds seconds of backoff delay
                        let upstreamRes;
                        const maxRetries = 2;
                        const bodyStr = JSON.stringify(openaiBody);
                        for (let attempt = 0; attempt <= maxRetries; attempt++) {
                            const fetchController = new AbortController();
                            const fetchTimeout = setTimeout(() => fetchController.abort(), 120000);
                            try {
                                upstreamRes = await fetch(endpoint, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + target.apiKey },
                                    body: bodyStr,
                                    signal: fetchController.signal,
                                });
                                clearTimeout(fetchTimeout);
                                break; // success
                            } catch (fetchErr) {
                                clearTimeout(fetchTimeout);
                                if (attempt < maxRetries) {
                                    console.warn('[Proxy] Fetch attempt ' + (attempt + 1) + ' failed: ' + (fetchErr.message || fetchErr) + ', retrying in 300ms...');
                                    await new Promise(r => setTimeout(r, 300));
                                    continue;
                                }
                                console.error('[Proxy] Fetch error after ' + (maxRetries + 1) + ' attempts:', fetchErr.message || fetchErr);
                                res.writeHead(502, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: 'Failed to connect to upstream: ' + (fetchErr.message || 'timeout') } }));
                                return;
                            }
                        }

                        if (!upstreamRes.ok) {
                            const errText = await upstreamRes.text();
                            // Include the upstream URL in error so users can see where the request went
                            const errMsg = 'Failed to authenticate. API Error: ' + upstreamRes.status + ' ' + errText.slice(0, 400) + ' [endpoint: ' + endpoint + ']';
                            console.error('[Proxy] Upstream error:', upstreamRes.status, 'from', endpoint, errText.slice(0, 200));
                            res.writeHead(upstreamRes.status, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: errMsg } }));
                            return;
                        }

                        // Stream OpenAI SSE → convert to Anthropic SSE format
                        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });

                        // Send message_start
                        res.write('event: message_start\ndata: ' + JSON.stringify({
                            type: 'message_start',
                            message: { id: 'msg_proxy', type: 'message', role: 'assistant', content: [], model: target.model, usage: { input_tokens: 0, output_tokens: 0 } }
                        }) + '\n\n');

                        const reader = upstreamRes.body.getReader();
                        const decoder = new TextDecoder();
                        let sseBuffer = '';
                        let totalTokens = 0;
                        let contentBlockIndex = 0;
                        let textBlockStarted = false;
                        let thinkingBlockStarted = false;
                        // Track tool_calls being streamed (OpenAI streams them incrementally)
                        const pendingToolCalls = new Map(); // index → { id, name, args }

                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            sseBuffer += decoder.decode(value, { stream: true });
                            const lines = sseBuffer.split('\n');
                            sseBuffer = lines.pop() || '';
                            for (const line of lines) {
                                if (!line.startsWith('data: ')) continue;
                                const data = line.slice(6).trim();
                                if (data === '[DONE]') continue;
                                try {
                                    const chunk = JSON.parse(data);
                                    const delta = chunk.choices?.[0]?.delta;
                                    const finishReason = chunk.choices?.[0]?.finish_reason;

                                    // Reasoning/thinking content (Qwen reasoning_content, DeepSeek etc.)
                                    if (delta?.reasoning_content) {
                                        if (!thinkingBlockStarted) {
                                            res.write('event: content_block_start\ndata: ' + JSON.stringify({
                                                type: 'content_block_start', index: contentBlockIndex, content_block: { type: 'thinking', thinking: '' }
                                            }) + '\n\n');
                                            thinkingBlockStarted = true;
                                        }
                                        res.write('event: content_block_delta\ndata: ' + JSON.stringify({
                                            type: 'content_block_delta', index: contentBlockIndex, delta: { type: 'thinking_delta', thinking: delta.reasoning_content }
                                        }) + '\n\n');
                                    }

                                    // Text content
                                    if (delta?.content) {
                                        // Close thinking block before starting text block
                                        if (thinkingBlockStarted) {
                                            res.write('event: content_block_stop\ndata: ' + JSON.stringify({ type: 'content_block_stop', index: contentBlockIndex }) + '\n\n');
                                            contentBlockIndex++;
                                            thinkingBlockStarted = false;
                                        }
                                        if (!textBlockStarted) {
                                            res.write('event: content_block_start\ndata: ' + JSON.stringify({
                                                type: 'content_block_start', index: contentBlockIndex, content_block: { type: 'text', text: '' }
                                            }) + '\n\n');
                                            textBlockStarted = true;
                                        }
                                        res.write('event: content_block_delta\ndata: ' + JSON.stringify({
                                            type: 'content_block_delta', index: contentBlockIndex, delta: { type: 'text_delta', text: delta.content }
                                        }) + '\n\n');
                                    }

                                    // Tool calls (OpenAI streams them as delta.tool_calls[])
                                    if (delta?.tool_calls) {
                                        for (const tc of delta.tool_calls) {
                                            const tcIdx = tc.index ?? 0;
                                            if (!pendingToolCalls.has(tcIdx)) {
                                                // Close text block if open
                                                if (textBlockStarted) {
                                                    res.write('event: content_block_stop\ndata: ' + JSON.stringify({ type: 'content_block_stop', index: contentBlockIndex }) + '\n\n');
                                                    contentBlockIndex++;
                                                    textBlockStarted = false;
                                                }
                                                pendingToolCalls.set(tcIdx, { id: tc.id || ('call_' + tcIdx), name: tc.function?.name || '', args: '' });
                                                // Send content_block_start for tool_use
                                                const ptc = pendingToolCalls.get(tcIdx);
                                                res.write('event: content_block_start\ndata: ' + JSON.stringify({
                                                    type: 'content_block_start', index: contentBlockIndex + tcIdx,
                                                    content_block: { type: 'tool_use', id: ptc.id, name: ptc.name, input: {} }
                                                }) + '\n\n');
                                            }
                                            const ptc = pendingToolCalls.get(tcIdx);
                                            if (tc.function?.name && !ptc.name) ptc.name = tc.function.name;
                                            if (tc.function?.arguments) ptc.args += tc.function.arguments;
                                        }
                                    }

                                    // On finish, close all pending tool calls
                                    if (finishReason === 'tool_calls' || finishReason === 'stop') {
                                        if (textBlockStarted) {
                                            res.write('event: content_block_stop\ndata: ' + JSON.stringify({ type: 'content_block_stop', index: contentBlockIndex }) + '\n\n');
                                            contentBlockIndex++;
                                            textBlockStarted = false;
                                        }
                                        for (const [tcIdx, ptc] of pendingToolCalls) {
                                            // Warn if tool args are empty — qwen sometimes generates tool_call
                                            // name+id but fails to fill in function.arguments
                                            let parsedInput = {};
                                            try { parsedInput = JSON.parse(ptc.args); } catch (_) {}
                                            if ((!ptc.args || Object.keys(parsedInput).length === 0) && ptc.name) {
                                                console.warn('[Proxy] Tool call "' + ptc.name + '" has empty args — model may have failed to generate arguments');
                                            }
                                            // Send input_json_delta with complete input
                                            res.write('event: content_block_delta\ndata: ' + JSON.stringify({
                                                type: 'content_block_delta', index: contentBlockIndex + tcIdx,
                                                delta: { type: 'input_json_delta', partial_json: ptc.args }
                                            }) + '\n\n');
                                            res.write('event: content_block_stop\ndata: ' + JSON.stringify({
                                                type: 'content_block_stop', index: contentBlockIndex + tcIdx
                                            }) + '\n\n');
                                        }
                                    }

                                    if (chunk.usage) totalTokens = chunk.usage.total_tokens || 0;
                                } catch (_) {}
                            }
                        }

                        // Close any remaining open blocks
                        if (thinkingBlockStarted) {
                            res.write('event: content_block_stop\ndata: ' + JSON.stringify({ type: 'content_block_stop', index: contentBlockIndex }) + '\n\n');
                            contentBlockIndex++;
                        }
                        if (textBlockStarted) {
                            res.write('event: content_block_stop\ndata: ' + JSON.stringify({ type: 'content_block_stop', index: contentBlockIndex }) + '\n\n');
                        }

                        // Send message_delta + message_stop
                        const stopReason = pendingToolCalls.size > 0 ? 'tool_use' : 'end_turn';
                        res.write('event: message_delta\ndata: ' + JSON.stringify({
                            type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: totalTokens }
                        }) + '\n\n');
                        res.write('event: message_stop\ndata: ' + JSON.stringify({ type: 'message_stop' }) + '\n\n');
                        res.end();
                    } else {
                        // Anthropic format — passthrough to real endpoint
                        let endpoint = normalizeBaseUrl(target.baseUrl);
                        if (!endpoint.endsWith('/v1')) endpoint += '/v1';
                        endpoint += '/messages';

                        const upstreamRes = await fetch(endpoint, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'x-api-key': target.apiKey,
                                'anthropic-version': '2023-06-01',
                            },
                            body: body,
                        });
                        res.writeHead(upstreamRes.status, Object.fromEntries(upstreamRes.headers.entries()));
                        const reader = upstreamRes.body.getReader();
                        const pump = async () => {
                            while (true) {
                                const { done, value } = await reader.read();
                                if (done) { res.end(); break; }
                                res.write(value);
                            }
                        };
                        await pump();
                    }
                } catch (err) {
                    console.error('[Proxy] Error:', err.message);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: err.message } }));
                }
            });
        } else {
            res.writeHead(404);
            res.end('Not found');
        }
    });
    proxyServer.listen(0, '127.0.0.1', () => {
        proxyPort = proxyServer.address().port;
        console.log('[Proxy] OpenAI conversion proxy on port', proxyPort);
    });

    async function generateTitleAsync(conversationId, userMsg, assistantMsg, token, baseUrl, activeModel, apiFormat) {
        if (!token) { console.log('[Title] Skipped: no API token'); return; }
        try {
            const bConv = db.conversations.find(c => c.id === conversationId);
            if (!bConv || (bConv.title !== 'New Conversation' && bConv.title !== 'New Chat')) return;

            // Strip -thinking suffix — raw API doesn't accept it
            let modelId = (activeModel || 'claude-sonnet-4-6').replace(/-thinking$/, '');

            const titlePrompt = `请根据这段对话生成一个简短的标题（最多5-7个字，不要用引号），概括对话的主题：\n\n用户：${userMsg}\n助手：${assistantMsg}\n\n标题：`;

            if (apiFormat === 'openai') {
                // OpenAI format title generation
                let endpoint = normalizeBaseUrl(baseUrl);
                if (!endpoint.endsWith('/v1')) endpoint += '/v1';
                endpoint += '/chat/completions';

                console.log(`[Title] Generating (OpenAI) for ${conversationId} via ${endpoint} model=${modelId}`);
                const titleController = new AbortController();
                const titleTimeout = setTimeout(() => titleController.abort(), 30000);
                const titleBody = {
                    model: modelId,
                    max_tokens: 200,
                    enable_thinking: false,
                    messages: [
                        { role: 'system', content: 'You are a title generator. Respond only with the title, without any quotes or explanations. Maximum 5-7 words.' },
                        { role: 'user', content: titlePrompt }
                    ]
                };
                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify(titleBody),
                    signal: titleController.signal,
                });
                clearTimeout(titleTimeout);
                if (response.ok) {
                    const buf = await response.arrayBuffer();
                    const data = JSON.parse(new TextDecoder('utf-8').decode(buf));
                    const title = data.choices?.[0]?.message?.content?.replace(/^["']|["']$/g, '').trim();
                    if (title) {
                        bConv.title = title;
                        saveDb();
                        console.log(`[Title] Success: "${title}"`);
                    } else {
                        console.error('[Title] No text in OpenAI response:', JSON.stringify(data));
                    }
                } else {
                    console.error('[Title] HTTP Error:', response.status, endpoint, await response.text());
                }
            } else {
                // Anthropic format title generation
                let endpoint;
                if (baseUrl) {
                    const clean = normalizeBaseUrl(baseUrl);
                    endpoint = clean.endsWith('/v1') ? `${clean}/messages` : `${clean}/v1/messages`;
                } else {
                    endpoint = 'https://api.anthropic.com/v1/messages';
                }

                console.log(`[Title] Generating for ${conversationId} via ${endpoint} model=${modelId}`);
                const anthTitleCtrl = new AbortController();
                const anthTitleTimeout = setTimeout(() => anthTitleCtrl.abort(), 30000);
                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json; charset=utf-8',
                        'x-api-key': token,
                        'anthropic-version': '2023-06-01'
                    },
                    signal: anthTitleCtrl.signal,
                    body: JSON.stringify({
                        model: modelId,
                        max_tokens: 50,
                        system: 'You are a title generator. Respond only with the title, without any quotes or explanations. Maximum 5-7 words.',
                        messages: [
                            { role: 'user', content: titlePrompt }
                        ]
                    })
                });
                clearTimeout(anthTitleTimeout);
                if (response.ok) {
                    const data = await response.json();
                    let title = null;
                    if (data.content && Array.isArray(data.content)) {
                        const textBlock = data.content.find(b => b.type === 'text' && b.text);
                        if (textBlock && textBlock.text) {
                            title = textBlock.text.replace(/^["']|["']$/g, '').trim();
                        }
                    }
                    if (title) {
                        bConv.title = title;
                        saveDb();
                        console.log(`[Title] Success: "${title}"`);
                    } else {
                        console.error('[Title] No text in response:', JSON.stringify(data));
                    }
                } else {
                    console.error('[Title] HTTP Error:', response.status, endpoint, await response.text());
                }
            }
        } catch (e) {
            console.error('[Title] Exception:', e.message || e);
        }
    }

    // ═══════════════════ Projects ═══════════════════

    server.get('/api/projects', (req, res) => {
        const list = [...db.projects]
            .filter(p => !p.is_archived)
            .sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));
        // Attach counts
        const result = list.map(p => ({
            ...p,
            file_count: db.project_files.filter(f => f.project_id === p.id).length,
            chat_count: db.conversations.filter(c => c.project_id === p.id).length,
        }));
        res.json(result);
    });

    server.post('/api/projects', (req, res) => {
        const id = uuidv4();
        const { name, description = '' } = req.body;
        if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });

        const projectDir = path.join(workspacesDir, `project-${id}`);
        if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir, { recursive: true });

        const project = {
            id, name: name.trim(), description: description.trim(),
            instructions: '', workspace_path: projectDir,
            is_archived: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        };
        db.projects.push(project);
        saveDb();
        res.json(project);
    });

    server.get('/api/projects/:id', (req, res) => {
        const project = db.projects.find(p => p.id === req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });

        const files = db.project_files.filter(f => f.project_id === project.id)
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        const conversations = db.conversations.filter(c => c.project_id === project.id)
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        res.json({ ...project, files, conversations });
    });

    server.patch('/api/projects/:id', (req, res) => {
        const project = db.projects.find(p => p.id === req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });

        if (req.body.name !== undefined) project.name = req.body.name.trim();
        if (req.body.description !== undefined) project.description = req.body.description;
        if (req.body.instructions !== undefined) project.instructions = req.body.instructions;
        if (req.body.is_archived !== undefined) project.is_archived = req.body.is_archived;
        project.updated_at = new Date().toISOString();

        saveDb();
        res.json(project);
    });

    server.delete('/api/projects/:id', (req, res) => {
        const pid = req.params.id;
        // Delete project files from disk
        const files = db.project_files.filter(f => f.project_id === pid);
        for (const f of files) {
            if (f.file_path && fs.existsSync(f.file_path)) {
                try { fs.unlinkSync(f.file_path); } catch (_) {}
            }
        }
        db.project_files = db.project_files.filter(f => f.project_id !== pid);

        // Delete project conversations + messages + workspaces
        const convIds = db.conversations.filter(c => c.project_id === pid).map(c => c.id);
        db.messages = db.messages.filter(m => !convIds.includes(m.conversation_id));
        db.conversations = db.conversations.filter(c => c.project_id !== pid);
        for (const cid of convIds) {
            const wsPath = path.join(workspacesDir, cid);
            if (fs.existsSync(wsPath)) try { fs.rmSync(wsPath, { recursive: true, force: true }); } catch (_) {}
        }

        // Delete project dir
        const projectDir = path.join(workspacesDir, `project-${pid}`);
        if (fs.existsSync(projectDir)) try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch (_) {}

        db.projects = db.projects.filter(p => p.id !== pid);
        saveDb();
        res.json({ success: true });
    });

    // ═══ Project file upload ═══
    const projectUploadStorage = multer.diskStorage({
        destination: (req, file, cb) => {
            const project = db.projects.find(p => p.id === req.params.id);
            const dir = project ? path.join(project.workspace_path, 'files') : path.join(workspacesDir, 'temp');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            cb(null, dir);
        },
        filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname),
    });
    const projectUpload = multer({ storage: projectUploadStorage });

    server.post('/api/projects/:id/files', projectUpload.single('file'), (req, res) => {
        const project = db.projects.find(p => p.id === req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });
        if (!req.file) return res.status(400).json({ error: 'No file' });

        // Extract text for known text formats
        let extractedText = '';
        const textExts = ['.txt', '.md', '.json', '.xml', '.yaml', '.yml', '.csv', '.html', '.css', '.js', '.ts', '.tsx', '.jsx', '.py', '.java', '.c', '.cpp', '.h', '.go', '.rs', '.rb', '.php', '.sql', '.sh', '.lua', '.r'];
        const ext = path.extname(req.file.originalname).toLowerCase();
        if (textExts.includes(ext)) {
            try { extractedText = fs.readFileSync(req.file.path, 'utf8'); } catch (_) {}
        }

        const fileEntry = {
            id: uuidv4(),
            project_id: project.id,
            file_name: req.file.originalname,
            file_path: req.file.path,
            file_size: req.file.size,
            mime_type: req.file.mimetype,
            extracted_text: extractedText,
            created_at: new Date().toISOString(),
        };
        db.project_files.push(fileEntry);
        project.updated_at = new Date().toISOString();
        saveDb();

        res.json({ ...fileEntry, extracted_text: undefined }); // Don't send full text back
    });

    server.delete('/api/projects/:projectId/files/:fileId', (req, res) => {
        const file = db.project_files.find(f => f.id === req.params.fileId && f.project_id === req.params.projectId);
        if (!file) return res.status(404).json({ error: 'File not found' });

        if (file.file_path && fs.existsSync(file.file_path)) {
            try { fs.unlinkSync(file.file_path); } catch (_) {}
        }
        db.project_files = db.project_files.filter(f => f.id !== file.id);
        const project = db.projects.find(p => p.id === req.params.projectId);
        if (project) project.updated_at = new Date().toISOString();
        saveDb();
        res.json({ success: true });
    });

    // ═══ Project conversations ═══
    server.get('/api/projects/:id/conversations', (req, res) => {
        const convs = db.conversations.filter(c => c.project_id === req.params.id)
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        res.json(convs);
    });

    server.post('/api/projects/:id/conversations', (req, res) => {
        const project = db.projects.find(p => p.id === req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });

        const id = uuidv4();
        const { title = 'New Conversation', model = 'claude-sonnet-4-6' } = req.body;
        const workspacePath = path.join(workspacesDir, id);
        if (!fs.existsSync(workspacePath)) fs.mkdirSync(workspacePath, { recursive: true });

        // Copy project files into workspace so SDK can read them
        const projectFiles = db.project_files.filter(f => f.project_id === project.id);
        for (const pf of projectFiles) {
            if (pf.file_path && fs.existsSync(pf.file_path)) {
                try { fs.copyFileSync(pf.file_path, path.join(workspacePath, pf.file_name)); } catch (_) {}
            }
        }

        const newConv = {
            id, title, model, project_id: project.id,
            workspace_path: workspacePath, created_at: new Date().toISOString(),
        };
        db.conversations.push(newConv);
        project.updated_at = new Date().toISOString();
        saveDb();
        res.json(newConv);
    });

    // ═══════════════════ Conversations ═══════════════════

    // ===== Artifacts API =====
    // Scans all messages for Write tool calls that created renderable HTML files
    server.get('/api/artifacts', (req, res) => {
        const artifacts = [];
        const htmlExts = ['.html', '.htm'];
        for (const msg of db.messages) {
            if (!msg.toolCalls) continue;
            for (const tc of msg.toolCalls) {
                if (tc.name !== 'Write' || tc.status === 'error') continue;
                const fp = tc.input?.file_path;
                if (!fp) continue;
                const ext = path.extname(fp).toLowerCase();
                if (!htmlExts.includes(ext)) continue;
                // Read file content to verify it's renderable HTML
                let content = '';
                try { content = fs.readFileSync(fp, 'utf-8'); } catch { continue; }
                const trimmed = content.trimStart().slice(0, 100).toLowerCase();
                if (!trimmed.includes('<!doctype') && !trimmed.includes('<html') && !trimmed.includes('<head') && !trimmed.includes('<body')) continue;
                const conv = db.conversations.find(c => c.id === msg.conversation_id);
                artifacts.push({
                    id: tc.id,
                    title: path.basename(fp),
                    file_path: fp,
                    conversation_id: msg.conversation_id,
                    conversation_title: conv?.title || 'Untitled',
                    message_id: msg.id,
                    created_at: msg.created_at,
                    content_length: content.length,
                });
            }
        }
        // Sort newest first, deduplicate by file_path (keep latest)
        artifacts.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        const seen = new Set();
        const unique = artifacts.filter(a => {
            if (seen.has(a.file_path)) return false;
            seen.add(a.file_path);
            return true;
        });
        res.json(unique);
    });

    // Get artifact content by file path
    server.get('/api/artifacts/content', (req, res) => {
        const fp = req.query.path;
        if (!fp) return res.status(400).json({ error: 'Missing path' });
        try {
            const content = fs.readFileSync(fp, 'utf-8');
            res.json({ content, format: 'html', title: path.basename(fp) });
        } catch {
            res.status(404).json({ error: 'File not found' });
        }
    });

    server.get('/api/conversations', (req, res) => {
        const projectId = req.query.project_id;
        let list;
        if (projectId) {
            list = db.conversations.filter(c => c.project_id === projectId);
        } else {
            // Return all conversations including project ones
            list = db.conversations;
        }
        // Enrich with project name for sidebar display
        list = [...list].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
            .map(c => {
                if (c.project_id) {
                    const project = db.projects.find(p => p.id === c.project_id);
                    return { ...c, project_name: project ? project.name : null };
                }
                return c;
            });
        res.json(list);
    });

    server.post('/api/conversations', (req, res) => {
        const id = uuidv4();
        const { title = 'New Conversation', model = 'claude-sonnet-4-6', project_id } = req.body;
        const workspacePath = path.join(workspacesDir, id);

        if (!fs.existsSync(workspacePath)) {
            fs.mkdirSync(workspacePath, { recursive: true });
        }

        // If creating under a project, copy project files into workspace
        if (project_id) {
            const project = db.projects.find(p => p.id === project_id);
            if (project) {
                const projectFiles = db.project_files.filter(f => f.project_id === project_id);
                for (const pf of projectFiles) {
                    if (pf.file_path && fs.existsSync(pf.file_path)) {
                        try { fs.copyFileSync(pf.file_path, path.join(workspacePath, pf.file_name)); } catch (_) {}
                    }
                }
            }
        }

        const newConv = {
            id, title, model, workspace_path: workspacePath, created_at: new Date().toISOString(),
            ...(project_id ? { project_id } : {}),
        };
        db.conversations.push(newConv);
        saveDb();

        res.json({ id, title, model, workspace_path: workspacePath });
    });

    server.get('/api/conversations/:id', (req, res) => {
        const conv = db.conversations.find(c => c.id === req.params.id);
        if (!conv) return res.status(404).json({ error: 'Not found' });

        const messages = db.messages.filter(m => m.conversation_id === req.params.id)
            .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

        const parsedMessages = messages.map(m => {
            let contentStr = '';
            try {
                const parsed = JSON.parse(m.content);
                if (Array.isArray(parsed)) {
                    contentStr = parsed.map(c => c.text || '').join('');
                } else if (typeof parsed === 'string') {
                    contentStr = parsed;
                } else {
                    contentStr = m.content;
                }
            } catch (e) {
                contentStr = m.content;
            }
            // Normalize attachment keys: DB stores camelCase, frontend expects snake_case
            let attachments = m.attachments;
            if (Array.isArray(attachments)) {
                attachments = attachments.map(a => {
                    const name = a.file_name || a.fileName || '';
                    const ext = name.split('.').pop()?.toLowerCase() || '';
                    const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];
                    const isImg = (a.file_type === 'image' || a.fileType === 'image')
                        || (a.mime_type && a.mime_type.startsWith('image/'))
                        || (a.mimeType && a.mimeType.startsWith('image/'))
                        || imageExts.includes(ext);
                    return {
                        id: a.id || a.fileId || '',
                        file_name: name || 'file',
                        file_type: isImg ? 'image' : (a.file_type || a.fileType || 'document'),
                        mime_type: a.mime_type || a.mimeType || (isImg ? 'image/' + (ext === 'jpg' ? 'jpeg' : ext) : ''),
                        file_size: a.file_size || a.size || 0,
                    };
                });
            }
            return {
                ...m,
                content: contentStr,
                attachments,
            };
        });

        res.json({
            ...conv,
            messages: parsedMessages
        });
    });

    server.patch('/api/conversations/:id', (req, res) => {
        const conv = db.conversations.find(c => c.id === req.params.id);
        if (!conv) return res.status(404).json({ error: 'Not found' });

        if (req.body.title) conv.title = req.body.title;
        if (req.body.model && req.body.model !== conv.model) {
            console.log('[Session] Model changed for conv', conv.id, ':', conv.model, '→', req.body.model, '(session preserved)');
            conv.model = req.body.model;
            // Don't reset claude_session_id — engine sessions store message history
            // which is model-agnostic. The engine can resume with a different model.
        }
        // Move conversation to/from a project
        if ('project_id' in req.body) {
            const pid = req.body.project_id;
            if (pid) {
                const project = db.projects.find(p => p.id === pid);
                if (!project) return res.status(404).json({ error: 'Project not found' });
                conv.project_id = pid;
                project.updated_at = new Date().toISOString();
            } else {
                delete conv.project_id;
            }
        }

        saveDb();
        res.json(conv);
    });

    server.delete('/api/conversations/:id', (req, res) => {
        const id = req.params.id;
        db.messages = db.messages.filter(m => m.conversation_id !== id);
        db.conversations = db.conversations.filter(c => c.id !== id);
        saveDb();
        // Also delete the workspace folder from disk
        const wsPath = path.join(workspacesDir, id);
        if (fs.existsSync(wsPath)) {
            try {
                fs.rmSync(wsPath, { recursive: true, force: true });
                console.log(`[Delete] Removed workspace: ${wsPath}`);
            } catch (e) {
                console.error(`[Delete] Failed to remove workspace: ${e.message}`);
            }
        }
        res.json({ success: true });
    });

    server.delete('/api/conversations/:id/messages/:messageId', (req, res) => {
        const { id, messageId } = req.params;
        const msgIndex = db.messages.findIndex(m => m.id === messageId && m.conversation_id === id);
        if (msgIndex === -1) return res.status(404).json({ error: 'Message not found' });

        // Remove this message and all subsequent messages in the conversation
        const targetCreatedAt = new Date(db.messages[msgIndex].created_at).getTime();
        db.messages = db.messages.filter(m => {
            if (m.conversation_id !== id) return true;
            return new Date(m.created_at).getTime() < targetCreatedAt;
        });
        // Reset engine session — old context is no longer valid
        const conv = db.conversations.find(c => c.id === id);
        if (conv) { conv.claude_session_id = null; console.log('[Session] Reset for conv', id, '(messages deleted)'); }
        saveDb();
        res.json({ success: true });
    });

    server.delete('/api/conversations/:id/messages-tail/:count', (req, res) => {
        const { id, count } = req.params;
        const numToRemove = parseInt(count, 10);
        if (isNaN(numToRemove) || numToRemove <= 0) return res.status(400).json({ error: 'Invalid count' });

        const convMsgs = db.messages.filter(m => m.conversation_id === id).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        if (convMsgs.length <= numToRemove) {
            db.messages = db.messages.filter(m => m.conversation_id !== id);
        } else {
            const cutoffTime = new Date(convMsgs[convMsgs.length - numToRemove].created_at).getTime();
            db.messages = db.messages.filter(m => {
                if (m.conversation_id !== id) return true;
                return new Date(m.created_at).getTime() < cutoffTime;
            });
        }
        // Reset engine session — old context is no longer valid
        const conv = db.conversations.find(c => c.id === id);
        if (conv) { conv.claude_session_id = null; console.log('[Session] Reset for conv', id, '(tail deleted)'); }
        saveDb();
        res.json({ success: true });
    });

    // Multer upload config
    const storage = multer.diskStorage({
        destination: (req, file, cb) => {
            const convId = req.headers['x-conversation-id'] || 'temp';
            const dir = path.join(workspacesDir, convId, '.uploads');
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            cb(null, dir);
        },
        filename: (req, file, cb) => {
            cb(null, Date.now() + '-' + file.originalname);
        }
    });
    const upload = multer({ storage });

    server.post('/api/upload', upload.single('file'), (req, res) => {
        if (!req.file) return res.status(400).json({ error: 'No file' });
        // Verify file on disk has actual content
        let diskSize = 0;
        try { diskSize = fs.statSync(req.file.path).size; } catch (_) {}
        console.log(`[Upload] ${req.file.originalname} → ${req.file.path} (multer=${req.file.size}, disk=${diskSize})`);
        if (diskSize === 0) {
            // File is empty on disk — tell client to retry
            try { fs.unlinkSync(req.file.path); } catch (_) {}
            return res.status(422).json({ error: 'File upload incomplete (0 bytes on disk). Please retry.' });
        }
        res.json({
            fileId: path.basename(req.file.path),
            fileName: req.file.originalname,
            fileType: req.file.mimetype.startsWith('image') ? 'image' : 'document',
            mimeType: req.file.mimetype,
            localPath: req.file.path,
            size: diskSize
        });
    });

    // Resolve a fileId to its local path and serve the raw file
    server.get('/api/uploads/:fileId/raw', (req, res) => {
        const fileId = req.params.fileId;
        const convId = req.query.conversation_id || '';
        // Search in conversation uploads first, then all workspaces
        const searchDirs = [];
        if (convId) searchDirs.push(path.join(workspacesDir, convId, '.uploads'));
        // Also search all conversation upload dirs
        try {
            const allConvDirs = fs.readdirSync(workspacesDir);
            for (const dir of allConvDirs) {
                const uploadsDir = path.join(workspacesDir, dir, '.uploads');
                if (fs.existsSync(uploadsDir)) searchDirs.push(uploadsDir);
            }
        } catch (_) {}

        // Helper: serve file with correct mime type (avoids Express 5 sendFile Windows issues)
        const serveFile = (fp) => {
            const ext = path.extname(fp).toLowerCase();
            const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json' };
            res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
            res.send(fs.readFileSync(fp));
        };

        for (const dir of searchDirs) {
            const filePath = path.join(dir, fileId);
            if (fs.existsSync(filePath)) {
                return serveFile(filePath);
            }
            // Try partial match
            try {
                const files = fs.readdirSync(dir);
                const match = files.find(f => f === fileId || f.includes(fileId));
                if (match) return serveFile(path.join(dir, match));
            } catch (_) {}
        }
        res.status(404).json({ error: 'File not found' });
    });

    // Get local file path for a fileId
    server.get('/api/uploads/:fileId/path', (req, res) => {
        const fileId = req.params.fileId;
        const convId = req.query.conversation_id || '';
        const searchDirs = [];
        if (convId) searchDirs.push(path.join(workspacesDir, convId, '.uploads'));
        try {
            const allConvDirs = fs.readdirSync(workspacesDir);
            for (const dir of allConvDirs) {
                const uploadsDir = path.join(workspacesDir, dir, '.uploads');
                if (fs.existsSync(uploadsDir)) searchDirs.push(uploadsDir);
            }
        } catch (_) {}

        for (const dir of searchDirs) {
            const filePath = path.join(dir, fileId);
            if (fs.existsSync(filePath)) {
                return res.json({ localPath: filePath, folder: dir });
            }
            try {
                const files = fs.readdirSync(dir);
                const match = files.find(f => f === fileId || f.includes(fileId));
                if (match) return res.json({ localPath: path.join(dir, match), folder: dir });
            } catch (_) {}
        }
        res.status(404).json({ error: 'File not found' });
    });

    // Compact conversation — delegates to Claude Code engine's /compact command
    server.post('/api/conversations/:id/compact', async (req, res) => {
        const conv = db.conversations.find(c => c.id === req.params.id);
        if (!conv) return res.status(404).json({ error: 'Conversation not found' });

        if (!conv.claude_session_id) {
            return res.status(400).json({ error: 'No engine session to compact (conversation has no history in engine)' });
        }

        const env_token = req.body.env_token;
        const env_base_url = req.body.env_base_url;
        const instruction = req.body.instruction || '';
        const apiKey = env_token || engineEnvVars.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
        const baseUrl = engineEnvVars.ANTHROPIC_BASE_URL || env_base_url || process.env.ANTHROPIC_BASE_URL;
        const modelId = (conv.model || 'claude-sonnet-4-6').replace(/-thinking$/, '');

        // Count messages before compaction for reporting
        const messagesBeforeCompact = db.messages.filter(m => m.conversation_id === req.params.id).length;

        try {
            // Spawn engine CLI with /compact as the prompt — engine handles the full compaction internally
            const compactPrompt = instruction ? `/compact ${instruction}` : '/compact';
            const cliArgs = [
                '--preload', enginePreload,
                '--env-file=' + engineEnv, engineCli,
                '-p', compactPrompt,
                '--output-format', 'stream-json',
                '--verbose',
                '--bare',
                '--permission-mode', 'bypassPermissions',
                '--model', modelId,
                '--resume', conv.claude_session_id,
            ];

            const envVars = Object.assign({}, process.env);
            if (apiKey) envVars.ANTHROPIC_API_KEY = apiKey;
            envVars.ANTHROPIC_BASE_URL = baseUrl || engineEnvVars.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';

            console.log('[Compact] Spawning engine /compact, session=' + conv.claude_session_id + ' model=' + modelId);

            const child = spawn(bunExePath, cliArgs, {
                cwd: conv.workspace_path, env: envVars,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            child.stdin.end();

            let compactSummary = '';
            let compactMetadata = null;
            let buf = '';

            child.stdout.on('data', (chunk) => {
                buf += chunk.toString('utf8');
                const lines = buf.split('\n');
                buf = lines.pop() || '';

                for (const line of lines) {
                    if (!line.trim()) continue;
                    let evt;
                    try { evt = JSON.parse(line); } catch { continue; }

                    // Capture the compact_boundary event from engine
                    if (evt.type === 'system' && evt.subtype === 'compact_boundary') {
                        compactMetadata = evt.compact_metadata || {};
                        console.log('[Compact] Engine compact_boundary:', JSON.stringify(compactMetadata));
                    }
                    // Capture any text output (the compact summary display)
                    if (evt.type === 'assistant' && evt.message && evt.message.content) {
                        for (const block of evt.message.content) {
                            if (block.type === 'text' && block.text) {
                                compactSummary += block.text;
                            }
                        }
                    }
                    // Also capture from stream events
                    if (evt.type === 'stream_event' && evt.event) {
                        const se = evt.event;
                        if (se.type === 'content_block_delta' && se.delta && se.delta.type === 'text_delta') {
                            compactSummary += se.delta.text;
                        }
                    }
                    // Result fallback
                    if (evt.type === 'result' && evt.result && !compactSummary) {
                        compactSummary = typeof evt.result === 'string' ? evt.result : '';
                    }
                }
            });

            let stderrBuf = '';
            child.stderr.on('data', (c) => { stderrBuf += c.toString('utf8'); });

            await new Promise((resolve, reject) => {
                child.on('close', (code) => {
                    // Process remaining buffer
                    if (buf.trim()) {
                        try {
                            const e = JSON.parse(buf);
                            if (e.type === 'system' && e.subtype === 'compact_boundary') {
                                compactMetadata = e.compact_metadata || {};
                            }
                            if (!compactSummary && e.result) compactSummary = typeof e.result === 'string' ? e.result : '';
                        } catch (_) {}
                    }
                    if (code !== 0 && !compactMetadata) {
                        reject(new Error(stderrBuf || 'Engine compact failed with exit code ' + code));
                    } else {
                        resolve();
                    }
                });
                child.on('error', reject);
            });

            // Engine has compacted its internal session — keep all old messages
            // in local db for UI display, just append a compact boundary marker
            const tokensSaved = compactMetadata && compactMetadata.pre_tokens
                ? Math.round(compactMetadata.pre_tokens * 0.7)
                : Math.round(messagesBeforeCompact * 500); // rough estimate

            db.messages.push({
                id: uuidv4(),
                conversation_id: req.params.id,
                role: 'system',
                content: JSON.stringify([{ type: 'text', text: compactSummary || 'Conversation compacted.' }]),
                created_at: new Date().toISOString(),
                is_compact_boundary: true,
            });
            saveDb();

            console.log(`[Compact] Done: ${messagesBeforeCompact} messages compacted, ~${tokensSaved} tokens saved`);
            res.json({ summary: compactSummary || 'Conversation compacted.', tokensSaved, messagesCompacted: messagesBeforeCompact });
        } catch (err) {
            console.error('[Compact] Error:', err);
            res.status(500).json({ error: err.message || 'Compaction failed' });
        }
    });

    // AskUserQuestion — receive user's answer and write back to engine stdin
    server.post('/api/conversations/:id/answer', (req, res) => {
        const { request_id, tool_use_id, answers } = req.body;
        const child = activeChildren.get(req.params.id);
        if (!child) return res.status(404).json({ error: 'No active engine process' });
        if (!request_id) return res.status(400).json({ error: 'Missing request_id' });

        // Merge user answers into the original tool input so engine sees them
        const originalInput = askUserPendingInputs.get(req.params.id) || {};
        askUserPendingInputs.delete(req.params.id);

        const controlResponse = JSON.stringify({
            type: 'control_response',
            response: {
                subtype: 'success',
                request_id: request_id,
                response: {
                    toolUseID: tool_use_id || '',
                    behavior: 'allow',
                    updatedInput: { ...originalInput, answers: answers || {} },
                }
            }
        }) + '\n';

        try {
            child.stdin.write(controlResponse);
            console.log('[AskUser] Answered request_id=' + request_id, JSON.stringify(answers || {}).slice(0, 200));
            res.json({ ok: true });
        } catch (err) {
            console.error('[AskUser] Write error:', err.message);
            res.status(500).json({ error: 'Failed to write to engine stdin' });
        }
    });

    // Stream status — check if a conversation has an active engine stream
    server.get('/api/conversations/:id/stream-status', (req, res) => {
        const stream = activeStreams.get(req.params.id);
        res.json({ active: !!(stream && !stream.done), eventCount: stream ? stream.events.length : 0 });
    });

    // Reconnect to an active stream — sends all buffered events then continues live
    server.get('/api/conversations/:id/reconnect', (req, res) => {
        const stream = activeStreams.get(req.params.id);
        if (!stream) return res.status(404).json({ error: 'No active stream' });

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
        });

        // Send all buffered events
        for (const event of stream.events) {
            res.write('data: ' + JSON.stringify(event) + '\n\n');
        }

        if (stream.done) {
            res.write('data: [DONE]\n\n');
            res.end();
            return;
        }

        // Add to listeners for future events
        stream.listeners.add(res);
        req.on('close', () => stream.listeners.delete(res));
    });

    // ===== Provider CRUD =====
    server.get('/api/providers', (req, res) => {
        res.json(providers);
    });
    server.post('/api/providers', (req, res) => {
        const p = req.body;
        p.id = uuidv4();
        if (!p.name) return res.status(400).json({ error: 'Missing name' });
        if (!p.models) p.models = [];
        if (p.enabled === undefined) p.enabled = true;
        if (p.baseUrl) p.baseUrl = normalizeBaseUrl(p.baseUrl);
        providers.push(p);
        saveProviders();
        res.json(p);
    });
    server.patch('/api/providers/:id', (req, res) => {
        const p = providers.find(x => x.id === req.params.id);
        if (!p) return res.status(404).json({ error: 'Not found' });
        if (req.body.baseUrl) req.body.baseUrl = normalizeBaseUrl(req.body.baseUrl);
        Object.assign(p, req.body);
        delete p._id; // prevent duplication
        saveProviders();
        // Kill all engines so they pick up new provider settings on next request
        for (const [id] of enginePool) killEngine(id);
        res.json(p);
    });
    server.delete('/api/providers/:id', (req, res) => {
        providers = providers.filter(x => x.id !== req.params.id);
        saveProviders();
        for (const [id] of enginePool) killEngine(id);
        res.json({ ok: true });
    });
    // Get all available models across all enabled providers
    server.get('/api/providers/models', (req, res) => {
        const models = [];
        for (const p of providers) {
            if (!p.enabled) continue;
            for (const m of (p.models || [])) {
                if (m.enabled === false) continue;
                models.push({ id: m.id, name: m.name || m.id, providerId: p.id, providerName: p.name });
            }
        }
        res.json(models);
    });

    // Workspace config
    server.get('/api/workspace-config', (req, res) => {
        res.json({ workspacesDir, defaultDir: defaultWorkspacesDir });
    });
    server.post('/api/workspace-config', (req, res) => {
        const { dir } = req.body;
        if (!dir) return res.status(400).json({ error: 'Missing dir' });
        try {
            const settingsPath = path.join(userDataPath, 'workspace-config.json');
            fs.writeFileSync(settingsPath, JSON.stringify({ workspacesDir: dir }));
            res.json({ ok: true, dir });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ===== Skills =====
    // Paths — userSkillsDir matches engine's skill loading path (~/.claude/skills/)
    const bundledSkillsDir = path.join(__dirname, 'skills');
    const homeDir = os.homedir();
    const localSkillsDir = path.join(homeDir, '.agents', 'skills');
    const userSkillsDir = path.join(homeDir, '.claude', 'skills');
    const skillPrefsPath = path.join(userDataPath, 'skill-preferences.json');

    if (!fs.existsSync(userSkillsDir)) {
        fs.mkdirSync(userSkillsDir, { recursive: true });
    }

    // Sync bundled skills to ~/.claude/skills/ so the engine can find them
    // Only copies skills that don't already exist (won't overwrite user modifications)
    if (fs.existsSync(bundledSkillsDir)) {
        try {
            const bundledEntries = fs.readdirSync(bundledSkillsDir, { withFileTypes: true });
            for (const entry of bundledEntries) {
                if (!entry.isDirectory()) continue;
                const target = path.join(userSkillsDir, entry.name);
                if (!fs.existsSync(target)) {
                    // Copy entire skill directory
                    const copyDirSync = (src, dest) => {
                        fs.mkdirSync(dest, { recursive: true });
                        for (const item of fs.readdirSync(src, { withFileTypes: true })) {
                            const s = path.join(src, item.name);
                            const d = path.join(dest, item.name);
                            if (item.isDirectory()) copyDirSync(s, d);
                            else fs.copyFileSync(s, d);
                        }
                    };
                    copyDirSync(path.join(bundledSkillsDir, entry.name), target);
                    console.log('[Skills] Synced bundled skill to ~/.claude/skills/:', entry.name);
                }
            }
        } catch (e) { console.error('[Skills] Sync error:', e.message); }
    }

    // Load / save skill preferences (enabled/disabled per skill id)
    function loadSkillPrefs() {
        if (fs.existsSync(skillPrefsPath)) {
            try { return JSON.parse(fs.readFileSync(skillPrefsPath, 'utf8')); } catch (e) { }
        }
        return {};
    }
    function saveSkillPrefs(prefs) {
        fs.writeFileSync(skillPrefsPath, JSON.stringify(prefs, null, 2));
    }

    // Parse SKILL.md frontmatter
    function parseSkillMd(content) {
        const match = content.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
        if (!match) return null;
        const fm = match[1];
        const body = match[2].trim();
        const nameMatch = fm.match(/^name:\s*(.+)$/m);
        const descMatch = fm.match(/^description:\s*(.+)$/m);
        return {
            name: nameMatch ? nameMatch[1].trim() : null,
            description: descMatch ? descMatch[1].trim() : '',
            content: body
        };
    }

    // Recursively list files in a skill directory as a tree
    function scanSkillFiles(dirPath) {
        const result = [];
        if (!fs.existsSync(dirPath)) return result;
        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true })
                .filter(e => !e.name.startsWith('.'))
                .sort((a, b) => {
                    if (a.isDirectory() && !b.isDirectory()) return -1;
                    if (!a.isDirectory() && b.isDirectory()) return 1;
                    // SKILL.md always first among files
                    if (a.name === 'SKILL.md') return -1;
                    if (b.name === 'SKILL.md') return 1;
                    return a.name.localeCompare(b.name);
                });
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const children = scanSkillFiles(path.join(dirPath, entry.name));
                    result.push({ name: entry.name, type: 'folder', children });
                } else {
                    result.push({ name: entry.name, type: 'file' });
                }
            }
        } catch (_) {}
        return result;
    }

    // Scan a directory for skill folders (each containing SKILL.md)
    function scanSkillsDir(dir, source) {
        const skills = [];
        if (!fs.existsSync(dir)) return skills;
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const mdPath = path.join(dir, entry.name, 'SKILL.md');
                if (!fs.existsSync(mdPath)) continue;
                try {
                    const raw = fs.readFileSync(mdPath, 'utf8');
                    const parsed = parseSkillMd(raw);
                    if (!parsed) continue;
                    skills.push({
                        id: `${source}:${entry.name}`,
                        name: parsed.name || entry.name,
                        description: parsed.description,
                        content: parsed.content,
                        is_example: true,
                        source_dir: entry.name,
                        source: source,
                        user_id: null,
                        created_at: null
                    });
                } catch (e) { /* skip unreadable */ }
            }
        } catch (e) { /* dir not readable */ }
        return skills;
    }

    // Load user-created skills from ~/.claude/skills/ (standard SKILL.md format)
    function loadUserSkills() {
        return scanSkillsDir(userSkillsDir, 'user').map(s => ({ ...s, is_example: false }));
    }

    // GET /api/skills — list all skills
    server.get('/api/skills', (req, res) => {
        const prefs = loadSkillPrefs();

        // 1) Bundled example skills
        const bundled = scanSkillsDir(bundledSkillsDir, 'bundled');
        // 2) Local ~/.agents/skills/
        const local = scanSkillsDir(localSkillsDir, 'local');
        // Combine examples, deduplicate by name (bundled takes priority)
        const seenNames = new Set();
        const allExamples = [];
        for (const s of bundled) {
            seenNames.add(s.name);
            allExamples.push({ ...s, enabled: prefs[s.id] !== undefined ? prefs[s.id] : true });
        }
        for (const s of local) {
            if (seenNames.has(s.name)) continue;
            seenNames.add(s.name);
            allExamples.push({ ...s, enabled: prefs[s.id] !== undefined ? prefs[s.id] : true });
        }

        // 3) User-created skills
        const userSkills = loadUserSkills().map(s => ({
            ...s,
            enabled: prefs[s.id] !== undefined ? prefs[s.id] : true
        }));

        // Strip content from list response (only return on detail)
        const stripContent = (s) => {
            const { content, ...rest } = s;
            return rest;
        };

        res.json({
            examples: allExamples.map(stripContent),
            my_skills: userSkills.map(stripContent)
        });
    });

    // GET /api/skills/:id — skill detail with content
    server.get('/api/skills/:id', (req, res) => {
        const { id } = req.params;
        const prefs = loadSkillPrefs();

        // Check bundled
        const bundled = scanSkillsDir(bundledSkillsDir, 'bundled');
        const local = scanSkillsDir(localSkillsDir, 'local');
        const allExamples = [...bundled, ...local];
        const example = allExamples.find(s => s.id === id);
        if (example) {
            // Resolve the skill's directory and scan its files
            const baseDir = example.source === 'bundled' ? bundledSkillsDir : localSkillsDir;
            const skillDir = path.join(baseDir, example.source_dir);
            const files = scanSkillFiles(skillDir);
            return res.json({ ...example, enabled: prefs[id] !== undefined ? prefs[id] : true, files, dir_path: skillDir });
        }

        // Check user skills (~/.claude/skills/)
        const userSkills = loadUserSkills();
        const userSkill = userSkills.find(s => s.id === id);
        if (userSkill) {
            const skillDir = path.join(userSkillsDir, userSkill.source_dir);
            const files = scanSkillFiles(skillDir);
            return res.json({ ...userSkill, enabled: prefs[id] !== undefined ? prefs[id] : true, files, dir_path: skillDir });
        }

        res.status(404).json({ error: 'Skill not found' });
    });

    // GET /api/skills/:id/file — get content of a specific file within a skill
    server.get('/api/skills/:id/file', (req, res) => {
        const { id } = req.params;
        const filePath = req.query.path;
        if (!filePath) return res.status(400).json({ error: 'path query param required' });

        // Find skill directory (bundled, local, or user)
        const bundled = scanSkillsDir(bundledSkillsDir, 'bundled');
        const local = scanSkillsDir(localSkillsDir, 'local');
        const user = loadUserSkills();
        const skill = [...bundled, ...local, ...user].find(s => s.id === id);
        if (!skill) return res.status(404).json({ error: 'Skill not found' });

        const baseDirMap = { 'bundled': bundledSkillsDir, 'local': localSkillsDir, 'user': userSkillsDir };
        const baseDir = baseDirMap[skill.source] || userSkillsDir;
        const fullPath = path.join(baseDir, skill.source_dir, filePath);

        // Security: ensure path is within skill directory
        const resolved = path.resolve(fullPath);
        const skillRoot = path.resolve(path.join(baseDir, skill.source_dir));
        if (!resolved.startsWith(skillRoot)) return res.status(403).json({ error: 'Access denied' });

        if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'File not found' });
        try {
            const content = fs.readFileSync(resolved, 'utf8');
            res.json({ content, path: filePath });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /api/skills — create user skill as ~/.claude/skills/skill-name/SKILL.md
    server.post('/api/skills', (req, res) => {
        const { name, description, content } = req.body;
        if (!name) return res.status(400).json({ error: 'Name is required' });

        // Convert name to directory-safe slug
        const slug = name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '') || 'skill-' + Date.now();
        const skillDir = path.join(userSkillsDir, slug);
        if (fs.existsSync(skillDir)) {
            return res.status(409).json({ error: 'Skill with this name already exists' });
        }

        fs.mkdirSync(skillDir, { recursive: true });
        const frontmatter = `---\nname: ${name}\ndescription: ${description || ''}\n---\n\n${content || ''}`;
        fs.writeFileSync(path.join(skillDir, 'SKILL.md'), frontmatter);

        const id = `user:${slug}`;
        const prefs = loadSkillPrefs();
        prefs[id] = true;
        saveSkillPrefs(prefs);

        res.json({ id, name, description: description || '', content: content || '', is_example: false, source_dir: slug, source: 'user', enabled: true });
    });

    // PATCH /api/skills/:id — update user skill (writes SKILL.md)
    server.patch('/api/skills/:id', (req, res) => {
        const { id } = req.params;
        // Only user skills (source=user) are editable
        const userSkills = loadUserSkills();
        const skill = userSkills.find(s => s.id === id);
        if (!skill || !skill.source_dir) {
            return res.status(404).json({ error: 'Skill not found or not editable' });
        }
        try {
            const name = req.body.name !== undefined ? req.body.name : skill.name;
            const description = req.body.description !== undefined ? req.body.description : skill.description;
            const content = req.body.content !== undefined ? req.body.content : skill.content;
            const frontmatter = `---\nname: ${name}\ndescription: ${description || ''}\n---\n\n${content || ''}`;
            fs.writeFileSync(path.join(userSkillsDir, skill.source_dir, 'SKILL.md'), frontmatter);

            const prefs = loadSkillPrefs();
            res.json({ ...skill, name, description, content, enabled: prefs[id] !== undefined ? prefs[id] : true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // DELETE /api/skills/:id — delete user skill (removes directory)
    server.delete('/api/skills/:id', (req, res) => {
        const { id } = req.params;
        const userSkills = loadUserSkills();
        const skill = userSkills.find(s => s.id === id);
        if (!skill || !skill.source_dir) {
            return res.status(404).json({ error: 'Skill not found' });
        }
        const skillDir = path.join(userSkillsDir, skill.source_dir);
        if (fs.existsSync(skillDir)) {
            fs.rmSync(skillDir, { recursive: true, force: true });
        }
        const prefs = loadSkillPrefs();
        delete prefs[id];
        saveSkillPrefs(prefs);
        res.json({ ok: true });
    });

    // PATCH /api/skills/:id/toggle — toggle enabled state
    server.patch('/api/skills/:id/toggle', (req, res) => {
        const { id } = req.params;
        const { enabled } = req.body;
        const prefs = loadSkillPrefs();
        prefs[id] = !!enabled;
        saveSkillPrefs(prefs);
        res.json({ ok: true, enabled: !!enabled });
    });

    // Get all enabled skills with full content (for UseSkill tool)
    function getAllEnabledSkills() {
        const prefs = loadSkillPrefs();
        const enabledIds = Object.keys(prefs).filter(id => prefs[id]);
        if (enabledIds.length === 0) return [];
        const allSkills = [
            ...scanSkillsDir(bundledSkillsDir, 'bundled'),
            ...scanSkillsDir(localSkillsDir, 'local'),
            ...loadUserSkills()
        ];
        return allSkills.filter(s => enabledIds.includes(s.id));
    }

    // Build lightweight skills index for system prompt (names + descriptions only)
    function getEnabledSkillsBlock() {
        const prefs = loadSkillPrefs();
        const enabledIds = Object.keys(prefs).filter(id => prefs[id]);
        console.log(`[Skills] Prefs:`, JSON.stringify(prefs), `Enabled IDs:`, enabledIds);
        if (enabledIds.length === 0) return '';

        const allSkills = [
            ...scanSkillsDir(bundledSkillsDir, 'bundled'),
            ...scanSkillsDir(localSkillsDir, 'local'),
            ...loadUserSkills()
        ];

        console.log(`[Skills] All scanned:`, allSkills.map(s => s.id));
        const enabled = allSkills.filter(s => enabledIds.includes(s.id));
        console.log(`[Skills] Matched enabled:`, enabled.map(s => s.id));
        if (enabled.length === 0) return '';

        // Only inject skill INDEX (name + description) into system prompt.
        // Full content is loaded on demand via the UseSkill tool.
        let block = `<available_skills>
You have the following skills available. When a user's request matches a skill's description, you MUST use it by calling the UseSkill tool with the skill name to load its full instructions, then follow those instructions precisely.

`;
        for (const s of enabled) {
            block += `- **${s.name}**: ${s.description}\n`;
        }
        block += `\nTo use a skill, call the UseSkill tool with the skill name. The tool will return the full skill instructions for you to follow.\n</available_skills>`;
        console.log(`[Skills] ${enabled.length} skill(s) indexed in system prompt`);
        return block;
    }

    // ═══════════════════════════════════════════════════════════════
    //  GITHUB CONNECTOR — OAuth + API
    // ═══════════════════════════════════════════════════════════════

    // GitHub OAuth App credentials (register at https://github.com/settings/developers)
    // Callback URL must be: http://127.0.0.1:30080/api/github/callback
    const GITHUB_CLIENT_ID = 'Ov23liWiTL6v74GsI2U7';
    const GITHUB_CLIENT_SECRET = 'c3ee401a631d77a4ceebe33e68765d02ddccc36c';
    const GITHUB_REDIRECT_URI = 'http://127.0.0.1:30080/api/github/callback';

    // Persistent storage for GitHub token
    const githubTokenPath = path.join(userDataPath, 'github-token.json');
    function loadGithubToken() {
        try {
            if (fs.existsSync(githubTokenPath)) return JSON.parse(fs.readFileSync(githubTokenPath, 'utf8'));
        } catch (_) {}
        return null;
    }
    function saveGithubToken(data) {
        fs.writeFileSync(githubTokenPath, JSON.stringify(data, null, 2));
    }
    function clearGithubToken() {
        try { fs.unlinkSync(githubTokenPath); } catch (_) {}
    }

    // GET /api/github/status — check connection status
    server.get('/api/github/status', async (req, res) => {
        const token = loadGithubToken();
        if (!token || !token.access_token) return res.json({ connected: false });
        // Return cached user info without verifying every time (saves API calls)
        if (token.login) {
            return res.json({ connected: true, user: { login: token.login, avatar_url: token.avatar_url, name: token.name } });
        }
        res.json({ connected: false });
    });

    // GET /api/github/auth-url — return OAuth authorize URL
    server.get('/api/github/auth-url', (req, res) => {
        const state = require('crypto').randomBytes(16).toString('hex');
        const url = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&redirect_uri=${encodeURIComponent(GITHUB_REDIRECT_URI)}&scope=repo,read:user&state=${state}`;
        res.json({ url, state });
    });

    // GET /api/github/callback — OAuth callback, exchange code for token
    server.get('/api/github/callback', async (req, res) => {
        const { code } = req.query;
        if (!code) return res.status(400).send('Missing code');
        try {
            // Use https module for better compatibility (avoids fetch issues in some Electron/Node environments)
            const tokenData = await new Promise((resolve, reject) => {
                const postData = JSON.stringify({ client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET, code, redirect_uri: GITHUB_REDIRECT_URI });
                const https = require('https');
                const tokenReq = https.request({
                    hostname: 'github.com', path: '/login/oauth/access_token', method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Content-Length': Buffer.byteLength(postData), 'User-Agent': 'ClaudeDesktop' }
                }, (tokenRes) => {
                    let body = '';
                    tokenRes.on('data', c => body += c);
                    tokenRes.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('Invalid JSON: ' + body.slice(0, 200))); } });
                });
                tokenReq.on('error', reject);
                tokenReq.write(postData);
                tokenReq.end();
            });

            if (tokenData.access_token) {
                // Fetch user info
                const user = await new Promise((resolve) => {
                    const https = require('https');
                    const userReq = https.request({
                        hostname: 'api.github.com', path: '/user', method: 'GET',
                        headers: { 'Authorization': `Bearer ${tokenData.access_token}`, 'User-Agent': 'ClaudeDesktop' }
                    }, (userRes) => {
                        let body = '';
                        userRes.on('data', c => body += c);
                        userRes.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
                    });
                    userReq.on('error', () => resolve({}));
                    userReq.end();
                });
                saveGithubToken({ access_token: tokenData.access_token, login: user.login, avatar_url: user.avatar_url, name: user.name });
                console.log('[GitHub] Connected as', user.login);
                res.send(`<!DOCTYPE html><html><head><title>Connected</title><style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#1a1a1a;color:#fff}div{text-align:center}h2{margin-bottom:8px}</style></head><body><div><h2>GitHub Connected!</h2><p>You can close this window.</p><script>setTimeout(()=>window.close(),1500)</script></div></body></html>`);
            } else {
                console.error('[GitHub] Token error:', tokenData);
                res.status(400).send(`OAuth error: ${tokenData.error_description || tokenData.error || 'Unknown error'}`);
            }
        } catch (e) {
            console.error('[GitHub] Callback error:', e);
            res.status(500).send(`Error: ${e.message}`);
        }
    });

    // POST /api/github/disconnect — remove saved token
    server.post('/api/github/disconnect', (req, res) => {
        clearGithubToken();
        res.json({ ok: true });
    });

    // Helper: make GitHub API request using https module
    function githubApiRequest(path, token) {
        return new Promise((resolve, reject) => {
            const https = require('https');
            const req = https.request({
                hostname: 'api.github.com', path, method: 'GET',
                headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'ClaudeDesktop' }
            }, (resp) => {
                let body = '';
                resp.on('data', c => body += c);
                resp.on('end', () => {
                    try { resolve({ status: resp.statusCode, data: JSON.parse(body) }); }
                    catch { reject(new Error('Invalid JSON')); }
                });
            });
            req.on('error', reject);
            req.end();
        });
    }

    // GET /api/github/repos — list user repos
    server.get('/api/github/repos', async (req, res) => {
        const token = loadGithubToken();
        if (!token?.access_token) return res.status(401).json({ error: 'Not connected' });
        try {
            const page = req.query.page || 1;
            const { status, data } = await githubApiRequest(`/user/repos?sort=updated&per_page=30&page=${page}`, token.access_token);
            if (status !== 200) return res.status(status).json({ error: 'GitHub API error' });
            res.json(data.map(r => ({ id: r.id, name: r.name, full_name: r.full_name, description: r.description, private: r.private, html_url: r.html_url, language: r.language, updated_at: r.updated_at })));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // GET /api/github/repos/:owner/:repo/contents — browse repo contents
    server.get('/api/github/repos/:owner/:repo/contents', async (req, res) => {
        const token = loadGithubToken();
        if (!token?.access_token) return res.status(401).json({ error: 'Not connected' });
        try {
            const filePath = req.query.path || '';
            const ref = req.query.ref || '';
            let apiPath = `/repos/${req.params.owner}/${req.params.repo}/contents/${filePath}`;
            if (ref) apiPath += `?ref=${encodeURIComponent(ref)}`;
            const { status, data } = await githubApiRequest(apiPath, token.access_token);
            if (status !== 200) return res.status(status).json({ error: 'GitHub API error' });
            res.json(data);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // GET /api/github/search — search code across repos
    server.get('/api/github/search', async (req, res) => {
        const token = loadGithubToken();
        if (!token?.access_token) return res.status(401).json({ error: 'Not connected' });
        try {
            const q = encodeURIComponent(req.query.q || '');
            const { status, data } = await githubApiRequest(`/search/code?q=${q}&per_page=20`, token.access_token);
            if (status !== 200) return res.status(status).json({ error: 'GitHub API error' });
            res.json(data);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ═══════════════════════════════════════════════════════════════
    //  CHAT ENDPOINT — Claude Code Engine via Bun CLI subprocess
    // ═══════════════════════════════════════════════════════════════

    const { spawn } = require('child_process');

    // Resolve engine path — in packaged app, engine is in resources/engine
    const isPacked = app.isPackaged;
    const engineDir = isPacked
        ? path.join(process.resourcesPath, 'engine')
        : path.join(__dirname, '..', 'engine');
    const engineCli = path.join(engineDir, 'src', 'entrypoints', 'cli.tsx');
    const engineEnv = path.join(engineDir, '.env');

    // Resolve Bun executable: bundled → user-installed → PATH
    function findBunExe() {
        const bundled = path.join(engineDir, 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun');
        if (fs.existsSync(bundled)) return bundled;
        const userInstalled = process.platform === 'win32'
            ? path.join(os.homedir(), '.bun', 'bin', 'bun.exe')
            : path.join(os.homedir(), '.bun', 'bin', 'bun');
        if (fs.existsSync(userInstalled)) return userInstalled;
        return 'bun'; // fallback to PATH
    }
    const bunExePath = findBunExe();
    console.log('[Engine] Bun:', bunExePath, 'exists:', fs.existsSync(bunExePath));

    // Load engine .env so bridge-server can use the same API config (for vision direct API calls)
    const engineEnvVars = {};
    try {
        const envContent = fs.readFileSync(engineEnv, 'utf8');
        for (const line of envContent.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx > 0) engineEnvVars[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
        }
        console.log('[Engine] Loaded .env:', Object.keys(engineEnvVars).join(', '));
    } catch (_) {}
    const enginePreload = path.join(engineDir, 'preload.ts');

    // Helper: stream one API round, returns parsed response
    async function streamApiRound(endpoint, apiKey, model, systemPrompt, messages, tools, thinkingEnabled, sendSSE) {
        console.log(`[API] model=${model} thinking=${thinkingEnabled} systemPrompt=${systemPrompt ? systemPrompt.length + ' chars' : 'NONE'} messages=${messages.length} tools=${tools.length}`);
        const body = {
            model,
            system: systemPrompt || undefined,
            messages,
            tools: tools.length > 0 ? tools : undefined,
            max_tokens: thinkingEnabled ? 16000 : 8192,
            stream: true,
        };
        if (thinkingEnabled) {
            body.thinking = { type: 'enabled', budget_tokens: 10000 };
        }

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            let errMsg = `API Error ${response.status}`;
            try { const j = JSON.parse(errText); errMsg = j.error?.message || j.error || errMsg; } catch { if (errText) errMsg += `: ${errText.slice(0, 300)}`; }
            throw new Error(errMsg);
        }

        // Parse SSE stream
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let sseBuffer = '';
        let assistantText = '';
        let thinkingText = '';
        const contentBlocks = []; // accumulate full content blocks
        const blockAccumulators = {}; // index → { type, data }
        let stopReason = null;
        let usage = {};

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            sseBuffer += decoder.decode(value, { stream: true });
            const lines = sseBuffer.split('\n');
            sseBuffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') continue;

                let parsed;
                try { parsed = JSON.parse(data); } catch { continue; }

                switch (parsed.type) {
                    case 'content_block_start': {
                        const idx = parsed.index;
                        const block = parsed.content_block;
                        if (block.type === 'text') {
                            blockAccumulators[idx] = { type: 'text', text: '' };
                        } else if (block.type === 'thinking') {
                            blockAccumulators[idx] = { type: 'thinking', thinking: '' };
                        } else if (block.type === 'tool_use') {
                            blockAccumulators[idx] = { type: 'tool_use', id: block.id, name: block.name, inputJson: '' };
                        }
                        break;
                    }
                    case 'content_block_delta': {
                        const idx = parsed.index;
                        const delta = parsed.delta;
                        const acc = blockAccumulators[idx];
                        if (!acc) break;

                        if (delta.type === 'text_delta' && delta.text) {
                            acc.text += delta.text;
                            assistantText += delta.text;
                            // Forward to frontend — REAL streaming!
                            sendSSE({ type: 'content_block_delta', delta: { type: 'text_delta', text: delta.text } });
                        } else if (delta.type === 'thinking_delta' && delta.thinking) {
                            acc.thinking += delta.thinking;
                            thinkingText += delta.thinking;
                            sendSSE({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: delta.thinking } });
                        } else if (delta.type === 'input_json_delta' && delta.partial_json) {
                            acc.inputJson += delta.partial_json;
                        }
                        break;
                    }
                    case 'content_block_stop': {
                        const idx = parsed.index;
                        const acc = blockAccumulators[idx];
                        if (!acc) break;

                        if (acc.type === 'text') {
                            contentBlocks.push({ type: 'text', text: acc.text });
                        } else if (acc.type === 'thinking') {
                            contentBlocks.push({ type: 'thinking', thinking: acc.thinking });
                        } else if (acc.type === 'tool_use') {
                            let input = {};
                            try { input = JSON.parse(acc.inputJson); } catch { }
                            contentBlocks.push({ type: 'tool_use', id: acc.id, name: acc.name, input });
                            // Notify frontend
                            sendSSE({ type: 'tool_use_start', tool_use_id: acc.id, tool_name: acc.name, tool_input: input });
                            console.log(`[Tool] ${acc.name}`, JSON.stringify(input).slice(0, 150));
                        }
                        delete blockAccumulators[idx];
                        break;
                    }
                    case 'message_delta': {
                        if (parsed.delta?.stop_reason) stopReason = parsed.delta.stop_reason;
                        if (parsed.usage) usage = { ...usage, ...parsed.usage };
                        break;
                    }
                }
            }
        }

        return { contentBlocks, assistantText, thinkingText, stopReason, usage };
    }


    // ============ PERSISTENT ENGINE POOL ============
    const MAX_ENGINE_POOL_SIZE = 3;
    const enginePool = new Map();
    const HIDDEN_TOOLS = new Set(['EnterWorktree', 'ExitWorktree', 'TodoWrite', 'WebSearch', 'WebFetch']);

    function killEngine(convId) {
        const eng = enginePool.get(convId);
        if (!eng) return;
        console.log('[EnginePool] Killing engine for', convId);
        try { eng.child.stdin.end(); } catch (_) {}
        try { eng.child.kill(); } catch (_) {}
        enginePool.delete(convId);
        activeChildren.delete(convId);
    }
    function evictOldestEngine() {
        if (enginePool.size < MAX_ENGINE_POOL_SIZE) return;
        let oldestId = null, oldestTime = Infinity;
        for (const [id, eng] of enginePool) {
            if (eng.state === 'processing') continue;
            if (eng.lastUsed < oldestTime) { oldestTime = eng.lastUsed; oldestId = id; }
        }
        if (oldestId) killEngine(oldestId);
    }
    function isEngineAlive(eng) { return eng && eng.child && !eng.child.killed && eng.child.exitCode === null; }

    function buildChatSystemPrompt(conv, user_mode, user_profile) {
        let sysPrompt = (user_mode === 'selfhosted' ? customSystemPromptClean : customSystemPromptFull) || '';
        if (user_profile) {
            const parts = [];
            if (user_profile.work_function) parts.push('Occupation: ' + user_profile.work_function);
            if (user_profile.personal_preferences) parts.push('User preferences: ' + user_profile.personal_preferences);
            if (parts.length > 0) sysPrompt += '\n\n<user_profile>\n' + parts.join('\n') + '\n</user_profile>';
        }
        if (conv.project_id) {
            const project = db.projects.find(p => p.id === conv.project_id);
            if (project) {
                if (project.instructions && project.instructions.trim()) sysPrompt += '\n\n<project_instructions>\n' + project.instructions.trim() + '\n</project_instructions>';
                const pFiles = db.project_files.filter(f => f.project_id === project.id);
                if (pFiles.length > 0) {
                    // Copy project files to workspace so the engine can read them with tools
                    for (const pf of pFiles) {
                        const destPath = path.join(conv.workspace_path, pf.file_name);
                        if (!fs.existsSync(destPath)) {
                            // Prefer original file on disk; fall back to extracted_text
                            if (pf.file_path && fs.existsSync(pf.file_path)) {
                                try { fs.copyFileSync(pf.file_path, destPath); } catch (_) {}
                            } else if (pf.extracted_text) {
                                try { fs.writeFileSync(destPath, pf.extracted_text, 'utf8'); } catch (_) {}
                            }
                        }
                    }
                    // Only list filenames in the prompt — model reads files on-demand via Read tool
                    const textExts = ['.txt', '.md', '.json', '.xml', '.yaml', '.yml', '.csv', '.html', '.css', '.js', '.ts', '.tsx', '.jsx', '.py', '.java', '.c', '.cpp', '.h', '.go', '.rs', '.rb', '.php', '.sql', '.sh', '.lua', '.r'];
                    let c = '\n\n<project_knowledge_base>\nThe following project files are available in the workspace. Read them when needed:\n';
                    for (const pf of pFiles) {
                        const ext = path.extname(pf.file_name).toLowerCase();
                        const isText = textExts.includes(ext);
                        c += '- ./' + pf.file_name + ' (' + Math.round((pf.file_size || 0) / 1024) + ' KB' + (isText ? '' : ', binary') + ')\n';
                    }
                    sysPrompt += c + '</project_knowledge_base>';
                }
            }
        }
        return sysPrompt;
    }
    function resolveChatConfig(conv, user_mode, env_token, env_base_url) {
        const rawModel = conv.model || 'claude-sonnet-4-6';
        const modelId = rawModel.replace(/-thinking$/, '');
        const provider = user_mode === 'selfhosted' ? resolveProvider(modelId) : null;
        let apiKey, baseUrl, apiFormat = 'anthropic';
        if (provider) { apiKey = provider.apiKey; baseUrl = provider.baseUrl; apiFormat = provider.format || 'anthropic'; console.log('[Chat] Provider:', provider.name, '| format:', apiFormat, '| model:', modelId); }
        else { const validToken = (env_token && env_token !== 'self-hosted') ? env_token : ''; apiKey = validToken || engineEnvVars.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY; baseUrl = validToken ? (env_base_url || engineEnvVars.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL) : (engineEnvVars.ANTHROPIC_BASE_URL || env_base_url || process.env.ANTHROPIC_BASE_URL); }
        return { modelId, provider, apiKey, baseUrl, apiFormat };
    }

    function handleTurnEvent(engine, convId, conv, evt) {
        const turn = engine.turn;
        if (!turn || !turn.sendSSE) return;
        const sendSSE = turn.sendSSE;
        const ensureStart = (id) => { if (!turn.sentToolStarts.has(id)) { var t = turn.toolCalls.get(id); if (t && !HIDDEN_TOOLS.has(t.name)) { turn.sentToolStarts.add(id); sendSSE({ type: 'tool_use_start', tool_use_id: t.id, tool_name: t.name, tool_input: t.input || {} }); } } };

        if (evt.type === 'stream_event' && evt.event) {
            var se = evt.event;
            if (se.type === 'content_block_delta') {
                if (se.delta && se.delta.type === 'text_delta') { turn.assistantText += se.delta.text; turn.pendingWorkText += se.delta.text; sendSSE({ type: 'content_block_delta', delta: { type: 'text_delta', text: se.delta.text } }); }
                else if (se.delta && se.delta.type === 'thinking_delta') { turn.thinkingText += se.delta.thinking; sendSSE({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: se.delta.thinking } }); }
            } else if (se.type === 'content_block_start' && se.content_block && se.content_block.type === 'tool_use') {
                var tu = se.content_block; turn.toolCalls.set(tu.id, { id: tu.id, name: tu.name, input: {}, status: 'running', textBefore: turn.pendingWorkText.trim() }); turn.toolCallOrder.push(tu.id); turn.pendingWorkText = '';
            }
        }
        else if (evt.type === 'assistant' && evt.message && evt.message.content) {
            for (var block of evt.message.content) {
                if (block.type !== 'tool_use') continue;
                var tc = turn.toolCalls.get(block.id);
                if (tc) { tc.input = block.input; } else { tc = { id: block.id, name: block.name, input: block.input, status: 'running', textBefore: turn.pendingWorkText.trim() }; turn.toolCalls.set(block.id, tc); turn.toolCallOrder.push(block.id); turn.pendingWorkText = ''; }
                if (block.name === 'WebSearch' && !turn.sentToolStarts.has(block.id)) { turn.sentToolStarts.add(block.id); sendSSE({ type: 'status', message: 'Searching: ' + ((block.input && block.input.query) || 'the web') }); }
                else if (block.name === 'WebFetch' && !turn.sentToolStarts.has(block.id)) { turn.sentToolStarts.add(block.id); sendSSE({ type: 'status', message: 'Fetching: ' + ((block.input && block.input.url) || '') }); }
                else if (!turn.sentToolStarts.has(block.id) && !HIDDEN_TOOLS.has(block.name)) { turn.sentToolStarts.add(block.id); sendSSE({ type: 'tool_use_start', tool_use_id: block.id, tool_name: block.name, tool_input: block.input }); console.log('[Tool]', block.name, JSON.stringify(block.input || {}).slice(0, 120)); }
            }
        }
        else if (evt.type === 'user' && evt.message && evt.message.content) {
            var contentArr = Array.isArray(evt.message.content) ? evt.message.content : [];
            for (var ci = 0; ci < contentArr.length; ci++) {
                var cb = contentArr[ci]; if (cb.type !== 'tool_result' || !cb.tool_use_id) continue;
                var tc3 = turn.toolCalls.get(cb.tool_use_id), tn = tc3 ? tc3.name : '';
                var trText = ''; if (typeof cb.content === 'string') trText = cb.content; else if (Array.isArray(cb.content)) trText = cb.content.map(function(x) { return x.text || ''; }).join('');
                if (tc3) { tc3.status = cb.is_error ? 'error' : 'done'; tc3.result = trText; }
                turn.lastToolDoneTextLen = turn.assistantText.length;
                if (tn === 'WebSearch' && trText) { try { var wsQ = ''; var qM = trText.match(/query:\s*"([^"]+)"/); if (qM) wsQ = qM[1]; var wsS = []; var lM = trText.match(/Links:\s*(\[[\s\S]*?\])\s*\n/); if (lM) { try { var lnk = JSON.parse(lM[1]); if (Array.isArray(lnk)) wsS = lnk.filter(function(l){return l.url;}).map(function(l){return {url:l.url,title:l.title||''};}); } catch(_){} } if (wsS.length>0&&wsQ) { sendSSE({type:'search_sources',sources:wsS,query:wsQ}); turn.searchLogs.push({query:wsQ,results:wsS}); } } catch(_){} }
                if (!HIDDEN_TOOLS.has(tn)) { ensureStart(cb.tool_use_id); sendSSE({ type: 'tool_use_done', tool_use_id: cb.tool_use_id, content: trText.slice(0, 50000), is_error: cb.is_error || false }); }
            }
        }
        else if (evt.type === 'tool') {
            var resultText = typeof evt.content === 'string' ? evt.content : Array.isArray(evt.content) ? evt.content.map(function(b){return b.text||'';}).join('') : '';
            var tc2 = turn.toolCalls.get(evt.tool_use_id), toolName = tc2 ? tc2.name : '';
            if (tc2) { tc2.status = evt.is_error ? 'error' : 'done'; tc2.result = resultText; }
            if (toolName === 'WebSearch' && resultText) { try { var qm2=resultText.match(/query:\s*"([^"]+)"/); var lm2=resultText.match(/Links:\s*(\[[\s\S]*?\])\s*\n/); if(qm2&&lm2){var lk2=JSON.parse(lm2[1]); var sr=lk2.filter(function(l){return l.url;}).map(function(l){return{url:l.url,title:l.title||''};});if(sr.length>0)sendSSE({type:'search_sources',sources:sr,query:qm2[1]});} } catch(_){} }
            if (toolName === 'Write' && tc2 && tc2.input && tc2.input.file_path) { var prevId = turn.writtenFiles.get(tc2.input.file_path); if (prevId) turn.toolCalls.delete(prevId); turn.writtenFiles.set(tc2.input.file_path, evt.tool_use_id); }
            if (!HIDDEN_TOOLS.has(toolName)) { ensureStart(evt.tool_use_id); sendSSE({ type: 'tool_use_done', tool_use_id: evt.tool_use_id, content: resultText.slice(0, 50000), is_error: evt.is_error || false }); }
        }
        else if (evt.type === 'control_request' && evt.request) {
            var req2 = evt.request;
            if (req2.subtype === 'can_use_tool' && req2.tool_name === 'AskUserQuestion') {
                askUserPendingInputs.set(convId, req2.input || {});
                sendSSE({ type: 'ask_user', request_id: evt.request_id, tool_use_id: req2.tool_use_id, questions: (req2.input && req2.input.questions) || [] });
            } else {
                var ar = JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: evt.request_id, response: { toolUseID: req2.tool_use_id, behavior: 'allow', updatedInput: req2.input || {} } } }) + '\n';
                try { engine.child.stdin.write(ar); } catch (_) {}
            }
        }
        else if (evt.type === 'system' && (evt.subtype === 'task_started' || evt.subtype === 'task_progress' || evt.subtype === 'task_notification')) {
            sendSSE({ type: 'task_event', subtype: evt.subtype, task_id: evt.task_id, description: evt.description, status: evt.status, summary: evt.summary, usage: evt.usage, last_tool_name: evt.last_tool_name });
        }
        else if (evt.type === 'system' && evt.subtype === 'compact_boundary') {
            var meta = evt.compact_metadata || {}; sendSSE({ type: 'compact_boundary', compact_metadata: meta });
            db.messages.push({ id: uuidv4(), conversation_id: convId, role: 'system', content: JSON.stringify([{ type: 'text', text: 'Context auto-compacted by engine.' }]), created_at: new Date().toISOString(), is_compact_boundary: true }); saveDb();
        }
    }

    function finishTurn(engine, convId, conv) {
        const turn = engine.turn; if (!turn) return;
        if (turn.timeoutId) clearTimeout(turn.timeoutId);
        engine.turn = null; engine.state = 'idle';
        if (turn.assistantText || turn.thinkingText || turn.toolCalls.size > 0) {
            db.messages.push({ id: uuidv4(), conversation_id: convId, role: 'assistant', content: JSON.stringify([{ type: 'text', text: turn.assistantText }]), created_at: new Date().toISOString(), thinking: turn.thinkingText || undefined, toolCalls: turn.toolCalls.size > 0 ? turn.toolCallOrder.map(id => turn.toolCalls.get(id)).filter(Boolean) : undefined, toolTextEndOffset: (turn.toolCalls.size > 0 && turn.lastToolDoneTextLen > 0) ? turn.lastToolDoneTextLen : undefined, searchLogs: turn.searchLogs.length > 0 ? turn.searchLogs : undefined });
            saveDb();
            generateTitleAsync(convId, turn.message.slice(0, 300), turn.assistantText.slice(0, 300), turn.apiKey, turn.baseUrl, conv.model, turn.apiFormat);
        }
        if (turn.toolCalls.size > 0 && turn.lastToolDoneTextLen > 0) turn.sendSSE({ type: 'tool_text_offset', offset: turn.lastToolDoneTextLen });
        pendingImageBlocks.delete(convId);
        turn.sendSSE({ type: 'message_stop' });
        endStream(convId);
        if (turn.resolve) turn.resolve();
    }

    function spawnPersistentEngine(convId, conv, config) {
        const { modelId, apiKey, baseUrl, apiFormat, sysPrompt } = config;
        evictOldestEngine();
        const claudeDir = path.join(os.homedir(), '.claude');
        const cliArgs = ['--preload', enginePreload, '--env-file=' + engineEnv, engineCli, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'bypassPermissions', '--add-dir', claudeDir, '--model', modelId];
        if (conv.claude_session_id) cliArgs.push('--resume', conv.claude_session_id);
        if (sysPrompt) cliArgs.push('--append-system-prompt', sysPrompt);
        const envVars = Object.assign({}, process.env);
        if (apiFormat === 'openai' && proxyPort > 0) {
            proxyTarget = { apiKey, baseUrl, model: modelId, format: 'openai', conversationId: convId };
            envVars.ANTHROPIC_API_KEY = 'proxy-key'; envVars.ANTHROPIC_BASE_URL = 'http://127.0.0.1:' + proxyPort + '/v1';
            try { const warmUrl = new URL(normalizeBaseUrl(baseUrl)); require('dns').resolve4(warmUrl.hostname, () => {}); fetch(warmUrl.origin, { method: 'HEAD', signal: AbortSignal.timeout(5000) }).catch(() => {}); } catch (_) {}
            console.log('[EnginePool] OpenAI proxy, model=' + modelId);
        } else { if (apiKey) envVars.ANTHROPIC_API_KEY = apiKey; envVars.ANTHROPIC_BASE_URL = normalizeBaseUrl(baseUrl || engineEnvVars.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'); }
        console.log('[EnginePool] Spawning persistent engine, conv=' + convId + ' model=' + modelId + ' session=' + (conv.claude_session_id || 'new'));
        const { spawn } = require('child_process');
        const child = spawn(bunExePath, cliArgs, { cwd: conv.workspace_path, env: envVars, stdio: ['pipe', 'pipe', 'pipe'] });
        const engine = { child, convId, modelId, apiKey, baseUrl, apiFormat, lastUsed: Date.now(), sessionId: conv.claude_session_id, state: 'idle', buf: '', turn: null };
        activeChildren.set(convId, child);

        child.stdout.on('data', (chunk) => {
            engine.buf += chunk.toString('utf8');
            const lines = engine.buf.split('\n'); engine.buf = lines.pop() || '';
            for (const line of lines) {
                if (!line.trim()) continue; let evt; try { evt = JSON.parse(line); } catch { continue; }
                if (evt.session_id && !engine.sessionId) { engine.sessionId = evt.session_id; conv.claude_session_id = engine.sessionId; saveDb(); }
                if (evt.type !== 'stream_event') console.log('[Engine-evt]', evt.type, evt.subtype || '', evt.tool_use_id ? 'tool_id=' + evt.tool_use_id : '');
                if (evt.type === 'system' && evt.subtype === 'init') { console.log('[EnginePool] Engine init event for', convId); continue; }
                if (evt.type === 'result') { if (engine.turn) { if (!engine.turn.assistantText && evt.result) engine.turn.assistantText = typeof evt.result === 'string' ? evt.result : ''; finishTurn(engine, convId, conv); } continue; }
                if (!engine.turn) continue;
                handleTurnEvent(engine, convId, conv, evt);
            }
        });
        let stderrBuf = '';
        child.stderr.on('data', (c) => { stderrBuf += c.toString('utf8'); });
        child.on('close', (code) => {
            console.log('[EnginePool] Engine closed, code=' + code + ', conv=' + convId, stderrBuf ? '| stderr: ' + stderrBuf.slice(0, 300) : '');
            if (engine.state === 'processing' && engine.turn) {
                const turn = engine.turn;
                if (turn.sendSSE) { if (!turn.assistantText) turn.sendSSE({ type: 'error', error: stderrBuf.slice(0, 300) || 'Engine exit ' + code }); else turn.sendSSE({ type: 'content_block_delta', delta: { type: 'text_delta', text: '\n\n⚠️ Engine exited unexpectedly.' } }); turn.sendSSE({ type: 'message_stop' }); endStream(convId); }
                if (turn.resolve) turn.resolve();
            }
            enginePool.delete(convId); activeChildren.delete(convId);
        });
        child.on('error', (err) => { console.error('[EnginePool] Error:', err.message); if (engine.state === 'processing' && engine.turn && engine.turn.resolve) engine.turn.resolve(); enginePool.delete(convId); activeChildren.delete(convId); });
        enginePool.set(convId, engine);
        return engine;
    }

    // Pre-warm endpoint
    server.post('/api/conversations/:id/warm', (req, res) => {
        const convId = req.params.id;
        const existing = enginePool.get(convId);
        if (existing && isEngineAlive(existing)) { existing.lastUsed = Date.now(); return res.json({ ok: true, cached: true, state: existing.state }); }
        const conv = db.conversations.find(c => c.id === convId);
        if (!conv) return res.status(404).json({ error: 'Not found' });
        const { env_token, env_base_url, user_mode, user_profile } = req.body || {};
        const config = resolveChatConfig(conv, user_mode, env_token, env_base_url);
        const sysPrompt = buildChatSystemPrompt(conv, user_mode, user_profile);
        console.log('[EnginePool] Pre-warming engine for', convId, 'model=' + config.modelId);
        spawnPersistentEngine(convId, conv, { ...config, sysPrompt });
        res.json({ ok: true });
    });

    // Chat endpoint (persistent engine)
    server.post('/api/chat', async (req, res) => {
        const { conversation_id, message, attachments, env_token, env_base_url, user_mode, user_profile } = req.body;
        const conv = db.conversations.find(c => c.id === conversation_id);
        if (!conv) return res.status(404).json({ error: 'Conversation not found' });
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        activeStreams.set(conversation_id, { events: [], listeners: new Set(), done: false, primaryRes: res });
        const sendSSE = (data) => { var stream = activeStreams.get(conversation_id); if (stream) { stream.events.push(data); var line = 'data: ' + JSON.stringify(data) + '\n\n'; var arr = Array.from(stream.listeners); for (var i = 0; i < arr.length; i++) { try { arr[i].write(line); } catch (_) { stream.listeners.delete(arr[i]); } } } try { res.write('data: ' + JSON.stringify(data) + '\n\n'); } catch (_) {} };

        try {
            // /skill-name is passed as-is to the engine — the engine handles
            // slash commands internally (injects SKILL.md content into context).
            // Send a synthetic tool event so the frontend shows "Reading SKILL.md"
            const skillInvokeMatch = message.match(/^\/([a-zA-Z0-9_-]+)(\s|$)/);
            if (skillInvokeMatch) {
                const skillSlug = skillInvokeMatch[1];
                const fakeId = 'skill-invoke-' + Date.now();
                sendSSE({ type: 'tool_use_start', tool_use_id: fakeId, tool_name: 'Skill', tool_input: { skill: skillSlug } });
                sendSSE({ type: 'tool_use_done', tool_use_id: fakeId, content: `Reading ${skillSlug} SKILL.md`, is_error: false });
            }

            // ── 1. Handle attachments: copy to workspace, append references to prompt ──
            let finalPrompt = message;
            const imageFileNames = []; // image files copied to workspace

            if (attachments && attachments.length > 0) {
                const copiedFiles = [];
                for (const att of attachments) {
                    let srcPath = att.localPath;
                    if (!srcPath && att.fileId) {
                        for (const dir of [path.join(workspacesDir, conversation_id, '.uploads'), path.join(workspacesDir, 'temp', '.uploads')]) {
                            if (srcPath) break;
                            if (fs.existsSync(dir)) {
                                const match = fs.readdirSync(dir).find(f => f === att.fileId || f.includes(att.fileId));
                                if (match) srcPath = path.join(dir, match);
                            }
                        }
                    }
                    if (srcPath && fs.existsSync(srcPath)) {
                        const fn = att.fileName || path.basename(srcPath);
                        try { fs.copyFileSync(srcPath, path.join(conv.workspace_path, fn)); copiedFiles.push(fn); } catch (_) {}

                        // Detect images → read base64 for proxy injection
                        const ext = path.extname(fn).toLowerCase();
                        if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
                            console.log('[Chat] Image copied to workspace:', fn);
                            imageFileNames.push(fn);
                            try {
                                const imgData = fs.readFileSync(srcPath);
                                if (imgData.length > 100) {
                                    const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
                                    if (!pendingImageBlocks.has(conversation_id)) pendingImageBlocks.set(conversation_id, []);
                                    pendingImageBlocks.get(conversation_id).push({
                                        type: 'image',
                                        source: { type: 'base64', media_type: mimeMap[ext] || 'image/png', data: imgData.toString('base64') }
                                    });
                                    console.log('[Chat] Image queued for proxy injection:', fn, imgData.length, 'bytes');
                                }
                            } catch (_) {}
                        }
                    }
                }
                if (copiedFiles.length > 0) {
                    // Images are injected directly into the API request via the proxy,
                    // but we also mention them here so the model knows they exist as files.
                    if (imageFileNames.length > 0) {
                        finalPrompt += '\n\n[The user attached image(s): ' + imageFileNames.join(', ') + '. The image(s) are included in this message — you can see them directly.]';
                        const nonImages = copiedFiles.filter(f => !imageFileNames.includes(f));
                        if (nonImages.length > 0) {
                            finalPrompt += '\n[Other attached files — read only when needed:]\n';
                            for (const fn of nonImages) finalPrompt += `- ./${fn}\n`;
                        }
                    } else {
                        finalPrompt += '\n\n[Attached files in workspace — read only when needed:]\n';
                        for (const fn of copiedFiles) finalPrompt += `- ./${fn}\n`;
                    }
                }
            }

            // ── 2. Save user message ──
            db.messages.push({
                id: uuidv4(), conversation_id, role: 'user',
                content: JSON.stringify([{ type: 'text', text: message }]),
                created_at: new Date().toISOString(),
                attachments: attachments && attachments.length > 0 ? attachments.map(a => ({ fileId: a.fileId, fileName: a.fileName, fileType: a.fileType, mimeType: a.mimeType, size: a.size })) : undefined
            });
            saveDb();

            // ── 3. Get or create persistent engine ──
            const config = resolveChatConfig(conv, user_mode, env_token, env_base_url);
            let engine = enginePool.get(conversation_id);
            if (engine && (!isEngineAlive(engine) || engine.modelId !== config.modelId)) { killEngine(conversation_id); engine = null; }
            if (!engine) {
                const sysPrompt = buildChatSystemPrompt(conv, user_mode, user_profile);
                engine = spawnPersistentEngine(conversation_id, conv, { ...config, sysPrompt });
            }
            if (!isEngineAlive(engine)) throw new Error('Engine failed to start');
            if (engine.state === 'processing') {
                // Wait briefly in case the previous turn is about to finish
                await new Promise(r => setTimeout(r, 1000));
                if (engine.state === 'processing') {
                    // Previous turn is stuck — kill the engine and spawn a fresh one
                    console.warn('[Chat] Engine stuck in processing state for', conversation_id, '— killing and respawning');
                    killEngine(conversation_id);
                    engine = null;
                    const sysPrompt = buildChatSystemPrompt(conv, user_mode, user_profile);
                    engine = spawnPersistentEngine(conversation_id, conv, { ...config, sysPrompt });
                    if (!isEngineAlive(engine)) throw new Error('Engine failed to restart');
                }
            }

            // ── 4. Start new turn ──
            engine.state = 'processing';
            engine.lastUsed = Date.now();
            if (config.apiFormat === 'openai' && proxyPort > 0) {
                proxyTarget = { apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.modelId, format: 'openai', conversationId: conversation_id };
            }
            engine.turn = {
                sendSSE, assistantText: '', thinkingText: '',
                toolCalls: new Map(), toolCallOrder: [], sentToolStarts: new Set(),
                writtenFiles: new Map(), searchLogs: [],
                lastToolDoneTextLen: 0, pendingWorkText: '',
                message: message,
                apiKey: config.apiKey, baseUrl: config.baseUrl, apiFormat: config.apiFormat,
                resolve: null,
            };

            // Write user message to stdin (stream-json format)
            engine.child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: finalPrompt }, uuid: uuidv4() }) + '\n');

            // Wait for turn to complete, with a 3-minute timeout.
            // If the upstream API hangs (e.g. broken proxy), this prevents the engine
            // from being stuck in 'processing' forever.
            const TURN_TIMEOUT_MS = 3 * 60 * 1000;
            await new Promise(resolve => {
                engine.turn.resolve = resolve;
                engine.turn.timeoutId = setTimeout(() => {
                    if (engine.state === 'processing' && engine.turn) {
                        console.error('[Chat] Turn timed out after ' + (TURN_TIMEOUT_MS / 1000) + 's for', conversation_id);
                        engine.turn.sendSSE({ type: 'error', error: 'Request timed out — the API endpoint may be unresponsive. Please try again.' });
                        finishTurn(engine, conversation_id, conv);
                    }
                }, TURN_TIMEOUT_MS);
            });
            if (engine.turn && engine.turn.timeoutId) clearTimeout(engine.turn.timeoutId);
        } catch (err) {
            pendingImageBlocks.delete(conversation_id);
            console.error('[Chat] Error:', (err.message || '').slice(0, 300));
            sendSSE({ type: 'error', error: err.message || 'Engine error' });
            endStream(conversation_id);
        }
    });


    return server;
}

module.exports = { initServer, enableNodeModeForChildProcesses };
