import https from 'node:https';
import http from 'node:http';
import config from './config.js';

// ---------------------------------------------------------------------------
// Generic HTTPS JSON request
// ---------------------------------------------------------------------------
function request(url, options, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    const req = transport.request(parsed, {
      method: options.method || 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      timeout: options.timeout || 30000,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status: res.statusCode, data: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, data: raw });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Azure OpenAI
// ---------------------------------------------------------------------------
async function azureOpenaiChat(messages, { deployment, maxTokens = 300, temperature, jsonMode = false, reasoningEffort } = {}) {
  const cfg = config.get();
  const dep = deployment || cfg.azureOpenaiDeploymentChat;
  const endpoint = cfg.azureOpenaiEndpoint.replace(/\/$/, '');
  const url = `${endpoint}/openai/deployments/${dep}/chat/completions?api-version=${cfg.azureOpenaiApiVersion}`;

  // gpt-5-family mini models reject custom temperature (only accept default 1).
  // Caller may pass temperature for full models. Drop it if targeting mini.
  const isMiniModel = /mini/i.test(dep);
  const safeTemp = isMiniModel ? undefined : (temperature !== undefined ? temperature : 0.7);

  const body = {
    messages,
    max_completion_tokens: maxTokens,
  };
  if (safeTemp !== undefined) body.temperature = safeTemp;
  if (jsonMode) body.response_format = { type: 'json_object' };
  // gpt-5 family supports reasoning_effort: 'minimal' | 'low' | 'medium' | 'high'
  // 'minimal' = skip extended reasoning, fast/short responses (best for react/observe)
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;

  const res = await request(url, {
    headers: { 'api-key': cfg.azureOpenaiKey },
    timeout: 60000,
  }, body);

  if (res.status !== 200) {
    throw new Error(`Azure OpenAI ${res.status}: ${JSON.stringify(res.data)}`);
  }
  const choice = res.data.choices[0];
  const text = choice.message.content || '';
  const finishReason = choice.finish_reason;
  // Warn if response was truncated by token limit (common with gpt-5 reasoning models)
  if (!text && finishReason === 'length') {
    console.warn(`[provider] empty reply, finish_reason=length, usage=${JSON.stringify(res.data.usage)}`);
  }
  return { text, usage: res.data.usage || null, finishReason };
}

// ---------------------------------------------------------------------------
// OpenAI (official)
// ---------------------------------------------------------------------------
async function openaiChat(messages, { model, maxTokens = 300, temperature = 0.7, jsonMode = false } = {}) {
  const cfg = config.get();
  const body = {
    model: model || cfg.openaiModelChat,
    messages,
    max_completion_tokens: maxTokens,
    temperature,
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  const res = await request('https://api.openai.com/v1/chat/completions', {
    headers: { 'Authorization': `Bearer ${cfg.openaiKey}` },
    timeout: 60000,
  }, body);

  if (res.status !== 200) {
    throw new Error(`OpenAI ${res.status}: ${JSON.stringify(res.data)}`);
  }
  return { text: res.data.choices[0].message.content, usage: res.data.usage || null };
}

// ---------------------------------------------------------------------------
// Google Gemini
// ---------------------------------------------------------------------------
async function geminiChat(messages, { model, maxTokens = 300, temperature = 0.7, jsonMode = false } = {}) {
  const cfg = config.get();
  const mdl = model || cfg.geminiModelChat;
  const key = cfg.geminiKey;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${mdl}:generateContent?key=${key}`;

  // Convert OpenAI-style messages to Gemini format
  const contents = [];
  let systemInstruction = null;

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemInstruction = { parts: [{ text: msg.content }] };
    } else {
      const parts = [];
      if (typeof msg.content === 'string') {
        parts.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        // Multi-part (text + image)
        for (const part of msg.content) {
          if (part.type === 'text') {
            parts.push({ text: part.text });
          } else if (part.type === 'image_url') {
            // Extract base64 from data URL
            const match = part.image_url.url.match(/^data:(.+);base64,(.+)$/);
            if (match) {
              parts.push({ inline_data: { mime_type: match[1], data: match[2] } });
            }
          }
        }
      }
      contents.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts,
      });
    }
  }

  const body = {
    contents,
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature,
    },
  };
  if (systemInstruction) body.systemInstruction = systemInstruction;
  if (jsonMode) body.generationConfig.responseMimeType = 'application/json';

  const res = await request(url, { timeout: 60000 }, body);

  if (res.status !== 200) {
    throw new Error(`Gemini ${res.status}: ${JSON.stringify(res.data)}`);
  }
  // Gemini returns usageMetadata with promptTokenCount + candidatesTokenCount
  const gUsage = res.data.usageMetadata;
  const usage = gUsage ? { prompt_tokens: gUsage.promptTokenCount, completion_tokens: gUsage.candidatesTokenCount, total_tokens: gUsage.totalTokenCount } : null;
  return { text: res.data.candidates[0].content.parts[0].text, usage };
}

// ---------------------------------------------------------------------------
// Anthropic Claude
// ---------------------------------------------------------------------------
async function claudeChat(messages, { model, maxTokens = 300, temperature = 0.7 } = {}) {
  const cfg = config.get();

  // Extract system message
  let system = '';
  const filtered = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      system += (system ? '\n' : '') + msg.content;
    } else {
      // Convert multi-part content for Claude
      if (Array.isArray(msg.content)) {
        const parts = [];
        for (const part of msg.content) {
          if (part.type === 'text') {
            parts.push({ type: 'text', text: part.text });
          } else if (part.type === 'image_url') {
            const match = part.image_url.url.match(/^data:(.+);base64,(.+)$/);
            if (match) {
              parts.push({
                type: 'image',
                source: { type: 'base64', media_type: match[1], data: match[2] },
              });
            }
          }
        }
        filtered.push({ role: msg.role, content: parts });
      } else {
        filtered.push(msg);
      }
    }
  }

  const body = {
    model: model || cfg.claudeModelChat,
    max_tokens: maxTokens,
    temperature,
    messages: filtered,
  };
  if (system) body.system = system;

  const res = await request('https://api.anthropic.com/v1/messages', {
    headers: {
      'x-api-key': cfg.claudeKey,
      'anthropic-version': '2023-06-01',
    },
    timeout: 60000,
  }, body);

  if (res.status !== 200) {
    throw new Error(`Claude ${res.status}: ${JSON.stringify(res.data)}`);
  }
  // Claude returns usage with input_tokens + output_tokens
  const cUsage = res.data.usage;
  const usage = cUsage ? { prompt_tokens: cUsage.input_tokens, completion_tokens: cUsage.output_tokens, total_tokens: (cUsage.input_tokens || 0) + (cUsage.output_tokens || 0) } : null;
  return { text: res.data.content[0].text, usage };
}

// ---------------------------------------------------------------------------
// Unified chat interface
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Token usage tracking
// ---------------------------------------------------------------------------
let _totalPromptTokens = 0;
let _totalCompletionTokens = 0;
let _lastPromptTokens = 0;   // from most recent call (for compaction decisions)
let _requestCount = 0;

function recordUsage(usage) {
  if (!usage) return;
  _totalPromptTokens += usage.prompt_tokens || 0;
  _totalCompletionTokens += usage.completion_tokens || 0;
  _lastPromptTokens = usage.prompt_tokens || 0;
  _requestCount++;
}

function getUsageStats() {
  return {
    totalPromptTokens: _totalPromptTokens,
    totalCompletionTokens: _totalCompletionTokens,
    totalTokens: _totalPromptTokens + _totalCompletionTokens,
    lastPromptTokens: _lastPromptTokens,
    requestCount: _requestCount,
  };
}

/**
 * Send a chat completion request to the configured provider.
 * Returns the text content. Usage is tracked internally.
 * @param {Array} messages - OpenAI-style messages [{role, content}]
 * @param {Object} opts - { purpose, maxTokens, temperature, jsonMode }
 * @returns {string} response text
 */
async function chat(messages, opts = {}) {
  const cfg = config.get();
  const purpose = opts.purpose || 'chat';

  let result;
  switch (cfg.provider) {
    case 'azure-openai': {
      const deploymentMap = {
        observe: cfg.azureOpenaiDeploymentObserve,
        react:   cfg.azureOpenaiDeploymentObserve,  // react uses mini — naturally brief
        chat:    cfg.azureOpenaiDeploymentChat,
        diary:   cfg.azureOpenaiDeploymentChat,
        reason:  cfg.azureOpenaiDeploymentReason,
      };
      result = await azureOpenaiChat(messages, {
        deployment: deploymentMap[purpose] || cfg.azureOpenaiDeploymentChat,
        ...opts,
      });
      break;
    }
    case 'openai': {
      const modelMap = {
        observe: cfg.openaiModelObserve,
        react:   cfg.openaiModelObserve,
        chat:    cfg.openaiModelChat,
        diary:   cfg.openaiModelChat,
      };
      result = await openaiChat(messages, {
        model: modelMap[purpose] || cfg.openaiModelChat,
        ...opts,
      });
      break;
    }
    case 'gemini': {
      const modelMap = {
        observe: cfg.geminiModelObserve,
        react:   cfg.geminiModelObserve,
        chat:    cfg.geminiModelChat,
        diary:   cfg.geminiModelChat,
      };
      result = await geminiChat(messages, {
        model: modelMap[purpose] || cfg.geminiModelChat,
        ...opts,
      });
      break;
    }
    case 'claude':
      result = await claudeChat(messages, {
        model: opts.purpose === 'observe' ? cfg.claudeModelObserve : cfg.claudeModelChat,
        ...opts,
      });
      break;
    default:
      throw new Error(`Unknown provider: ${cfg.provider}`);
  }

  // Track usage from response
  recordUsage(result.usage);

  // Log usage for monitoring
  if (result.usage) {
    console.log(`[provider] ${purpose}: ${result.usage.prompt_tokens || '?'}→${result.usage.completion_tokens || '?'} tokens (total: ${_totalPromptTokens + _totalCompletionTokens})`);
  }

  return result.text;
}

// ---------------------------------------------------------------------------
// Gemini Embedding (always Gemini, regardless of chat provider)
// ---------------------------------------------------------------------------
async function embed(text) {
  const cfg = config.get();
  const key = cfg.geminiEmbeddingKey || cfg.geminiKey;
  if (!key) return null;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${key}`;
  const res = await request(url, { timeout: 15000 }, {
    model: 'models/gemini-embedding-001',
    content: { parts: [{ text }] },
    outputDimensionality: 768,
  });

  if (res.status !== 200) {
    console.error(`[provider] embedding failed ${res.status}:`, res.data);
    return null;
  }
  return res.data.embedding.values; // float32[] of 768 dims
}

// ---------------------------------------------------------------------------
// Test API key — quick health check for a given provider
// ---------------------------------------------------------------------------
async function testKey(provider, credentials) {
  const testMessages = [{ role: 'user', content: 'Say "ok" in one word.' }];

  try {
    switch (provider) {
      case 'azure-openai': {
        const endpoint = credentials.endpoint.replace(/\/$/, '');
        const url = `${endpoint}/openai/deployments/${credentials.deployment || 'gpt-5.4-nano-standard'}/chat/completions?api-version=${credentials.apiVersion || '2024-12-01-preview'}`;
        const res = await request(url, {
          headers: { 'api-key': credentials.key },
          timeout: 15000,
        }, { messages: testMessages, max_completion_tokens: 10 });
        return { ok: res.status === 200, status: res.status };
      }
      case 'openai': {
        const res = await request('https://api.openai.com/v1/chat/completions', {
          headers: { 'Authorization': `Bearer ${credentials.key}` },
          timeout: 15000,
        }, { model: 'gpt-4o-mini', messages: testMessages, max_completion_tokens: 10 });
        return { ok: res.status === 200, status: res.status };
      }
      case 'gemini': {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${credentials.key}`;
        const res = await request(url, { timeout: 15000 }, {
          contents: [{ role: 'user', parts: [{ text: 'Say "ok"' }] }],
          generationConfig: { maxOutputTokens: 10 },
        });
        return { ok: res.status === 200, status: res.status };
      }
      case 'claude': {
        const res = await request('https://api.anthropic.com/v1/messages', {
          headers: {
            'x-api-key': credentials.key,
            'anthropic-version': '2023-06-01',
          },
          timeout: 15000,
        }, { model: 'claude-sonnet-4-5-20250514', max_tokens: 10, messages: testMessages });
        return { ok: res.status === 200, status: res.status };
      }
      default:
        return { ok: false, error: `Unknown provider: ${provider}` };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export default { chat, embed, testKey, getUsageStats };
