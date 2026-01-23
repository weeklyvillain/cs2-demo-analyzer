// Command log ring buffer for debug mode
interface CommandEntry {
  ts: number // timestamp in milliseconds
  cmd: string
}

const MAX_COMMANDS = 50
const commandLog: CommandEntry[] = []

export function pushCommand(cmd: string): void {
  const entry: CommandEntry = {
    ts: Date.now(),
    cmd: cmd.trim()
  }
  
  commandLog.push(entry)
  
  // Maintain ring buffer size
  if (commandLog.length > MAX_COMMANDS) {
    commandLog.shift()
  }
}

export function getCommandLog(): CommandEntry[] {
  return [...commandLog] // Return a copy
}

export function clearCommandLog(): void {
  commandLog.length = 0
}
