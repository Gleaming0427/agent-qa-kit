// Reads Claude Code transcripts (JSON Lines) for the evaluation.
//
// A tool call that the kit's guard hook refused shows up several times in a transcript: in the
// tool result, in the copy of it that the same event keeps, and again in later API requests that
// resend the conversation. A refusal is therefore counted once, by the id of the refused tool call,
// and only from tool results.

const MARK = 'Blocked by QA guard: ';

function text(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '')).join('\n');
}

/** Counts the refused tool calls in the given transcripts (their text), by reason ("Command not allowed", ...). */
export function guardBlocks(transcripts: string[]): { total: number; reasons: Record<string, number> } {
  const refused = new Map<string, string>();
  for (const transcript of transcripts) {
    for (const line of transcript.split('\n')) {
      if (!line.includes(MARK)) continue;
      let event: { type?: string; message?: { content?: unknown } };
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type !== 'user' || !Array.isArray(event.message?.content)) continue;
      for (const part of event.message.content as { type?: string; tool_use_id?: unknown; content?: unknown }[]) {
        if (part?.type !== 'tool_result' || typeof part.tool_use_id !== 'string') continue;
        const body = text(part.content);
        const at = body.indexOf(MARK);
        if (at < 0) continue;
        // "Blocked by QA guard: Command not allowed: ls src" gives "Command not allowed".
        refused.set(part.tool_use_id, body.slice(at + MARK.length).split('\n')[0].split(':')[0].trim());
      }
    }
  }
  const reasons: Record<string, number> = {};
  for (const reason of refused.values()) reasons[reason] = (reasons[reason] ?? 0) + 1;
  return { total: refused.size, reasons };
}
