import assert from 'node:assert/strict';
import test from 'node:test';
import { guardBlocks, toolHealth } from '../lib/transcript.ts';

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

test('tool health counts calls once, and finds missing tools and any sight of the corpus', () => {
  const use = (id: string, name: string, input: unknown) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
  const main = lines(
    use('t1', 'Glob', { pattern: 'src/**/*.tsx' }),
    { type: 'user', message: { content: [result('t1', 'Error: No such tool available: Glob. Glob is not available in this session')] } },
    // A later API request resends the conversation: not counted again.
    { type: 'api-request-blob', message: { content: [{ type: 'tool_use', id: 't1', name: 'Glob', input: {} }, result('t1', 'No such tool available: Glob')] } },
    use('t2', 'Bash', { command: 'git status' }),
    { type: 'user', message: { content: [result('t2', [{ type: 'text', text: ' D ../../eval/tickets/EVAL-1/gold.diff\n' }])] } },
    use('t3', 'Read', { file_path: 'src/App.tsx' }),
    { type: 'user', message: { content: [result('t3', 'export default function App() {}')] } },
    // Text that mentions the corpus outside a tool call is not a sight of it.
    { type: 'assistant', message: { content: [{ type: 'text', text: 'There is no hidden.spec.ts here.' }] } },
  );
  const subagent = lines(use('t4', 'Read', { file_path: '/home/runner/work/_temp/eval-tickets/EVAL-1/hidden.spec.ts' }));
  assert.deepEqual(toolHealth([main, subagent]), {
    calls: { Glob: 1, Bash: 1, Read: 2 },
    unavailable: { Glob: 1 },
    corpus: [
      { tool: 'Bash', input: '{"command":"git status"}' },
      { tool: 'Read', input: '{"file_path":"/home/runner/work/_temp/eval-tickets/EVAL-1/hidden.spec.ts"}' },
    ],
    context: [],
  });
});

test('a session that never sees the corpus has no exposure', () => {
  const clean = lines(
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git status' } }] } },
    { type: 'user', message: { content: [result('t1', 'On branch master\nnothing to commit, working tree clean')] } },
  );
  assert.deepEqual(toolHealth([clean]), { calls: { Bash: 1 }, unavailable: {}, corpus: [], context: [] });
});

test('the git status that Claude Code adds to a session counts when it names the corpus', () => {
  const status = 'Current branch: main\nStatus: D ../../eval/tickets/EVAL-1/bugs/any-code-accepted.diff';
  const exposed = lines(
    { type: 'attachment', uuid: 'a1', attachment: { content: status } },
    // A later API request resends it: the same context, not counted again.
    { type: 'api-request-blob', uuid: 'r1', body: status },
    // The agent's own words are not context.
    { type: 'assistant', uuid: 'm1', message: { content: [{ type: 'text', text: 'Not reading eval/tickets/.' }] } },
  );
  const health = toolHealth([exposed]);
  assert.equal(health.context?.length, 1);
  assert.equal(health.context?.[0].type, 'attachment');
  assert.match(health.context?.[0].sample ?? '', /eval\/tickets\/EVAL-1\/bugs\/any-code-accepted\.diff/);
  const clean = lines({ type: 'attachment', uuid: 'a1', attachment: { content: 'Current branch: master\nStatus: (clean)' } });
  assert.deepEqual(toolHealth([clean]).context, []);
});
