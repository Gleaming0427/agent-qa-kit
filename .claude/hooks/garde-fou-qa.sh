#!/usr/bin/env bash
# Garde-fou de l'agent QA : hook PreToolUse de Claude Code.
#
# Claude Code appelle ce script avant chaque action de l'agent QA et lui
# transmet l'action en JSON sur l'entrée standard.
#   - code de sortie 0 : action autorisée ;
#   - code de sortie 2 : action refusée, le message (stderr) est renvoyé à l'agent.
# Tout autre code ne bloque PAS l'action : le script échoue donc « fermé »,
# c'est-à-dire qu'il refuse dès que quelque chose d'inattendu se produit.
#
# Ce qu'il impose :
#   - lecture : uniquement dans le projet, jamais les fichiers de secrets ;
#   - écriture : uniquement des fichiers de test, sans désactiver de test ;
#   - commandes : uniquement les commandes de test et la lecture de git.

refuser() { echo "Refusé par le garde-fou QA : $1" >&2; exit 2; }

command -v jq >/dev/null 2>&1 || refuser "jq est requis."
[[ -n "${CLAUDE_PROJECT_DIR:-}" ]] || refuser "CLAUDE_PROJECT_DIR est absent."
PROJET="${CLAUDE_PROJECT_DIR%/}"

ENTREE="$(cat)" || refuser "entrée illisible."
OUTIL="$(jq -r '.tool_name // empty' <<<"$ENTREE" 2>/dev/null)" || refuser "JSON invalide."
[[ -n "$OUTIL" ]] || refuser "nom d'outil manquant."

# Vérifie qu'un chemin reste dans le projet ; affiche le chemin relatif.
chemin_relatif() {
  local chemin="$1"
  [[ -n "$chemin" ]] || refuser "chemin manquant."
  [[ "$chemin" != *..* ]] || refuser "chemin avec « .. » interdit ($chemin)."
  if [[ "$chemin" == /* ]]; then
    [[ "$chemin" == "$PROJET" || "$chemin" == "$PROJET"/* ]] || refuser "accès hors du projet interdit ($chemin)."
    chemin="${chemin#"$PROJET"}"
    chemin="${chemin#/}"
  fi
  printf '%s' "${chemin#./}"
}

# Refuse les fichiers et dossiers qui contiennent des secrets.
verifier_pas_de_secret() {
  local rel="$1" nom="${1##*/}"
  case "$nom" in
    .env.example|.env.sample) return 0 ;;
    .env|.env.*|*.pem|*.key|*.p12|*.pfx|id_rsa*|id_ed25519*|.npmrc|.yarnrc.yml|.netrc|.pgpass)
      refuser "lecture d'un fichier de secrets interdite ($rel)." ;;
  esac
  case "/$rel/" in
    */.ssh/*|*/.aws/*|*/.gnupg/*|*/.kube/*|*/secrets/*)
      refuser "lecture d'un dossier de secrets interdite ($rel)." ;;
  esac
}

case "$OUTIL" in
  Read)
    REL="$(chemin_relatif "$(jq -r '.tool_input.file_path // empty' <<<"$ENTREE")")" || exit 2
    verifier_pas_de_secret "$REL"
    exit 0
    ;;

  Grep|Glob)
    CHEMIN="$(jq -r '.tool_input.path // empty' <<<"$ENTREE")"
    [[ -z "$CHEMIN" ]] && exit 0  # sans chemin : recherche dans le projet
    REL="$(chemin_relatif "$CHEMIN")" || exit 2
    verifier_pas_de_secret "$REL"
    exit 0
    ;;

  Write|Edit)
    REL="$(chemin_relatif "$(jq -r '.tool_input.file_path // empty' <<<"$ENTREE")")" || exit 2
    case "$REL" in
      e2e/*.spec.ts|*.test.ts|*.test.tsx) ;;
      *) refuser "l'agent QA n'écrit que des fichiers de test ($REL)." ;;
    esac
    CONTENU="$(jq -r '.tool_input.content // .tool_input.new_string // empty' <<<"$ENTREE")"
    DESACTIVE='(^|[^A-Za-z0-9_$])((it|test|describe)\.(skip|only|fixme|todo)|x(it|describe|test))[[:space:]]*\('
    if grep -Eq "$DESACTIVE" <<<"$CONTENU"; then
      refuser "désactiver ou isoler un test est interdit (.skip, .only, .fixme, .todo)."
    fi
    exit 0
    ;;

  Bash)
    CMD="$(jq -r '.tool_input.command // empty' <<<"$ENTREE")"
    [[ -n "$CMD" ]] || refuser "commande vide."
    # Une commande, une action : pas d'enchaînement, de redirection ni de sous-shell.
    [[ "$CMD" != *$'\n'* ]] || refuser "commande sur plusieurs lignes interdite."
    META='[;&|<>`]'
    if [[ "$CMD" =~ $META || "$CMD" == *'$('* ]]; then
      refuser "enchaînement ou redirection interdits ($CMD)."
    fi
    # Mettre à jour les snapshots reviendrait à réécrire le résultat attendu.
    MAJ='(^| )(-u|--update[A-Za-z-]*)( |=|$)'
    [[ "$CMD" =~ $MAJ ]] && refuser "mise à jour des snapshots interdite ($CMD)."
    AUTORISE='^(npm (test|run test(:[a-z0-9-]+)?)|npx (vitest run|playwright test)|git (diff|status|log))( |$)'
    [[ "$CMD" =~ $AUTORISE ]] && exit 0
    refuser "commande non autorisée pour l'agent QA ($CMD)."
    ;;

  *)
    exit 0
    ;;
esac
