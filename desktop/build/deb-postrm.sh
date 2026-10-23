#!/bin/bash
# On removal, take the watchdog unit out with the package. Upgrades keep it:
# the new postinst reinstalls and restarts it.
case "$1" in
    remove|purge)
        if [ -d /run/systemd/system ]; then
            systemctl disable pearguard-watchdog.service 2>/dev/null || true
        fi
        rm -f '/lib/systemd/system/pearguard-watchdog.service'
        if [ -d /run/systemd/system ]; then
            systemctl daemon-reload || true
        fi
        ;;
esac
exit 0
