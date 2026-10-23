#!/bin/bash
# Stop the watchdog before dpkg touches /opt/PearGuard, on both upgrade and
# removal, so it cannot start a half-replaced app. postinst starts it again
# after an upgrade.
if [ -d /run/systemd/system ]; then
    systemctl stop pearguard-watchdog.service 2>/dev/null || true
fi
exit 0
