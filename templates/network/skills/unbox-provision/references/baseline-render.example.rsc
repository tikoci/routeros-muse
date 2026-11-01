# Baseline render — executed subset + prescribed remainder (shape example)
# Executed on twin2/7.26beta3 2026-10-30 via staged /system/script
# (name unbox-baseline, positional run, read-back exact). Values
# below are the DRILL markers, kept so the shape stays reviewable;
# replace with the device's real values at render time. Secrets are
# placeholders ALWAYS — filled only in the uploaded copy, never here.
# Prescribed full baseline (feedback §3): agent accounts (reader +
# admin), management access, /system/note at login, time + DNS,
# device-mode for bridge needs, bridge where hardware allows.
/system/identity/set name=t2-unbox-drill
/system/note/set note=t2-unbox-baseline-ok
# --- prescribed, not executed (fill per device, twin-proof first) ---
# /user/add name=OWNER-FILL group=OWNER-FILL password=PLACEHOLDER-FILL-AT-UPLOAD
# /ip/dns/set servers=OWNER-FILL
# /system/ntp/client/set enabled=yes servers=OWNER-FILL
# /system/device-mode/update container=OWNER-FILL
