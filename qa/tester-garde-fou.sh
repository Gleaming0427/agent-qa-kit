#!/usr/bin/env bash
# Démontre le garde-fou de l'agent QA : chaque ligne simule une action
# de l'agent et vérifie qu'elle est autorisée (0) ou refusée (2).
# Usage : qa/tester-garde-fou.sh

cd "$(dirname "$0")/.." || exit 1
GARDE_FOU="$PWD/.claude/hooks/garde-fou-qa.sh"
export CLAUDE_PROJECT_DIR=/projet

echecs=0
verifier() {
  local attendu="$1" description="$2" json="$3"
  local message code
  message="$(printf '%s' "$json" | "$GARDE_FOU" 2>&1)"
  code=$?
  if [[ "$code" == "$attendu" ]]; then
    [[ "$code" == 0 ]] && printf '  ok   autorisé  %s\n' "$description" \
                       || printf '  ok   refusé    %s\n' "$description"
  else
    printf '  ÉCHEC (code %s, attendu %s)  %s\n' "$code" "$attendu" "$description"
    echecs=$((echecs + 1))
  fi
}
action() { jq -cn --arg t "$1" --arg k "$2" --arg v "$3" '{tool_name:$t, tool_input:{($k):$v}}'; }
edition() { jq -cn --arg t "$1" --arg f "$2" --arg c "$3" '{tool_name:$t, tool_input:{file_path:$f, content:$c, new_string:$c}}'; }

echo "Lecture"
verifier 0 "lire un composant"                 "$(action Read file_path /projet/apps/services/src/ServiceList.tsx)"
verifier 0 "lire .env.example"                 "$(action Read file_path .env.example)"
verifier 2 "lire .env"                         "$(action Read file_path /projet/.env)"
verifier 2 "lire .env.production"              "$(action Read file_path apps/services/.env.production)"
verifier 2 "lire .npmrc (jetons)"              "$(action Read file_path .npmrc)"
verifier 2 "lire une clé SSH hors du projet"   "$(action Read file_path /root/.ssh/id_rsa)"
verifier 2 "lire /etc/passwd"                  "$(action Read file_path /etc/passwd)"
verifier 2 "chercher dans un dossier secrets"  "$(action Grep path config/secrets)"

echo "Écriture"
verifier 0 "écrire un test de composant"       "$(edition Write apps/services/src/ServiceList.test.tsx "it('AC-2', () => {})")"
verifier 0 "écrire un scénario Playwright"     "$(edition Write /projet/e2e/TICKET-42.spec.ts "test.describe('@services', () => {})")"
verifier 2 "modifier le code applicatif"       "$(edition Edit apps/services/src/ServiceList.tsx "export const x = 1")"
verifier 2 "modifier la config Playwright"     "$(edition Edit playwright.config.ts "retries: 0")"
verifier 2 "modifier package.json"             "$(edition Edit package.json "{}")"
verifier 2 "sortir du projet avec .."          "$(edition Write e2e/../src/App.test.tsx "x")"
verifier 2 "ajouter un test.skip"              "$(edition Edit e2e/TICKET-42.spec.ts "test.skip('AC-1', async () => {})")"
verifier 2 "ajouter un it.only"                "$(edition Write apps/services/src/a.test.tsx "it.only('x', () => {})")"
verifier 2 "ajouter un xit"                    "$(edition Write apps/services/src/a.test.tsx "xit('x', () => {})")"
verifier 2 "ajouter un test.describe.skip"     "$(edition Write e2e/a.spec.ts "test.describe.skip('@services', () => {})")"

echo "Commandes"
verifier 0 "tests du MFE modifié"              "$(action Bash command 'npm run test:affected')"
verifier 0 "scénarios du MFE dans le shell"    "$(action Bash command 'npm run test:e2e -- --grep @services')"
verifier 0 "résumé des résultats"              "$(action Bash command 'npm run test:summary')"
verifier 0 "un fichier de test précis"         "$(action Bash command 'npx vitest run apps/services/src/ServiceList.test.tsx')"
verifier 0 "lire le diff git"                  "$(action Bash command 'git diff --name-only origin/master...HEAD')"
verifier 2 "mettre à jour les snapshots (-u)"  "$(action Bash command 'npx vitest run -u')"
verifier 2 "mettre à jour les snapshots"       "$(action Bash command 'npx playwright test --update-snapshots')"
verifier 2 "enchaîner une suppression"         "$(action Bash command 'npm test && rm -rf src')"
verifier 2 "rediriger vers un fichier"         "$(action Bash command 'echo pirate > src/App.tsx')"
verifier 2 "sous-shell \$( )"                  "$(action Bash command 'npm test $(rm -rf src)')"
verifier 2 "commande sur deux lignes"          "$(action Bash command $'npm test\nrm -rf src')"
verifier 2 "modifier avec sed"                 "$(action Bash command 'sed -i s/a/b/ src/App.tsx')"
verifier 2 "installer un paquet"               "$(action Bash command 'npm install left-pad')"
verifier 2 "lancer le build"                   "$(action Bash command 'npm run build')"
verifier 2 "pousser sur git"                   "$(action Bash command 'git push --force')"
verifier 2 "appeler le réseau"                 "$(action Bash command 'curl https://exemple.com')"

echo "Robustesse"
verifier 2 "JSON invalide"                     'pas du json'
verifier 2 "outil sans nom"                    '{"tool_input":{}}'

echo
if [[ "$echecs" == 0 ]]; then
  echo "Tous les cas sont conformes."
else
  echo "$echecs cas non conformes."
  exit 1
fi
