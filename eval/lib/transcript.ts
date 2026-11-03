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

/**
 * Text that only the corpus has: its folder (eval/tickets in the checkout, eval-tickets where CI
 * moves it) and its file names. A tool call whose input or result shows one may have seen the
 * reference implementation, the bugs or the hidden tests.
 */
const CORPUS = /eval\/tickets\/|eval-tickets|gold\.diff|hidden\.spec\.ts/;
const UNAVAILABLE = 'No such tool available';

export interface ToolHealth {
  /** Tool calls by tool name, each counted once by its id. */
  calls: Record<string, number>;
  /** Calls answered "No such tool available", by tool name: the session does not have that tool. */
  unavailable: Record<string, number>;
  /** Calls whose input or result names the corpus, with the start of their input. */
  corpus: { tool: string; input: string }[];
}

type Part = { type?: string; id?: unknown; name?: unknown; input?: unknown; tool_use_id?: unknown; content?: unknown };

/**
 * Checks the tool calls of the given transcripts (their text) for problems that only a transcript
 * shows: a tool the session lacks, and a sight of the corpus, whatever the way in. Like the guard
 * count, it reads tool calls from assistant events and results from user events, once per call id.
 */
export function toolHealth(transcripts: string[]): ToolHealth {
  const uses = new Map<string, { tool: string; input: string }>();
  const results = new Map<string, string>();
  for (const transcript of transcripts) {
    for (const line of transcript.split('\n')) {
      if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) continue;
      let event: { type?: string; message?: { content?: unknown } };
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (!Array.isArray(event.message?.content)) continue;
      for (const part of event.message.content as Part[]) {
        if (event.type === 'assistant' && part?.type === 'tool_use' && typeof part.id === 'string' && typeof part.name === 'string') {
          uses.set(part.id, { tool: part.name, input: JSON.stringify(part.input ?? {}) });
        } else if (event.type === 'user' && part?.type === 'tool_result' && typeof part.tool_use_id === 'string') {
          results.set(part.tool_use_id, text(part.content));
        }
      }
    }
  }
  const health: ToolHealth = { calls: {}, unavailable: {}, corpus: [] };
  for (const [id, use] of uses) {
    health.calls[use.tool] = (health.calls[use.tool] ?? 0) + 1;
    const result = results.get(id) ?? '';
    if (result.includes(UNAVAILABLE)) health.unavailable[use.tool] = (health.unavailable[use.tool] ?? 0) + 1;
    if (CORPUS.test(use.input) || CORPUS.test(result)) health.corpus.push({ tool: use.tool, input: use.input.slice(0, 200) });
  }
  return health;
}
