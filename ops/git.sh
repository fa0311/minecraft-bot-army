#!/bin/bash
# git wrapper for this workspace: the directory is owned by another user and ~/.gitconfig is read-only, so the settings ride on the command line.
#   ops/git.sh <any git command>
#   ops/git.sh publish ["message"]   = add -A + commit (no GPG) + push to origin (PUBLIC: github.com/fa0311/minecraft-bot-army). The token comes
#                                      from $GITHUB_TOKEN through a one-shot credential helper: never in the remote URL, never in a file.
#                                      Refuses when a staged file holds a token, the rcon password or a non-documentation IPv4 address.
G=(git -c safe.directory=/root/workspace -c commit.gpgsign=false -c user.name=fa0311-army -c user.email=noreply@localhost)
if [ "$1" = publish ]; then
  cd /root/workspace || exit 1; "${G[@]}" add -A
  PW=$(cat server/.rcon_pw 2>/dev/null)
  BAD=$("${G[@]}" grep --cached -n -I -E "ghp_[A-Za-z0-9]{10,}|github_pat_|sk-ant-|BEGIN (RSA|OPENSSH|PRIVATE)" -- . ':!ops/git.sh' | cut -c1-80
        [ -n "$PW" ] && "${G[@]}" grep --cached -n -I -F "$PW" | cut -d: -f1,2
        "${G[@]}" grep --cached -n -I -E "\b([0-9]{1,3}\.){3}[0-9]{1,3}\b" | grep -v -E "127\.|0\.0\.0\.0|192\.168\.|10\.0\.0\.|203\.0\.113\.|198\.51\.100\.|192\.0\.2\.|192\.169\.0\.1" | cut -d: -f1,2)
  [ -n "$BAD" ] && { echo "publish REFUSED - secrets/addresses staged:"; echo "$BAD" | head; exit 1; }
  "${G[@]}" diff --cached --quiet || "${G[@]}" commit -q -m "${2:-Update $(date -u +%F)}

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
  exec "${G[@]}" -c credential.helper= -c credential.helper='!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f' push -q origin main
fi
exec "${G[@]}" "$@"
