// Provider-agnostic LLM completion for draft generation.
//
// The active provider + model are resolved at call time from the runtime model
// config (data/autoreply/model-config.json, falling back to env defaults) so
// they can be switched without restarting - see autoreply-model.ts. Backends:
//   claude-cli - shells out to the local `claude` CLI (no API key needed)
//   codex-cli  - shells out to the local `codex` CLI (no API key needed)
//   anthropic  - Anthropic Messages API via the official SDK
//   openai     - any OpenAI-compatible chat-completions endpoint
//                (OpenAI, OpenRouter, Groq, Mistral, Ollama, LM Studio, ...)

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import Anthropic from '@anthropic-ai/sdk'

import { AUTOREPLY_CLAUDE_BIN, AUTOREPLY_MODEL } from './autoreply-env.js'
import {
  type ModelConfig,
  assertSafeBaseUrl,
  completeViaCodexCli,
  readModelConfig,
  resolveApiKey,
  resolveBaseUrl,
} from './autoreply-model.js'

const execFileAsync = promisify(execFile)

async function completeViaClaudeCli(prompt: string, model: string): Promise<string> {
  // Drafting only needs the bare model. Skipping MCP servers and settings
  // (plugins, hooks) cuts a few seconds of CLI startup per reply given the
  // operator's large global setup. --bare would be faster still but drops the
  // stored login, so it cannot be used here.
  const { stdout } = await execFileAsync(
    AUTOREPLY_CLAUDE_BIN,
    ['--strict-mcp-config', '--setting-sources', '', '--model', model, '-p', prompt],
    {
      maxBuffer: 1024 * 1024,
      timeout: 120000,
    },
  )
  return stdout
}

async function completeViaAnthropic(prompt: string, config: ModelConfig): Promise<string> {
  const apiKey = resolveApiKey('anthropic')
  if (!apiKey) {
    throw new Error('[autoreply/llm] anthropic provider needs ANTHROPIC_API_KEY or AUTOREPLY_LLM_API_KEY')
  }
  const client = new Anthropic({ apiKey })
  const response = await client.messages.create({
    model: config.model ?? 'claude-opus-4-8',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  })
  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

async function completeViaOpenAiCompatible(prompt: string, config: ModelConfig): Promise<string> {
  if (!config.model) {
    throw new Error('[autoreply/llm] openai provider requires a model (e.g. gpt-5)')
  }
  const baseUrl = resolveBaseUrl(config)
  assertSafeBaseUrl(baseUrl)
  const apiKey = resolveApiKey('openai')
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(120000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`[autoreply/llm] LLM request failed (${res.status}): ${text.slice(0, 500)}`)
  }
  const payload = await res.json() as { choices?: Array<{ message?: { content?: string | null } }> }
  const text = payload.choices?.[0]?.message?.content?.trim()
  if (!text) throw new Error('[autoreply/llm] LLM response contained no message content')
  return text
}

export async function completeDraftPrompt(prompt: string): Promise<string> {
  const config = readModelConfig()
  if (config.provider === 'anthropic') return completeViaAnthropic(prompt, config)
  if (config.provider === 'openai') return completeViaOpenAiCompatible(prompt, config)
  if (config.provider === 'codex-cli') return completeViaCodexCli(prompt, config.model)
  return completeViaClaudeCli(prompt, config.model ?? AUTOREPLY_MODEL)
}
