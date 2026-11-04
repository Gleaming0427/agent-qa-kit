// Release validation: whether a new agent version can be released, from its campaign(s) and the
// release baseline, under rules fixed before the campaign ran.
//
// - The rules are those of eval/compare-policy.json at the candidate campaign's own commit. A rule
//   changed after the results cannot decide them: validating with today's rules needs an explicit
//   choice, and the report says so.
// - The decision is compare()'s (accepted, review or rejected, never a single overall score), and each
//   reason comes with what to do next: release, do not release, rerun these tickets, run everything,
//   measure the reference again, or look at it.
// - A ticket rerun because of its results gets one follow-up. Once the candidate holds its trials from
//   two campaigns, the decision pools them and asks for a human review: rerunning until a warning goes
//   away would stop on a good result, with no sequential method to correct for it.
// - In CI, the verdicts the policy lists in ci.fail_on fail the job; the others pass with a warning.
import { spawnSync } from 'node:child_process';
import type { Comparison, Policy, Verdict } from './compare.ts';
import type { Campaign } from './history.ts';

export type Action = 'release' | 'do_not_release' | 'rerun' | 'run_full' | 'remeasure_reference' | 'human_review';
export interface NextStep { action: Action; detail: string; dispatch?: { tickets: string; trials: number } }

/** The policy file at a commit, or null when the commit has none (it ran before the rules existed). */
export function policyAt(kit: string, commit: string): string | null {
  const run = spawnSync('git', ['show', `${commit}:eval/compare-policy.json`], { cwd: kit, encoding: 'utf8' });
  return run.status === 0 ? run.stdout : null;
}

const byTicket = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

/** The tickets the candidate holds trials of from two campaigns or more: they already had their follow-up. */
export function followedUp(candidates: Campaign[]): Map<string, number> {
  const runs = new Map<string, number>();
  for (const c of candidates) {
    for (const t of new Set(c.observations.filter((o) => o.status === 'ok').map((o) => o.ticket))) runs.set(t, (runs.get(t) ?? 0) + 1);
  }
  return new Map([...runs].filter(([, n]) => n > 1));
}

/**
 * What to do about each reason of the decision; reruns of several reasons are merged into one dispatch.
 * candidates: the campaigns of the new version, to tell a first measurement from a follow-up.
 */
export function nextSteps(c: Comparison, policy: Policy, candidates: Campaign[] = []): NextStep[] {
  const steps: NextStep[] = [];
  const trials = policy.rules.enough_trials?.min ?? 3;
  // Reruns asked for by the results (a regression, an unstable unit, too few trials on a changed ticket),
  // and reruns that replace trials lost to errors, which do not depend on the results.
  const rerun = new Set<string>();
  const refill = new Set<string>();
  // The tickets behind a regression that is not a confirmed critical one, or an unstable unit that got worse.
  const confirmed = (u: { a: { trials: number }; b: { trials: number } }) => Math.min(u.a.trials, u.b.trials) >= trials;
  const worse = (rule: 'regressions' | 'unstable_worse') => [...c.measurements.tickets, ...c.measurements.bugs]
    .filter((u) => (rule === 'regressions' ? u.category === 'regressed' && !(u.critical && confirmed(u)) : u.category === 'unstable' && u.direction === -1))
    .map((u) => u.ticket);
  for (const r of c.decision.reasons) {
    switch (r.rule) {
      case 'b_policy':
      case 'b_isolation':
      case 'critical_regression':
        steps.push({ action: 'do_not_release', detail: `${r.message}. Read those trials' transcripts, fix the cause, and run a new campaign.` });
        break;
      case 'b_corpus_exposure':
        steps.push({ action: 'do_not_release', detail: `${r.message}: these trials may not measure the agent. Run the campaign again on the split runners, where the agent never holds the corpus.` });
        break;
      case 'comparable':
        steps.push({ action: 'human_review', detail: `${r.message}. Recheck the baseline's runs with the current scoring code, or choose a comparable baseline.` });
        break;
      case 'enough_tickets':
        steps.push({ action: 'run_full', detail: `${r.message}: run every ticket.`, dispatch: { tickets: 'all', trials } });
        break;
      case 'enough_trials':
        for (const t of c.measurements.tickets) if (Math.min(t.a.trials, t.b.trials) < trials) rerun.add(t.ticket);
        break;
      case 'a_corpus_exposure':
        steps.push({ action: 'remeasure_reference', detail: `${r.message}: measure the baseline again on the split runners, or choose a baseline that did not see it.` });
        break;
      case 'b_agent_errors':
        for (const t of c.measurements.tickets) if (t.b.trials < trials) refill.add(t.ticket);
        steps.push({ action: 'human_review', detail: `${r.message}: check the API and the runners before reading the scores.` });
        break;
      case 'regressions':
      case 'unstable_worse':
        for (const t of worse(r.rule)) rerun.add(t);
        break;
      case 'significant_worsening':
        steps.push({ action: 'human_review', detail: `${r.message}. Read the tickets that got worse before deciding.` });
        break;
      case 'cost':
        steps.push({ action: 'human_review', detail: `${r.message}: weigh the gain against the cost.` });
        break;
      default:
        steps.push({ action: 'human_review', detail: r.message });
    }
  }
  const done = followedUp(candidates);
  const reviewed = [...rerun].filter((t) => done.has(t) && !refill.has(t)).sort(byTicket);
  if (reviewed.length) {
    steps.push({
      action: 'human_review',
      detail: `${reviewed.join(', ')} already ran again: the candidate holds ${reviewed.length > 1 ? 'their' : 'its'} trials from more than one campaign, pooled here. A ticket gets one follow-up: rerunning until the warning goes away would stop on a good result, with no sequential method to correct for it. Read ${reviewed.length > 1 ? 'their' : 'its'} trials and decide whether the agent has a weakness to fix or a variation to accept.`,
    });
  }
  const again = new Set([...rerun].filter((t) => !reviewed.includes(t)).concat([...refill]));
  if (again.size) {
    const tickets = [...again].sort(byTicket).join(' ');
    steps.push({
      action: 'rerun',
      detail: `Run these tickets again (${trials} trials), add the run to the history, and validate again with both runs as the candidate: an unstable or isolated change often does not repeat.`,
      dispatch: { tickets, trials },
    });
  }
  if (c.decision.verdict === 'accepted') {
    steps.push({ action: 'release', detail: 'Every rule passed. Once released, make this version the baseline (eval/release-baseline.json).' });
  }
  return steps;
}

/** The job outcome: the verdicts of policy.ci.fail_on fail it (only "rejected" when the policy says nothing). */
export function failsCi(verdict: Verdict, policy: Policy): boolean {
  return (policy.ci?.fail_on ?? ['rejected']).includes(verdict);
}

/** GitHub Actions annotations for the run page. */
export function annotations(c: Comparison, policy: Policy): string[] {
  const title = `Release decision: ${c.decision.verdict}`;
  const one = (r: { rule: string; message: string }) => `${r.rule}: ${r.message}`.replace(/\r?\n/g, ' ');
  if (c.decision.verdict === 'accepted') return [`::notice title=${title}::${c.b.label} against ${c.a.label}: every rule passed`];
  const level = failsCi(c.decision.verdict, policy) ? 'error' : 'warning';
  return c.decision.reasons.map((r) => `::${r.level === 'reject' ? level : 'warning'} title=${title}::${one(r)}`);
}

export interface PolicySource { commit: string; from: 'commit' | 'current'; differs_from_current: boolean }

const ACTION: Record<Action, string> = {
  release: 'Release',
  do_not_release: 'Do not release',
  rerun: 'Rerun',
  run_full: 'Run every ticket',
  remeasure_reference: 'Measure the reference again',
  human_review: 'Human review',
};

export function validationMarkdown(c: Comparison, policy: Policy, steps: NextStep[], source: PolicySource, comparison: string): string {
  const banner = {
    accepted: 'The new version can be released.',
    review: 'A human review is needed before any release.',
    rejected: 'The new version must not be released.',
  }[c.decision.verdict];
  return [
    `# Release decision: ${c.decision.verdict.toUpperCase()}`,
    '',
    `**${banner}** ${c.b.label} against the release baseline, ${c.a.label}.`,
    '',
    source.from === 'commit'
      ? `The rules are eval/compare-policy.json as it was at the candidate's commit \`${source.commit.slice(0, 7)}\`, before its results existed (sha256 \`${c.decision.policy_sha256.slice(0, 12)}\`).${source.differs_from_current ? ' The file has changed since; the decision keeps the rules in force when the campaign ran.' : ''}`
      : `**Warning:** the candidate's commit \`${source.commit.slice(0, 7)}\` has no eval/compare-policy.json, so the rules were written after its results. The current rules are applied (sha256 \`${c.decision.policy_sha256.slice(0, 12)}\`), at the request of whoever ran this.`,
    '',
    '## Next steps',
    '',
    ...steps.map((s) => `- **${ACTION[s.action]}:** ${s.detail}${s.dispatch ? ` QA eval inputs: \`tickets: ${s.dispatch.tickets}\`, \`trials: ${s.dispatch.trials}\`.` : ''}`),
    '',
    `In CI, ${(policy.ci?.fail_on ?? ['rejected']).join(' and ')} fails the release decision job.`,
    '',
    comparison.replace(/^# /, '## Comparison: '),
  ].join('\n');
}
