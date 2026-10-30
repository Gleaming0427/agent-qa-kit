#!/usr/bin/env bash
# Contrôle CI : chacun reste dans son couloir.
#
# Usage :
#   qa/check-scope.sh perimetre <base>
#       Sur la branche de l'agent QA : échoue si un fichier autre qu'un test
#       a été modifié par rapport à <base>.
#
#   qa/check-scope.sh figes <base> <branche-qa>
#       Sur la branche finale : échoue si un test écrit par l'agent QA a été
#       modifié ou supprimé depuis. L'agent de dev ne touche pas aux tests.
#
# Ce contrôle ne dépend pas des agents : même si un garde-fou était contourné
# pendant le travail, la PR ne pourrait pas être fusionnée.

set -uo pipefail

usage() {
  echo "usage : $0 perimetre <base> | $0 figes <base> <branche-qa>" >&2
  exit 2
}

est_un_test() {
  case "$1" in
    e2e/*.spec.ts|*.test.ts|*.test.tsx) return 0 ;;
    *) return 1 ;;
  esac
}

verifier_ref() {
  git rev-parse --verify --quiet "$1^{commit}" >/dev/null || {
    echo "Référence git inconnue : $1" >&2
    exit 2
  }
}

MODE="${1:-}"
case "$MODE" in
  perimetre)
    [[ $# -eq 2 ]] || usage
    BASE="$2"; verifier_ref "$BASE"
    hors_perimetre=()
    while IFS= read -r fichier; do
      [[ -n "$fichier" ]] || continue
      est_un_test "$fichier" || hors_perimetre+=("$fichier")
    done < <(git diff --name-only "$BASE"...HEAD)

    if (( ${#hors_perimetre[@]} > 0 )); then
      echo "La branche QA modifie des fichiers qui ne sont pas des tests :"
      printf '  %s\n' "${hors_perimetre[@]}"
      exit 1
    fi
    echo "Périmètre QA respecté : seuls des tests ont été modifiés."
    ;;

  figes)
    [[ $# -eq 3 ]] || usage
    BASE="$2"; QA="$3"; verifier_ref "$BASE"; verifier_ref "$QA"
    modifies=()
    while IFS= read -r fichier; do
      [[ -n "$fichier" ]] || continue
      est_un_test "$fichier" || continue
      git diff --quiet "$QA" HEAD -- "$fichier" || modifies+=("$fichier")
    done < <(git diff --name-only "$BASE"..."$QA")

    if (( ${#modifies[@]} > 0 )); then
      echo "Ces tests diffèrent de la version écrite par l'agent QA :"
      printf '  %s\n' "${modifies[@]}"
      echo "Toute modification de test doit être revue par un humain."
      exit 1
    fi
    echo "Tests figés : identiques à la version écrite par l'agent QA."
    ;;

  *)
    usage
    ;;
esac
