// The Python retrieval helpers report failures and empty results on stderr
// ("[wa-brain] RETRIEVAL_ERROR ..."). Retrieval fails open, so without
// forwarding those lines a broken index would be silent in the sidecar log.

export type StderrLogger = (line: string) => void

export function forwardScriptStderr(
  label: string,
  stderr: string | Buffer | null | undefined,
  log: StderrLogger = (line) => console.warn(line),
): number {
  if (!stderr) return 0
  let forwarded = 0
  for (const raw of String(stderr).split('\n')) {
    const line = raw.trim()
    if (!line) continue
    log(`${label} ${line}`)
    forwarded += 1
  }
  return forwarded
}

export function stderrOf(error: unknown): string {
  if (error && typeof error === 'object' && 'stderr' in error) {
    const value = (error as { stderr?: unknown }).stderr
    if (typeof value === 'string' || Buffer.isBuffer(value)) return String(value)
  }
  return ''
}
