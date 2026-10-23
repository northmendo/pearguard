#!/bin/bash
# PearGuard Linux watchdog. Installed by the .deb as pearguard-watchdog.service
# and runs as root, so a child without sudo cannot stop it. Once a minute it
# looks at the active local graphical session on each seat and, for a user who
# has run PearGuard before (their userData holds runtime-state.json):
#
#  - starts PearGuard in that user's session if it is not running
#  - kills and restarts it if it is running but frozen: the main process
#    has stopped rewriting lastHeartbeat (every 30s, tamper-detector.js)
#
# The relaunch goes through the user's own systemd manager (systemd-run
# --user --machine), which carries the session's DISPLAY / WAYLAND_DISPLAY,
# so the app lands in the desktop session the same way the XDG autostart
# entry would start it. AppImage installs have no installer and so no
# watchdog; they rely on the autostart entry alone.
#
# "Frozen" means the heartbeat value has not changed for STALE_SECS of the
# watchdog's own monotonic time, not that it looks old against the wall
# clock. A child moving the clock, or a suspend/resume, changes how old the
# heartbeat looks but not whether the app keeps rewriting it.

APP=/opt/PearGuard/pearguard
POLL_SECS=60
STALE_SECS=180
# A just-started app writes its first heartbeat only once the worklet is up,
# so a younger process is never judged frozen.
GRACE_SECS=300

declare -A last_hb
declare -A hb_since

log() { echo "$*"; }

# Prints "user uid" for each active, local, graphical user session.
active_users() {
  local sid
  for sid in $(loginctl list-sessions --no-legend 2>/dev/null | awk '{print $1}'); do
    local name='' uid='' type='' class='' active='' remote=''
    while IFS='=' read -r key value; do
      case "$key" in
        Name) name=$value ;;
        User) uid=$value ;;
        Type) type=$value ;;
        Class) class=$value ;;
        Active) active=$value ;;
        Remote) remote=$value ;;
      esac
    done < <(loginctl show-session "$sid" -p Name -p User -p Type -p Class -p Active -p Remote 2>/dev/null)
    [ "$active" = yes ] || continue
    [ "$remote" = yes ] && continue
    [ "$class" = user ] || continue
    case "$type" in x11|wayland) ;; *) continue ;; esac
    echo "$name $uid"
  done | sort -u
}

# Pid of the user's PearGuard main process, or nothing. The .deb runs
# pearguard.bin behind a launcher script (afterPack.js); pgrep ignores a
# name pattern over 15 characters, hence the short prefix match. Electron helper
# processes share the binary name but carry --type= on their command line.
main_pid() {
  local uid=$1 pid
  for pid in $(pgrep -u "$uid" '^pearguard'); do
    if ! tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q -- '--type='; then
      echo "$pid"
      return
    fi
  done
}

launch() {
  local user=$1
  if out=$(systemd-run --user --machine="$user@.host" --collect --quiet -- "$APP" --hidden 2>&1); then
    log "started PearGuard for $user"
  else
    log "start failed for $user: $out"
  fi
}

check_user() {
  local user=$1 uid=$2
  local home
  home=$(getent passwd "$user" | cut -d: -f6)
  local state="$home/.config/pearguard-desktop/runtime-state.json"
  [ -f "$state" ] || return

  local pid
  pid=$(main_pid "$uid")
  if [ -z "$pid" ]; then
    unset 'last_hb[$uid]' 'hb_since[$uid]'
    log "PearGuard not running for $user"
    launch "$user"
    return
  fi

  local hb
  hb=$(grep -o '"lastHeartbeat":[0-9]*' "$state" 2>/dev/null | cut -d: -f2)
  if [ "${last_hb[$uid]}" != "$hb" ]; then
    last_hb[$uid]=$hb
    hb_since[$uid]=$SECONDS
    return
  fi

  local age
  age=$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ')
  [ -n "$age" ] && [ "$age" -ge "$GRACE_SECS" ] || return
  [ $((SECONDS - hb_since[$uid])) -ge "$STALE_SECS" ] || return

  log "PearGuard for $user (pid $pid) has not written a heartbeat in $((SECONDS - hb_since[$uid]))s; restarting"
  pkill -KILL -u "$uid" '^pearguard'
  sleep 2
  unset 'last_hb[$uid]' 'hb_since[$uid]'
  launch "$user"
}

log "watchdog started"
while true; do
  if [ -x "$APP" ]; then
    while read -r user uid; do
      [ -n "$user" ] && check_user "$user" "$uid"
    done < <(active_users)
  fi
  sleep "$POLL_SECS"
done
