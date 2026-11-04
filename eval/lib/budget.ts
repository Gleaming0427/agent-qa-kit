// What a QA eval campaign should cost, from the history, before it runs: no model call.
//
// Each trial is priced at its ticket's mean cost per trial in the history (phases 1 and 2, trials
// with an agent or scoring error left out). A ticket never run is priced at the mean over every
// ticket. It is an estimate: the agent, its prompt and the served model change the cost, and a
// campaign that stops on an API error costs less. QA eval refuses to start a campaign whose
// estimate is above its max_cost_usd input.
import type { Campaign } from './history.ts';

export interface Estimate {
  total_usd: number;
  trials: number;
  per_ticket: { ticket: string; trials: number; mean_usd: number; from_history: boolean }[];
}

export function estimateCost(include: { ticket: string }[], campaigns: Campaign[]): Estimate {
  // A dry run costs nothing and says nothing of the price of a trial.
  const observed = campaigns.filter((c) => c.role !== 'dry-run').flatMap((c) => c.observations.filter((o) => o.status === 'ok'));
  const overall = observed.length ? observed.reduce((n, o) => n + o.cost_usd, 0) / observed.length : 0;
  const counts = new Map<string, number>();
  for (const x of include) counts.set(x.ticket, (counts.get(x.ticket) ?? 0) + 1);
  const per_ticket = [...counts].map(([ticket, trials]) => {
    const os = observed.filter((o) => o.ticket === ticket);
    return { ticket, trials, mean_usd: os.length ? os.reduce((n, o) => n + o.cost_usd, 0) / os.length : overall, from_history: os.length > 0 };
  });
  return { total_usd: per_ticket.reduce((n, t) => n + t.trials * t.mean_usd, 0), trials: include.length, per_ticket };
}

/** The cap from QA eval's max_cost_usd input: null when it is empty (no cap). */
export function parseCap(raw: string | undefined): number | null {
  const text = (raw ?? '').trim();
  if (!text) return null;
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`max_cost_usd must be an amount in dollars, such as 5 or 7.50, got "${text}"`);
  return Number(text);
}

export function estimateMarkdown(e: Estimate, cap: number | null): string {
  const unknown = e.per_ticket.filter((t) => !t.from_history).map((t) => t.ticket);
  return [
    `# Estimated cost: $${e.total_usd.toFixed(2)}${cap === null ? '' : ` (max_cost_usd: $${cap.toFixed(2)})`}`,
    '',
    `${e.trials} trial(s), each at its ticket's mean cost per trial in the history${unknown.length ? `; ${unknown.join(', ')}, never run, at the mean over every ticket` : ''}. An estimate, not a bill: a new prompt or model changes it.`,
    '',
  ].join('\n');
}
