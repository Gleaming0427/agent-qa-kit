#!/usr/bin/env node
// Résumé condensé des résultats de tests, pour l'agent QA.
//
// Au lieu de lire des centaines de lignes de logs, l'agent lit ce résumé :
// les compteurs, les tests en échec avec un message tronqué, les tests
// instables et le chemin des traces. C'est la principale économie de tokens.
//
// Lit, s'ils existent :
//   reports/vitest.json      rapport JSON de Vitest (niveau MFE)
//   reports/playwright.json  rapport JSON de Playwright (niveau shell)
//
// Usage : node qa/summary.mjs   (ou npm run test:summary)

import { existsSync, readFileSync } from 'node:fs';

const LONGUEUR_MAX = 300;
const ECHECS_MAX = 10;

const nettoyer = (texte = '') =>
  String(texte)
    .replace(/\u001b\[[0-9;]*m/g, '') // codes couleur
    .replace(/\s+/g, ' ')
    .trim();

const tronquer = (texte) => {
  const propre = nettoyer(texte);
  return propre.length > LONGUEUR_MAX ? `${propre.slice(0, LONGUEUR_MAX)}…` : propre;
};

const lireJson = (chemin) => {
  if (!existsSync(chemin)) return null;
  try {
    return JSON.parse(readFileSync(chemin, 'utf8'));
  } catch {
    console.log(`${chemin} : rapport illisible.`);
    return null;
  }
};

function resumerVitest(rapport) {
  const echecs = [];
  for (const fichier of rapport.testResults ?? []) {
    for (const test of fichier.assertionResults ?? []) {
      if (test.status === 'failed') {
        echecs.push({
          titre: test.fullName ?? test.title,
          message: tronquer((test.failureMessages ?? []).join(' ')),
        });
      }
    }
  }
  const reussis = rapport.numPassedTests ?? 0;
  const echoues = rapport.numFailedTests ?? echecs.length;
  console.log(`Niveau MFE (Vitest) : ${reussis} réussis, ${echoues} en échec`);
  afficherEchecs(echecs);
}

function parcourirSuites(suites, chemin, tests) {
  for (const suite of suites ?? []) {
    const titres = suite.title ? [...chemin, suite.title] : chemin;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        tests.push({ titre: [...titres, spec.title].join(' › '), test });
      }
    }
    parcourirSuites(suite.suites, titres, tests);
  }
}

function resumerPlaywright(rapport) {
  const tests = [];
  parcourirSuites(rapport.suites, [], tests);

  const echecs = [];
  const instables = [];
  for (const { titre, test } of tests) {
    const resultats = test.results ?? [];
    const dernier = resultats.at(-1) ?? {};
    const trace = resultats
      .flatMap((r) => r.attachments ?? [])
      .find((a) => a.name === 'trace' && a.path)?.path;

    if (test.status === 'unexpected') {
      const erreur = dernier.error?.message ?? dernier.errors?.[0]?.message ?? 'échec sans message';
      echecs.push({ titre, message: tronquer(erreur), trace });
    } else if (test.status === 'flaky') {
      instables.push({ titre, trace });
    }
  }

  const stats = rapport.stats ?? {};
  console.log(
    `Niveau shell (Playwright) : ${stats.expected ?? 0} réussis, ` +
      `${stats.unexpected ?? echecs.length} en échec, ${stats.flaky ?? instables.length} instables`,
  );
  afficherEchecs(echecs);
  for (const { titre, trace } of instables) {
    console.log(`  ~ instable : ${titre}${trace ? ` (trace : ${trace})` : ''}`);
  }
}

function afficherEchecs(echecs) {
  for (const { titre, message, trace } of echecs.slice(0, ECHECS_MAX)) {
    console.log(`  ✗ ${titre}`);
    if (message) console.log(`    ${message}`);
    if (trace) console.log(`    trace : ${trace}`);
  }
  if (echecs.length > ECHECS_MAX) {
    console.log(`  … et ${echecs.length - ECHECS_MAX} autres échecs`);
  }
}

const vitest = lireJson('reports/vitest.json');
const playwright = lireJson('reports/playwright.json');

if (!vitest && !playwright) {
  console.log('Aucun rapport trouvé : lancez d’abord les tests.');
  process.exit(1);
}
if (vitest) resumerVitest(vitest);
if (playwright) resumerPlaywright(playwright);
