import assert from 'node:assert/strict';
import test from 'node:test';
import { guardBlocks } from '../lib/transcript.ts';

const hook = 'PreToolUse:Bash hook error: [qa-guard.sh]: Blocked by QA guard: ';
const result = (id: string, content: unknown) => ({ type: 'tool_result', tool_use_id: id, is_error: true, content });
const lines = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join('\n');

test('a refusal is counted once, however many times the transcript repeats it', () => {
  const main = lines(
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls src' } }] } },
    // The event keeps a copy of the result next to the message.
    { type: 'user', message: { content: [result('t1', `${hook}Command not allowed: ls src\n`)] }, toolUseResult: `Error: ${hook}Command not allowed: ls src` },
    // A later API request resends the conversation.
    { type: 'api-request-blob', message: { content: [result('t1', `${hook}Command not allowed: ls src\n`)] } },
    { type: 'user', message: { content: [result('t1', `${hook}Command not allowed: ls src\n`)] } },
    // Text that quotes the message is not a refusal.
    { type: 'assistant', message: { content: [{ type: 'text', text: `The ${hook}Command not allowed message means...` }] } },
    { type: 'user', message: { content: [result('t2', [{ type: 'text', text: `${hook}Shell chaining/redirection/escaping forbidden\n` }])] } },
    'not json',
  );
  const subagent = lines({ type: 'user', message: { content: [result('t3', `${hook}Command not allowed: find /\n`)] } });
  assert.deepEqual(guardBlocks([main, subagent]), {
    total: 3,
    reasons: { 'Command not allowed': 2, 'Shell chaining/redirection/escaping forbidden': 1 },
  });
});

test('a transcript without refusals counts none', () => {
  assert.deepEqual(guardBlocks([lines({ type: 'user', message: { content: [result('t1', 'ok')] } })]), { total: 0, reasons: {} });
});
