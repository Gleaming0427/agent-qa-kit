import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { parseIssues, reviewScreenshots, summaryMarkdown, warningLines } from '../visual-review.ts';
import type { Review } from '../visual-review.ts';

const screens = ['services-desktop.png', 'services-mobile.png'];
const issue = { screenshot: 'services-mobile.png', check: 'off_screen', where: 'search box', description: 'The search box is cut off on the right.' };

function screenshotDir() {
  const dir = mkdtempSync(join(tmpdir(), 'qa-visual-'));
  for (const name of screens) writeFileSync(join(dir, name), `png bytes of ${name}`);
  writeFileSync(join(dir, 'notes.txt'), 'not a screenshot');
  return dir;
}
// Stands in for the SDK client: records the request and returns a canned response.
function fakeClient(response: object) {
  const calls: Record<string, unknown>[] = [];
  const client = { beta: { messages: { create: async (params: Record<string, unknown>) => { calls.push(params); return response; } } } };
  return { client: client as unknown as Anthropic, calls };
}
const answer = (issues: object[]) => ({
  stop_reason: 'end_turn', stop_details: null, usage: { input_tokens: 2300, output_tokens: 400 },
  content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify({ issues }) }],
});

test('keeps well-formed findings about screenshots that were sent', () => {
  const text = JSON.stringify({ issues: [
    issue,
    { ...issue, screenshot: 'other.png' },
    { ...issue, check: 'ugly_colors' },
    { ...issue, description: '  ' },
    { ...issue, where: 'x'.repeat(1000) },
  ] });
  const { issues, dropped } = parseIssues(text, screens);
  assert.equal(issues.length, 2);
  assert.equal(dropped, 3);
  assert.equal(issues[1].where.length, 300);
  assert.throws(() => parseIssues('not json', screens), /valid JSON/);
  assert.throws(() => parseIssues('{"problems": []}', screens), /no issue list/);
});

test('sends every screenshot with its name and asks for the structured list', async () => {
  const dir = screenshotDir();
  try {
    const { client, calls } = fakeClient(answer([issue]));
    const review = await reviewScreenshots({ dir, client, model: 'claude-opus-5-5' });
    assert.equal(review.status, 'reviewed');
    assert.deepEqual(review.issues, [issue]);
    const params = calls[0] as { model: string; fallbacks: string; betas: string[]; output_config: { effort: string; format: { type: string } }; messages: { content: { type: string; text?: string; source?: { data: string; media_type: string } }[] }[] };
    assert.equal(params.model, 'claude-opus-5-5');
    assert.equal(params.fallbacks, 'default');
    assert.deepEqual(params.betas, ['server-side-fallback-2026-07-01']);
    assert.equal(params.output_config.format.type, 'json_schema');
    const blocks = params.messages[0].content;
    assert.deepEqual(blocks.filter((b) => b.type === 'text').map((b) => b.text), ['Screenshot services-desktop.png:', 'Screenshot services-mobile.png:', 'Review these 2 screenshot(s).']);
    const image = blocks.find((b) => b.type === 'image')!;
    assert.equal(image.source!.media_type, 'image/png');
    assert.equal(Buffer.from(image.source!.data, 'base64').toString(), 'png bytes of services-desktop.png');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a refusal or a cut-off answer is reported, not trusted', async () => {
  const dir = screenshotDir();
  try {
    let { client } = fakeClient({ ...answer([]), stop_reason: 'refusal', stop_details: { type: 'refusal', category: null } });
    assert.equal((await reviewScreenshots({ dir, client })).status, 'declined');
    ({ client } = fakeClient({ ...answer([]), stop_reason: 'max_tokens' }));
    assert.equal((await reviewScreenshots({ dir, client })).status, 'unavailable');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('no screenshot means no API call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-visual-empty-'));
  try {
    const { client, calls } = fakeClient(answer([]));
    const review = await reviewScreenshots({ dir, client });
    assert.equal(review.status, 'skipped');
    assert.equal(calls.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('findings become escaped GitHub warnings and a summary table', () => {
  const review: Review = { status: 'reviewed', model: 'claude-opus-5-5', screenshots: screens, dropped: 0,
    issues: [{ ...issue, check: 'overflow', where: 'title: 100% width, header', description: 'Line one\nline | two' }] };
  const [line] = warningLines(review, true);
  assert.equal(line, '::warning title=AI visual review%3A overflow::services-mobile.png: title: 100%25 width, header. Line one%0Aline | two');
  assert.match(warningLines(review, false)[0], /^WARNING \[overflow\] services-mobile\.png/);
  assert.match(summaryMarkdown(review), /\| services-mobile\.png \| overflow \| title: 100% width, header \| Line one\nline \\\| two \|/);
  assert.match(summaryMarkdown({ ...review, issues: [] }), /No visible problem found in 2 screenshot\(s\)/);
});

test('in CI without an API key, the review is skipped and never fails', () => {
  const dir = screenshotDir();
  try {
    const report = join(dir, 'review.json');
    const env: NodeJS.ProcessEnv = { ...process.env, CI: 'true' };
    delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN; delete env.GITHUB_STEP_SUMMARY;
    const run = spawnSync(process.execPath, [resolve(import.meta.dirname, '../visual-review.ts'), dir, report], { encoding: 'utf8', env });
    assert.equal(run.status, 0);
    assert.match(run.stdout, /::notice title=AI visual review skipped::add an ANTHROPIC_API_KEY secret/);
    assert.equal(JSON.parse(readFileSync(report, 'utf8')).status, 'skipped');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
