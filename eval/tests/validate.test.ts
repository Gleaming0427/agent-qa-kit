import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { compare } from '../lib/compare.ts';
import type { Policy } from '../lib/compare.ts';
import { findCampaign, loadCampaigns } from '../lib/history.ts';
import type { Campaign, Observation } from '../lib/history.ts';
import { annotations, failsCi, nextSteps, policyAt } from '../lib/validate.ts';
import { KIT } from '../lib/workspace.ts';

const campaigns = loadCampaigns(join(KIT, 'eval/history/campaigns'));
const get = (label: string) => findCampaign(campaigns, label);
const policyText = readFileSync(join(KIT, 'eval/compare-policy.json'), 'utf8');
const policy = JSON.parse(policyText) as Policy;
const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: KIT, encoding: 'utf8' }).stdout.trim();
const policyAtHead = policyAt(KIT, head);

function variant(base: Campaign, name: string, change: (o: Observation) => Partial<Observation> = () => ({})): Campaign {
  const c = structuredClone(base);
  c.id = `gh-${name}`;
  c.label = name;
  c.agent = { ...c.agent, commit: head };
  c.observations = c.observations.map((o) => ({ ...o, ...change(o), fingerprint: `${name}-${o.key}` }));
  return c;
}
const baseline = { label: 'D clean', campaigns: [get('D, clean')] };
const judge = (candidate: Campaign) => compare(baseline, { label: candidate.label, campaigns: [candidate] }, policy, policyText);

test('the rules are read at the candidate\'s commit; a commit from before the rules has none', () => {
  assert.ok(policyAtHead, 'the policy is committed');
  assert.equal(JSON.parse(policyAtHead).schema_version, 1);
  // The commit of the recheck that scored the history ran before eval/compare-policy.json existed.
  assert.equal(policyAt(KIT, 'efa197ec3d498b747a0dc73d59aa4fc8f8ec2e35'), null);
});

test('each reason gets a next step, and reruns are merged into one QA eval dispatch', () => {
  const same = judge(variant(get('D, clean'), 'same'));
  assert.equal(same.decision.verdict, 'accepted');
  assert.deepEqual(nextSteps(same, policy).map((s) => s.action), ['release']);

  // One trial of three fails on EVAL-12 and EVAL-14: unstable and worse, to rerun.
  const shaky = judge(variant(get('D, clean'), 'shaky', (o) => (['EVAL-12', 'EVAL-14'].includes(o.ticket) && o.trial === 2 ? { success: false } : {})));
  assert.equal(shaky.decision.verdict, 'review');
  const steps = nextSteps(shaky, policy);
  assert.deepEqual(steps.map((s) => s.action), ['rerun']);
  assert.deepEqual(steps[0].dispatch, { tickets: 'EVAL-12 EVAL-14', trials: 3 });

  // A change outside the tests: do not release, whatever else.
  const leaky = judge(variant(get('D, clean'), 'leaky', (o) => (o.key === 'EVAL-11#1' ? { policy_ok: false } : {})));
  assert.equal(leaky.decision.verdict, 'rejected');
  assert.equal(nextSteps(leaky, policy)[0].action, 'do_not_release');
});

test('in CI only the verdicts of ci.fail_on fail the job, with annotations for the run page', () => {
  assert.equal(failsCi('rejected', policy), true);
  assert.equal(failsCi('review', policy), false);
  assert.equal(failsCi('review', { ...policy, ci: { fail_on: ['rejected', 'review'], why: '' } }), true);
  const { ci: _, ...older } = policy;
  assert.equal(failsCi('rejected', older as Policy), true, 'a policy without a ci section fails on rejected');
  const leaky = judge(variant(get('D, clean'), 'leaky', (o) => (o.key === 'EVAL-11#1' ? { policy_ok: false } : {})));
  assert.ok(annotations(leaky, policy).some((a) => a.startsWith('::error title=Release decision: rejected::b_policy: ')));
  assert.deepEqual(annotations(judge(variant(get('D, clean'), 'same')), policy), ['::notice title=Release decision: accepted::same against D clean: every rule passed']);
});

const cli = (...args: string[]) => spawnSync(process.execPath, [join(KIT, 'eval/validate.ts'), ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });

test('the command line decides against the release baseline, and fails CI only on a rejection', () => {
  const work = mkdtempSync(join(tmpdir(), 'eval-validate-'));
  try {
    const file = (c: Campaign) => { const p = join(work, `${c.id}.json`); writeFileSync(p, JSON.stringify(c)); return p; };
    // The baseline file names D clean and its regression check: a copy of both is the same version.
    const sameNew = file(variant(get('D, clean'), 'same-new'));
    const sameOld = file(variant(get('D, clean regression check'), 'same-old'));
    const ok = cli('--candidate', sameNew, '--candidate', sameOld, '--ci', '--md', join(work, 'ok.md'));
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /::notice title=Release decision: accepted::/);
    const md = readFileSync(join(work, 'ok.md'), 'utf8');
    assert.match(md, /^# Release decision: ACCEPTED/);
    assert.match(md, new RegExp(`eval/compare-policy.json as it was at the candidate's commit \`${head.slice(0, 7)}\`, before its results existed`));

    const leaky = file(variant(get('D, clean'), 'leaky', (o) => (o.key === 'EVAL-11#1' ? { policy_ok: false } : {})));
    const bad = cli('--candidate', leaky, '--ci');
    assert.equal(bad.status, 1, 'a rejected version fails the job');
    assert.match(bad.stdout, /::error title=Release decision: rejected::b_policy/);
    assert.equal(cli('--candidate', leaky).status, 2, 'without --ci, the exit code is the verdict');

    // A campaign that ran before the rules existed: refused, unless today's rules are asked for.
    const early = cli('--candidate', 'D clean, split runners');
    assert.equal(early.status, 3);
    assert.match(early.stderr, /has no eval\/compare-policy\.json: its rules would be written after its results/);
    const forced = cli('--candidate', 'D clean, split runners', '--policy-current');
    assert.match(forced.stdout, /\*\*Warning:\*\* the candidate's commit `efa197e` has no eval\/compare-policy\.json/);

    const dry = file({ ...variant(get('D, clean'), 'dry'), role: 'dry-run' });
    const none = cli('--candidate', dry, '--ci');
    assert.equal(none.status, 0);
    assert.match(none.stdout, /No release decision for a dry run/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
