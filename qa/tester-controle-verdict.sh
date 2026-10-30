#!/usr/bin/env bash
# Démontre le contrôle du verdict : chaque cas simule la fin de l'agent QA
# et vérifie que l'arrêt est accepté (0) ou que l'agent est renvoyé au travail (2).
# Usage : qa/tester-controle-verdict.sh

cd "$(dirname "$0")/.." || exit 1
CONTROLE="$PWD/.claude/hooks/controle-verdict.mjs"
PROJET="$(mktemp -d)"
export TMPDIR="$(mktemp -d)" CLAUDE_PROJECT_DIR="$PROJET"
trap 'rm -rf "$PROJET" "$TMPDIR"' EXIT
mkdir -p "$PROJET/reports" "$PROJET/e2e"

echecs=0
n=0
cas() {
  local attendu="$1" description="$2" passe="$3" message="$4" option="${5:-}"
  n=$((n + 1))
  local entree code
  entree="$(jq -cn --arg m "$message" --arg s "cas-$n" '{last_assistant_message: $m, session_id: $s}')"
  printf '%s' "$entree" | node "$CONTROLE" "$passe" $option >/dev/null 2>&1
  code=$?
  if [[ "$code" == "$attendu" ]]; then
    [[ "$code" == 0 ]] && printf '  ok   accepté   %s\n' "$description" \
                       || printf '  ok   renvoyé   %s\n' "$description"
  else
    printf '  ÉCHEC (code %s, attendu %s)  %s\n' "$code" "$attendu" "$description"
    echecs=$((echecs + 1))
  fi
}
rapports() {  # rapports <échecs vitest|absent> <échecs playwright|absent> [instables]
  rm -f "$PROJET/reports/"*.json
  [[ "$1" != absent ]] && echo "{\"numFailedTests\": $1, \"numPassedTests\": 5}" > "$PROJET/reports/vitest.json"
  [[ "$2" != absent ]] && echo "{\"stats\": {\"expected\": 3, \"unexpected\": $2, \"flaky\": ${3:-0}}}" > "$PROJET/reports/playwright.json"
  return 0
}
verdict() {  # verdict <passe> <verdict> <statut mfe> <statut shell> [champ jq supplémentaire]
  jq -cn --argjson p "$1" --arg v "$2" --arg sm "$3" --arg ss "$4" "
    {ticket: \"TICKET-42\", passe: \$p, verdict: \$v,
     criteres: [range(1; 4) as \$i | (\"mfe\", \"shell\") as \$n |
       {id: \"AC-\(\$i)\", niveau: \$n, statut: (if \$n == \"mfe\" then \$sm else \$ss end), preuve: \"test AC-\(\$i)\"}],
     tests_instables: [], questions_spec: [], alertes: []} ${5:-}"
}

echo "Passe 1 : écrire les tests"
touch "$PROJET/e2e/TICKET-42.spec.ts"
rapports 3 absent
cas 0 "verdict complet, tests en échec comme attendu"  1 "$(verdict 1 pret ecrit ecrit)"
cas 0 "verdict dans un bloc json entouré de texte"     1 "Voici le verdict :
\`\`\`json
$(verdict 1 pret ecrit ecrit)
\`\`\`"
cas 2 "pas de JSON du tout"                            1 "J'ai écrit les tests."
cas 2 "un critère sans test au niveau shell"           1 "$(verdict 1 pret ecrit ecrit '| .criteres |= map(select(.id != "AC-3" or .niveau != "shell"))')"
cas 2 "mauvaise valeur de passe"                       1 "$(verdict 2 pret ecrit ecrit)"
cas 2 "statut inconnu"                                 1 "$(verdict 1 pret pass ecrit)"
cas 2 "preuve manquante"                               1 "$(verdict 1 pret ecrit ecrit '| .criteres[0].preuve = ""')"
cas 2 "bloqué sans question"                           1 "$(verdict 1 blocked ecrit ecrit)"
cas 0 "bloqué avec une question"                       1 "$(verdict 1 blocked ecrit ecrit '| .questions_spec = ["La casse compte-t-elle ?"]')"
cas 0 "critère non testable avec sa question"          1 "$(verdict 1 pret ecrit ecrit '| .criteres |= map(if .id == "AC-3" then .statut = "non_testable" else . end) | .questions_spec = ["AC-3 : quel message ?"]')"
rapports 1 absent
cas 2 "tests qui passent déjà avant l'implémentation"  1 "$(verdict 1 pret ecrit ecrit)"
rapports absent absent
cas 2 "tests jamais lancés"                            1 "$(verdict 1 pret ecrit ecrit)"
rapports 3 absent; rm -f "$PROJET/e2e/TICKET-42.spec.ts"
cas 2 "scénarios du shell non écrits"                  1 "$(verdict 1 pret ecrit ecrit)"

echo "Passe 2 : vérifier"
rapports 0 0
cas 0 "tout passe, verdict pass"                       2 "$(verdict 2 pass pass pass)"
rapports 1 0
cas 2 "verdict pass malgré un échec dans les rapports" 2 "$(verdict 2 pass pass pass)"
rapports 0 absent
cas 2 "verdict pass sans avoir lancé le niveau shell"  2 "$(verdict 2 pass pass pass)"
rapports 1 absent
cas 0 "échec au niveau MFE, shell non lancé"           2 "$(verdict 2 fail pass non_lance '| .criteres[2].statut = "fail"')"
rapports 0 0
cas 2 "verdict fail sans aucun échec"                  2 "$(verdict 2 fail pass pass '| .criteres[2].statut = "fail"')"
cas 2 "shell non lancé alors que le MFE passe"         2 "$(verdict 2 fail pass non_lance '| .criteres[2].statut = "fail"')"
rapports 0 0 1
cas 2 "test instable non signalé"                      2 "$(verdict 2 pass pass pass)"
cas 0 "test instable signalé"                          2 "$(verdict 2 pass pass pass '| .tests_instables = ["AC-3 shell"]')"
rapports absent absent
cas 2 "aucun rapport de tests"                         2 "$(verdict 2 pass pass pass)"

echo "Limite des renvois et validation finale"
entree="$(jq -cn --arg m 'pas de verdict' '{last_assistant_message: $m, session_id: "boucle"}')"
codes=""
for _ in 1 2 3 4; do printf '%s' "$entree" | node "$CONTROLE" 2 >/dev/null 2>&1; codes+="$? "; done
n=$((n + 1))
if [[ "$codes" == "2 2 2 0 " ]]; then
  echo "  ok   accepté   arrêt autorisé après 3 renvois, pour ne pas boucler"
else
  echo "  ÉCHEC (codes $codes)  limite des renvois"; echecs=$((echecs + 1))
fi
rapports 0 0
cas 0 "validation finale d'un verdict valide"          2 "$(verdict 2 pass pass pass)" --final
cas 2 "validation finale d'un verdict invalide"        2 "pas de verdict" --final

echo
if [[ "$echecs" == 0 ]]; then
  echo "Les $n cas sont conformes."
else
  echo "$echecs cas non conformes sur $n."
  exit 1
fi
