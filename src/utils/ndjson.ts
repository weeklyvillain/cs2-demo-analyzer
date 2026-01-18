/**
 * Safely parses NDJSON (newline-delimited JSON) lines.
 * Ignores malformed lines but logs them.
 */

export interface ParsedMessage {
  type: string
  [key: string]: unknown
}

export function parseNDJSONLine(line: string): ParsedMessage | null {
  const trimmed = line.trim()
  if (!trimmed) {
    return null
  }

  try {
    const parsed = JSON.parse(trimmed) as ParsedMessage
    if (typeof parsed === 'object' && parsed !== null && 'type' in parsed) {
      return parsed
    }
    console.warn('NDJSON line missing type field:', trimmed)
    return null
  } catch (error) {
    console.warn('Failed to parse NDJSON line:', trimmed, error)
    return null
  }
}

export function parseNDJSONLines(lines: string[]): ParsedMessage[] {
  const parsed: ParsedMessage[] = []
  for (const line of lines) {
    const result = parseNDJSONLine(line)
    if (result) {
      parsed.push(result)
    }
  }
  return parsed
}

