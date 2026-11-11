export type ChatLanguage = 'de' | 'en' | 'pt' | 'unknown'

const LANGUAGE_WORDS: Record<Exclude<ChatLanguage, 'unknown'>, ReadonlySet<string>> = {
  de: new Set([
    'aber', 'alles', 'auch', 'bin', 'bis', 'bitte', 'danke', 'das', 'der', 'die', 'dir', 'du',
    'ein', 'eine', 'für', 'gerade', 'habe', 'hallo', 'heute', 'ich', 'ist', 'ja', 'kann', 'klar',
    'mit', 'morgen', 'nicht', 'noch', 'oder', 'passt', 'schon', 'später', 'und', 'was', 'wir',
  ]),
  en: new Set([
    'and', 'are', 'can', 'cool', 'easy', 'for', 'great', 'hey', 'i', 'is', 'it', 'please',
    'see', 'thanks', 'that', 'the', 'this', 'tomorrow', 'we', 'with', 'yes', 'you',
  ]),
  pt: new Set([
    'beleza', 'então', 'isso', 'não', 'obrigada', 'obrigado', 'oi', 'olá', 'pois', 'sim', 'tá',
  ]),
}

const OFF_LANGUAGE_FILLERS: Record<Exclude<ChatLanguage, 'unknown'>, ReadonlySet<string>> = {
  de: new Set(['ja', 'klar', 'passt']),
  en: new Set(['cool', 'easy', 'great', 'yes']),
  pt: new Set(['beleza', 'então', 'isso', 'obrigada', 'obrigado', 'pois', 'sim', 'tá']),
}

function words(text: string): string[] {
  // Normalize before tokenizing so a model cannot evade a lexical safety rule
  // with case, full-width characters, or punctuation wrapped around a word.
  return text.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}]+/gu) ?? []
}

export function detectTextLanguage(text: string): ChatLanguage {
  const tokens = words(text)
  if (tokens.length === 0) return 'unknown'
  const scores: Record<Exclude<ChatLanguage, 'unknown'>, number> = { de: 0, en: 0, pt: 0 }
  for (const token of tokens) {
    for (const language of ['de', 'en', 'pt'] as const) {
      if (LANGUAGE_WORDS[language].has(token)) scores[language] += 1
    }
  }
  if (/[äöüß]/i.test(text)) scores.de += 2
  if (/[ãõáéíóúç]/i.test(text)) scores.pt += 2
  const ranked = (Object.entries(scores) as Array<[Exclude<ChatLanguage, 'unknown'>, number]>)
    .sort((a, b) => b[1] - a[1])
  if (!ranked[0] || ranked[0][1] === 0 || ranked[0][1] === ranked[1]?.[1]) return 'unknown'
  return ranked[0][0]
}

export function resolveChatLanguage(
  incomingText: string,
  recentOperatorReplies: Array<string | { body: string; language?: ChatLanguage }>,
): ChatLanguage {
  const incomingLanguage = detectTextLanguage(incomingText)
  if (incomingLanguage !== 'unknown') return incomingLanguage
  const recent = recentOperatorReplies.slice(-20)
  const tagged = recent.flatMap((reply) => {
    if (typeof reply === 'string') return []
    return reply.language && reply.language !== 'unknown' ? [reply.language] : []
  })
  if (tagged.length > 0) {
    const counts = new Map<ChatLanguage, number>()
    for (const language of tagged) counts.set(language, (counts.get(language) ?? 0) + 1)
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1])
    if (ranked[0] && ranked[0][1] !== ranked[1]?.[1]) return ranked[0][0]
  }
  return detectTextLanguage(recent.map((reply) => typeof reply === 'string' ? reply : reply.body).join('\n'))
}

export function findOffLanguageFillers(text: string, targetLanguage: ChatLanguage): string[] {
  if (targetLanguage === 'unknown') return []
  const found = new Set<string>()
  for (const token of words(text)) {
    for (const language of ['de', 'en', 'pt'] as const) {
      if (language !== targetLanguage && OFF_LANGUAGE_FILLERS[language].has(token)) found.add(token)
    }
  }
  return [...found]
}

export function isReplyLanguageCompatible(text: string, targetLanguage: ChatLanguage): boolean {
  if (targetLanguage === 'unknown' || !text.trim()) return true
  if (findOffLanguageFillers(text, targetLanguage).length > 0) return false
  const detected = detectTextLanguage(text)
  if (detected === 'unknown' || detected === targetLanguage) return true
  return words(text).length < 3
}
