#!/bin/sh
set -eu
unset WOW_UPLOAD_TOKEN WOW_UPLOAD_TOKEN_FILE
export APPDIR=/opt/tsm BROWSER=firefox-esr
exec dbus-run-session -- /opt/tsm/AppRun
