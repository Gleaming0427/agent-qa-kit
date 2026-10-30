# Agent QA

Deux agents QA qui prouvent que chaque micro-frontend (MFE) modifié respecte la spec Jira, d'abord seul puis intégré dans le shell. Le premier écrit les tests, le second les exécute sans pouvoir modifier aucun fichier. Aucun des deux ne peut toucher au code, et un contrôle automatique refuse tout verdict incomplet ou contredit par les rapports de tests.

## Ce que contient le kit

| Fichier | Rôle |
|---|---|
| `.claude/agents/agent-qa-ecriture.md` | Passe 1 : écrit les tests (Sonnet) |
| `.claude/agents/agent-qa-verification.md` | Passe 2 : exécute les tests, sans aucun outil d'écriture (Haiku, effort bas) |
| `.claude/hooks/garde-fou-qa.sh` | Le garde-fou, qui contrôle chaque action avant qu'elle s'exécute |
| `.claude/hooks/controle-verdict.mjs` | Le contrôle du verdict, qui empêche l'agent de terminer avec un verdict invalide |
| `.claude/qa-settings.json` | Les réglages de sécurité du mode pipeline : permissions, hooks, bac à sable |
| `qa/run-qa.sh` | Le lanceur, appelé par l'orchestrateur |
| `qa/summary.mjs` | Le résumé condensé des résultats de tests |
| `qa/check-scope.sh` | Le contrôle CI : chacun reste dans son couloir |
| `qa/tester-garde-fou.sh` | La démonstration du garde-fou (36 cas) |
| `qa/tester-controle-verdict.sh` | La démonstration du contrôle du verdict (25 cas) |
| `playwright.config.ts` | La configuration des tests dans le shell |
| `.github/workflows/garde-qa.yml` | Les contrôles exécutés sur chaque PR |
| `specs/TICKET-42.md` | Une spec d'exemple |

## Comment il fonctionne

**Passe 1, dès que la spec est prête : `agent-qa-ecriture`.** Pour chaque critère d'acceptation, il écrit un test de composant (le MFE seul, avec un faux shell) et un scénario Playwright (le MFE dans le vrai shell). Il vérifie ensuite que ses tests échouent : rien n'est encore codé, donc un test qui passe déjà ne teste pas la nouveauté.

**Passe 2, à chaque livraison de l'agent de dev : `agent-qa-verification`.** Il lance les tests du MFE modifié puis, s'ils passent, les scénarios dans le shell. Il rend un verdict : `pass`, `fail`, ou `blocked` si la spec ne permet pas de conclure. Il n'a aucun outil d'écriture : il ne peut pas « réparer » un test, seulement rapporter l'échec.

**Le contrôle du verdict, avant chaque arrêt.** Quand un agent veut terminer, un hook de fin vérifie son verdict :
- le JSON est complet, et chaque critère a ses deux tests, au niveau MFE et au niveau shell ;
- en passe 1, les scénarios du shell existent et les nouveaux tests échouent bien ;
- en passe 2, le verdict concorde avec les rapports de tests réels : pas de « pass » s'il reste un échec, pas de « fail » sans échec, tests instables signalés.

Si quelque chose ne va pas, l'agent est renvoyé au travail avec la liste précise de ce qu'il doit corriger, trois fois au maximum. C'est le principe des évaluateurs séparés, mais en version déterministe : le contrôle ne coûte aucun token.

## Sécurité : cinq verrous

1. **Des outils retirés.** L'agent de vérification n'a ni Write ni Edit : la règle « ne jamais modifier un test » ne dépend pas d'une consigne, elle est impossible à enfreindre.
2. **Les permissions** (`qa-settings.json`). L'agent d'écriture ne peut écrire que des fichiers de test, et les deux agents ne lancent que des commandes de test. Ils ne lisent pas les secrets, n'accèdent pas au web et ne poussent pas sur git.
3. **Le garde-fou** (`garde-fou-qa.sh`). Avant chaque action, il vérifie ce que l'agent s'apprête à faire et refuse ce qui sort du cadre. Il bloque aussi les tests désactivés (`.skip`, `.only`, `.fixme`) et la mise à jour des snapshots.
4. **Le bac à sable.** Les commandes tournent isolées au niveau du système, sans réseau. Si le bac à sable n'est pas disponible, l'agent refuse de démarrer.
5. **La CI.** Elle vérifie que la branche QA ne contient que des tests, que l'agent de dev n'a modifié aucun test, puis elle rejoue tous les tests sur le code réel, hors de l'environnement des agents.

La spec est transmise comme une donnée, jamais comme une instruction : un texte qui tenterait de donner des ordres à l'agent est ignoré et signalé dans `alertes`.

## Coût

| Passe | Modèle | Plafond par défaut |
|---|---|---|
| 1 : écrire les tests | Sonnet, effort moyen | 1,00 $ |
| 2 : vérifier | Haiku 5.5, effort bas | 0,20 $ |

- La passe 2 est mécanique : Haiku 5.5 suffit, et coûte environ 20 fois moins cher que Sonnet en entrée tant que chaque requête reste sous 100 000 tokens. Au-delà, toute la requête passe au tarif supérieur.
- L'agent lit `npm run test:summary`, jamais les logs complets. Sur l'exemple testé, le rapport brut faisait environ 18 000 caractères, le résumé environ 700. C'est ce qui garde la passe 2 sous le seuil de 100 000 tokens.
- Le niveau MFE passe avant le shell : s'il échoue, le niveau shell n'est pas lancé.
- Chaque verdict enregistre son coût réel (`cout_usd`) dans `reports/`.

Le modèle, l'effort et le nombre maximal de tours se règlent dans l'en-tête de chaque agent : le lanceur les y lit.

## Installation

1. Copiez `.claude/`, `qa/`, `playwright.config.ts` et `.github/workflows/garde-qa.yml` à la racine du dépôt.
2. Ajoutez ces scripts au `package.json` :

   ```json
   {
     "scripts": {
       "test:affected": "vitest run --changed origin/master --reporter=dot --reporter=json --outputFile.json=reports/vitest.json",
       "test:e2e": "playwright test",
       "test:summary": "node qa/summary.mjs"
     }
   }
   ```

   Le contrôle du verdict s'appuie sur `reports/vitest.json` et `reports/playwright.json` : gardez ces chemins.
3. Sous Linux, installez le bac à sable : `sudo apt-get install bubblewrap socat`. Rien à installer sous macOS.
4. Adaptez à votre dépôt :
   - la commande de démarrage du shell dans `playwright.config.ts` ;
   - le nom de la branche principale (`origin/master`) ;
   - les emplacements des tests, définis à trois endroits à garder alignés : `garde-fou-qa.sh`, `qa-settings.json` et `check-scope.sh`.

## Utilisation

**Dans la chaîne, appelé par l'orchestrateur :**

```bash
qa/run-qa.sh TICKET-42 1 specs/TICKET-42.md services   # passe 1 : écrire les tests
qa/run-qa.sh TICKET-42 2 specs/TICKET-42.md services   # passe 2 : vérifier une livraison
```

Le code de sortie indique la suite : `0` prêt ou validé, `1` échec (renvoyer à l'agent de dev), `2` bloqué (question à un humain), `3` erreur, budget dépassé ou verdict invalide. Le verdict est écrit dans `reports/TICKET-42-passe2.json`. Pour voir les réglages sans rien lancer : `QA_DRY_RUN=1 qa/run-qa.sh ...`.

**En démonstration, dans Claude Code :**

> Utilise l'agent agent-qa-verification pour le ticket TICKET-42, MFE services. La spec est dans specs/TICKET-42.md.

Dans ce mode, les permissions et le bac à sable de `qa-settings.json` ne s'appliquent pas. Les hooks déclarés dans les agents (garde-fou et contrôle du verdict) ne s'exécutent que si Claude Code fait confiance au dossier, ce qu'il demande à la première ouverture. La protection complète passe par `run-qa.sh`.

Pour montrer les verrous en action, sans rien dépenser :

```bash
qa/tester-garde-fou.sh          # ce que l'agent a le droit de faire, et ce qui lui est refusé
qa/tester-controle-verdict.sh   # les verdicts acceptés, et ceux qui renvoient l'agent au travail
```

## Démarrer prudemment

Pendant deux ou trois semaines, laissez les agents tourner sans bloquer : ignorez leur code de sortie et comparez leurs verdicts avec ce que constatent les humains, en vrais bugs attrapés et en fausses alertes. Donnez-leur le droit de veto une fois ces chiffres satisfaisants.

## Ce qui a été vérifié

Avec Claude Code 2.1.314 :

- **passe 2 réelle avec Haiku 5.5** sur un projet d'essai où un critère échouait au niveau MFE : verdict `fail` sur ce critère, niveau shell non lancé, environ 1 centime, code de sortie 1 ;
- **renvoi au travail réel** : lors d'une passe 2, le contrôle a refusé un premier verdict, l'agent l'a corrigé, puis le verdict a été accepté ;
- le hook de fin reçoit bien le dernier message de l'agent, et un refus le fait effectivement reprendre ;
- en mode pipeline, l'écriture dans le code et l'ajout d'un `test.skip` ont été refusés, et l'écriture d'un fichier de test acceptée ;
- sans bac à sable disponible, l'agent refuse de démarrer ;
- le garde-fou (36 cas) et le contrôle du verdict (25 cas) se comportent comme attendu ;
- `qa/summary.mjs` résume correctement un vrai rapport Playwright ;
- `qa/check-scope.sh` a été validé sur sept scénarios dans un dépôt git de test.

Non vérifié : en mode démo, dans un dossier qui n'était pas marqué « de confiance », les hooks du sous-agent ne se sont pas déclenchés, conformément à la règle de Claude Code. Le comportement dans un dossier de confiance n'a pas pu être testé ici.

## Limites connues

- Sous Linux, si Chromium refuse de démarrer dans le bac à sable, lancez les tests du niveau shell dans un conteneur dédié plutôt que de désactiver le bac à sable.
- En mode démo, les hooks des agents dépendent de la confiance accordée au dossier : la CI reste le dernier verrou.
- Le contrôle de la passe 1 vérifie qu'il y a au moins autant de tests en échec que de critères au niveau MFE. C'est un indicateur, pas une preuve test par test.
- Les estimations de coût sont des ordres de grandeur : mesurez.
- Les chemins, les commandes et le faux shell sont des exemples à adapter à votre code.
- Ce kit assemble des pratiques éprouvées (évaluateur séparé, boucles de vérification, tests ciblés), mais il n'existe pas de recette publiée clés en main pour des agents QA de micro-frontends.
