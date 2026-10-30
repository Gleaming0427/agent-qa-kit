#!/usr/bin/env node
// Contrôle du verdict de l'agent QA : hook de fin de Claude Code
// (Stop pour une session, converti en SubagentStop pour un sous-agent).
//
// Quand l'agent veut s'arrêter, Claude Code transmet son dernier message en JSON
// sur l'entrée standard. Si le verdict est incomplet ou contredit les rapports de
// tests, le script refuse l'arrêt (code 2) et explique quoi corriger : l'agent
// reprend son travail. Le contrôle est déterministe et ne coûte aucun token.
//
// Usage :
//   node controle-verdict.mjs <passe>          comme hook (passe 1 ou 2, ou variable QA_PASSE)
//   node controle-verdict.mjs <passe> --final  validation finale par qa/run-qa.sh :
//                                              affiche le verdict s'il est valide, sinon code 2.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REFUS_MAX = 3; // au-delà, l'arrêt est autorisé et le verdict sera rejeté par le lanceur
const args = process.argv.slice(2);
const FINAL = args.includes('--final');
const PASSE = Number(args.find((a) => a === '1' || a === '2') ?? process.env.QA_PASSE);
const PROJET = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const VERDICTS = { 1: ['pret', 'blocked'], 2: ['pass', 'fail', 'blocked'] };
const STATUTS = { 1: ['ecrit', 'non_testable'], 2: ['pass', 'fail', 'non_lance', 'non_testable'] };
const NIVEAUX = ['mfe', 'shell'];
const LISTES = ['criteres', 'tests_instables', 'questions_spec', 'alertes'];

// Refuse l'arrêt et renvoie l'agent au travail, au plus REFUS_MAX fois par session.
function refuser(problemes, session = 'inconnue') {
  const message = `Contrôle du verdict : corrige ces points avant de terminer.\n- ${problemes.join('\n- ')}`;
  if (FINAL) {
    console.error(message);
    process.exit(2);
  }
  const compteur = join(tmpdir(), `controle-verdict-${String(session).replace(/[^\w-]/g, '_')}.txt`);
  let renvois = 0;
  try {
    renvois = Number(readFileSync(compteur, 'utf8')) || 0;
  } catch {}
  if (renvois >= REFUS_MAX) {
    console.error(`${message}\n(Limite de ${REFUS_MAX} renvois atteinte : arrêt autorisé, verdict à rejeter.)`);
    process.exit(0);
  }
  try {
    writeFileSync(compteur, String(renvois + 1));
  } catch {}
  console.error(message);
  process.exit(2);
}

// Le verdict peut être du JSON brut, un bloc ```json, ou du JSON entouré de texte.
function extraireVerdict(texte) {
  if (typeof texte !== 'string' || !texte.trim()) return null;
  const candidats = [texte.trim()];
  const blocs = [...texte.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  if (blocs.length) candidats.push(blocs.at(-1));
  const debut = texte.indexOf('{');
  const fin = texte.lastIndexOf('}');
  if (debut !== -1 && fin > debut) candidats.push(texte.slice(debut, fin + 1));
  for (const candidat of candidats) {
    try {
      const valeur = JSON.parse(candidat);
      if (valeur && typeof valeur === 'object' && !Array.isArray(valeur)) return valeur;
    } catch {}
  }
  return null;
}

// null : rapport absent ; undefined : rapport illisible.
function lireRapport(nom) {
  const chemin = join(PROJET, 'reports', nom);
  if (!existsSync(chemin)) return null;
  try {
    return JSON.parse(readFileSync(chemin, 'utf8'));
  } catch {
    return undefined;
  }
}

function verifierStructure(v) {
  const p = [];
  if (typeof v.ticket !== 'string' || !v.ticket.trim()) p.push('Le champ "ticket" est manquant.');
  if (v.passe !== PASSE) p.push(`Le champ "passe" doit valoir ${PASSE}.`);
  if (!VERDICTS[PASSE].includes(v.verdict)) {
    p.push(`Le champ "verdict" doit valoir ${VERDICTS[PASSE].join(' ou ')}.`);
  }
  for (const champ of LISTES) {
    if (!Array.isArray(v[champ])) p.push(`Le champ "${champ}" doit être une liste, même vide.`);
  }
  return p;
}

function verifierCriteres(v) {
  const p = [];
  if (v.criteres.length === 0) return ['La liste "criteres" est vide.'];

  const parCritere = new Map();
  v.criteres.forEach((c, i) => {
    const ou = `criteres[${i}]`;
    if (!c || typeof c !== 'object') return p.push(`${ou} n'est pas un objet.`);
    if (typeof c.id !== 'string' || !c.id.trim()) p.push(`${ou} : "id" manquant.`);
    if (!NIVEAUX.includes(c.niveau)) p.push(`${ou} : "niveau" doit valoir mfe ou shell.`);
    if (!STATUTS[PASSE].includes(c.statut)) p.push(`${ou} : "statut" doit valoir ${STATUTS[PASSE].join(', ')}.`);
    if (typeof c.preuve !== 'string' || !c.preuve.trim()) p.push(`${ou} : "preuve" manquante.`);
    if (typeof c.id === 'string' && NIVEAUX.includes(c.niveau)) {
      if (!parCritere.has(c.id)) parCritere.set(c.id, new Map());
      parCritere.get(c.id).set(c.niveau, c.statut);
    }
  });

  // Chaque critère testable doit avoir ses deux niveaux : le MFE seul et le shell.
  for (const [id, niveaux] of parCritere) {
    if ([...niveaux.values()].every((s) => s === 'non_testable')) continue;
    for (const niveau of NIVEAUX) {
      if (!niveaux.has(niveau)) p.push(`Le critère ${id} n'a pas de test au niveau ${niveau}.`);
    }
  }
  if (v.criteres.some((c) => c?.statut === 'non_testable') && v.questions_spec.length === 0) {
    p.push('Un critère "non_testable" doit s\'accompagner d\'une question dans "questions_spec".');
  }
  return p;
}

// Passe 1 : les tests existent et échouent avant l'implémentation.
function verifierPasse1(v) {
  const p = [];
  const shell = v.criteres.filter((c) => c.niveau === 'shell' && c.statut === 'ecrit');
  if (shell.length && !existsSync(join(PROJET, 'e2e', `${v.ticket}.spec.ts`))) {
    p.push(`Le fichier e2e/${v.ticket}.spec.ts est introuvable : écris les scénarios du niveau shell.`);
  }
  const mfe = v.criteres.filter((c) => c.niveau === 'mfe' && c.statut === 'ecrit');
  if (mfe.length) {
    const vitest = lireRapport('vitest.json');
    if (vitest === null) {
      p.push('Lance npm run test:affected : les nouveaux tests doivent échouer avant l\'implémentation.');
    } else if (vitest === undefined) {
      p.push('Le rapport reports/vitest.json est illisible : relance npm run test:affected.');
    } else if ((vitest.numFailedTests ?? 0) < mfe.length) {
      p.push(
        `Seulement ${vitest.numFailedTests ?? 0} test(s) en échec pour ${mfe.length} critère(s) au niveau MFE : ` +
          'un test qui passe avant l\'implémentation ne teste pas la nouveauté.',
      );
    }
  }
  return p;
}

// Passe 2 : le verdict doit concorder avec les rapports de tests réels.
function verifierPasse2(v) {
  const vitest = lireRapport('vitest.json');
  const playwright = lireRapport('playwright.json');
  if (vitest === undefined || playwright === undefined) return ['Un rapport de tests est illisible : relance les tests.'];
  if (!vitest && !playwright) return ['Aucun rapport de tests : lance les tests avant de rendre ton verdict.'];

  const p = [];
  const echecsMfe = vitest?.numFailedTests ?? 0;
  const echecs = echecsMfe + (playwright?.stats?.unexpected ?? 0);
  const instables = playwright?.stats?.flaky ?? 0;
  const statuts = v.criteres.map((c) => c.statut);

  if (v.verdict === 'pass') {
    if (echecs > 0) p.push(`Ton verdict est "pass", mais les rapports contiennent ${echecs} test(s) en échec.`);
    if (!playwright) p.push('Le niveau shell n\'a pas été lancé : un verdict "pass" exige les deux niveaux.');
    if (statuts.some((s) => s !== 'pass')) p.push('Un verdict "pass" exige le statut "pass" pour chaque critère, aux deux niveaux.');
  }
  if (v.verdict === 'fail') {
    if (echecs === 0) p.push('Ton verdict est "fail", mais les rapports ne contiennent aucun test en échec.');
    if (!statuts.includes('fail')) p.push('Un verdict "fail" doit désigner au moins un critère en échec.');
  }
  if (statuts.includes('non_lance') && echecsMfe === 0) {
    p.push('Le statut "non_lance" n\'est permis que si le niveau MFE a échoué.');
  }
  if (instables > 0 && v.tests_instables.length === 0) {
    p.push(`${instables} test(s) instable(s) dans le rapport Playwright : liste-les dans "tests_instables".`);
  }
  return p;
}

function verifier(v) {
  if (!v) return ['Termine par le JSON du verdict, et rien d\'autre.'];
  const structure = verifierStructure(v);
  if (structure.length) return structure;
  if (v.verdict === 'blocked') {
    return v.questions_spec.length ? [] : ['Un verdict "blocked" doit poser au moins une question dans "questions_spec".'];
  }
  const criteres = verifierCriteres(v);
  if (criteres.length) return criteres;
  return PASSE === 1 ? verifierPasse1(v) : verifierPasse2(v);
}

try {
  let entree;
  try {
    entree = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    refuser(['Entrée du contrôle illisible.']);
  }
  // Le compteur de renvois est propre à chaque exécution : un lancement de run-qa.sh
  // (QA_RUN_ID), sinon une invocation de sous-agent (agent_id), sinon la session.
  const execution = process.env.QA_RUN_ID || entree.agent_id || entree.session_id;
  if (PASSE !== 1 && PASSE !== 2) refuser(['Passe inconnue : attendu 1 ou 2.'], execution);

  const verdict = extraireVerdict(entree.last_assistant_message);
  const problemes = verifier(verdict);
  if (problemes.length) refuser(problemes, execution);
  if (FINAL) console.log(JSON.stringify(verdict));
  process.exit(0);
} catch (erreur) {
  refuser([`erreur interne du contrôle (${erreur.message}).`], 'erreur');
}
