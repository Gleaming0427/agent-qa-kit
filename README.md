# Agent QA

Un agent QA qui prouve que chaque micro-frontend (MFE) modifié respecte la spec Jira, d'abord seul puis intégré dans le shell. Il ne peut jamais toucher au code, et il coûte quelques dizaines de centimes par ticket.

## Ce que contient le kit

| Fichier | Rôle |
|---|---|
| `.claude/agents/agent-qa.md` | L'agent : ses règles, ses deux passes et le format du verdict |
| `.claude/hooks/garde-fou-qa.sh` | Le garde-fou, qui contrôle chaque action de l'agent avant qu'elle s'exécute |
| `.claude/qa-settings.json` | Les réglages de sécurité : permissions, garde-fou, bac à sable |
| `qa/run-qa.sh` | Le lanceur, appelé par l'orchestrateur |
| `qa/verdict.schema.json` | Le format imposé au verdict |
| `qa/summary.mjs` | Le résumé condensé des résultats de tests |
| `qa/check-scope.sh` | Le contrôle CI : chacun reste dans son couloir |
| `qa/tester-garde-fou.sh` | La démonstration du garde-fou (36 cas) |
| `playwright.config.ts` | La configuration des tests dans le shell |
| `.github/workflows/garde-qa.yml` | Les contrôles exécutés sur chaque PR |
| `specs/TICKET-42.md` | Une spec d'exemple |

## Comment il fonctionne

**Passe 1, dès que la spec est prête.** Pour chaque critère d'acceptation, l'agent écrit un test de composant (le MFE seul, avec un faux shell) et un scénario Playwright (le MFE dans le vrai shell). Il vérifie ensuite que ses tests échouent : rien n'est encore codé, donc un test qui passe déjà ne teste pas la nouveauté.

**Passe 2, à chaque livraison de l'agent de dev.** L'agent lance les tests du MFE modifié, puis, s'ils passent, les scénarios dans le shell. Il rend un verdict : `pass`, `fail`, ou `blocked` si la spec ne permet pas de conclure.

## Sécurité : quatre verrous

1. **Les permissions** (`qa-settings.json`). L'agent ne peut écrire que des fichiers de test et ne peut lancer que des commandes de test. Il ne peut ni lire les fichiers de secrets, ni accéder au web, ni pousser sur git.
2. **Le garde-fou** (`garde-fou-qa.sh`). Avant chaque action, il vérifie ce que l'agent s'apprête à faire et refuse ce qui sort du cadre. Il bloque aussi les tests désactivés (`.skip`, `.only`, `.fixme`) et la mise à jour des snapshots, deux façons discrètes de faire passer un test sans corriger le code.
3. **Le bac à sable.** Les commandes de l'agent tournent isolées au niveau du système, sans accès au réseau. Même un test écrit par l'agent qui tenterait quelque chose à l'exécution reste enfermé. Et si le bac à sable n'est pas disponible, l'agent refuse de démarrer.
4. **La CI.** Elle vérifie que la branche de l'agent QA ne contient que des tests, et que l'agent de dev n'a modifié aucun test de l'agent QA. Puis elle rejoue tous les tests sur le code réel, hors de l'environnement des agents. Ce verrou ne dépend pas des agents : même si un autre verrou était contourné, la PR ne pourrait pas être fusionnée.

Enfin, la spec est transmise à l'agent comme une donnée, jamais comme une instruction. S'il y trouve un texte qui tente de lui donner des ordres, il l'ignore et le signale dans `alertes`.

## Coût : cinq économies

1. **Un modèle adapté** : Sonnet par défaut, modifiable avec `QA_MODELE`.
2. **Un plafond par passe** : 1 $ pour la passe 1, 0,50 $ pour la passe 2, modifiable avec `QA_BUDGET_USD`. Au-delà, l'agent s'arrête.
3. **Un résumé plutôt que les logs** : l'agent lit `npm run test:summary`, jamais les logs complets. Sur l'exemple testé, le rapport brut faisait environ 18 000 caractères, le résumé environ 700.
4. **Le niveau MFE d'abord** : s'il échoue, le niveau shell, plus lent, n'est pas lancé.
5. **Seulement ce qui est touché** : les tests du MFE modifié, pas toute la suite.

Chaque verdict enregistre son coût réel (`cout_usd`) dans `reports/`. Mesurez sur quelques tickets plutôt que de vous fier aux estimations.

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

   Dans un monorepo Lerna, `test:affected` peut aussi s'écrire `lerna run test --since origin/master`.
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

Le code de sortie indique la suite : `0` prêt ou validé, `1` échec (renvoyer à l'agent de dev), `2` bloqué (question à un humain), `3` erreur ou budget dépassé. Le verdict est écrit dans `reports/TICKET-42-passe2.json`. Pour voir les réglages sans rien lancer : `QA_DRY_RUN=1 qa/run-qa.sh ...`.

**En démonstration, dans Claude Code :**

> Utilise l'agent agent-qa pour le ticket TICKET-42, passe 1, MFE services. La spec est dans specs/TICKET-42.md.

Attention : dans ce mode, seul le garde-fou s'applique. Les permissions et le bac à sable de `qa-settings.json` ne s'appliquent qu'en passant par `run-qa.sh`.

Pour montrer les verrous en action : `qa/tester-garde-fou.sh`.

## Démarrer prudemment

Pendant deux ou trois semaines, laissez l'agent tourner sans bloquer : ignorez son code de sortie et comparez ses verdicts avec ce que constatent les humains, en vrais bugs attrapés et en fausses alertes. Donnez-lui le droit de veto une fois ces chiffres satisfaisants.

## Ce qui a été vérifié

Avec Claude Code 2.1.314 :

- le garde-fou se comporte comme attendu sur les 36 cas de `qa/tester-garde-fou.sh` ;
- lors d'un essai réel en mode pipeline, l'écriture dans le code et l'ajout d'un `test.skip` ont été refusés, et l'écriture d'un fichier de test acceptée ;
- sans bac à sable disponible, l'agent refuse de démarrer ;
- `qa/summary.mjs` résume correctement un vrai rapport Playwright contenant un test réussi, un en échec et un instable ;
- `qa/check-scope.sh` a été validé sur sept scénarios dans un dépôt git de test.

## Limites connues

- Sous Linux, si Chromium refuse de démarrer dans le bac à sable, lancez les tests du niveau shell dans un conteneur dédié plutôt que de désactiver le bac à sable.
- Sur certaines versions de Claude Code, un bug a empêché les hooks déclarés dans un sous-agent de se déclencher. C'est une raison de plus pour garder la CI comme dernier verrou.
- Les estimations de coût sont des ordres de grandeur : mesurez.
- Les chemins, les commandes et le faux shell sont des exemples à adapter à votre code.
- Ce kit assemble des pratiques éprouvées (évaluateur séparé, boucles de vérification, tests ciblés), mais il n'existe pas de recette publiée clés en main pour un agent QA de micro-frontends.
