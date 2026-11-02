# twin-run: unbox-provision drill on a CHR twin

Machine: a KVM host. Date: 2026-10-30. Target: a CHR twin,
7.26beta3 x86 (user NIC, http:9110). Commands + redacted
outputs follow.
System-id cited by sha256 prefix only ([sid-sha:241c15eb…]).

## Commands (all observed)

```
quickchr start <twin>
centrs retrieve --quickchr <twin> /system/identity            # CHR
centrs retrieve --quickchr <twin> /system/note                # empty
centrs execute --quickchr <twin> '/system/script/print'       # {}
centrs retrieve --quickchr <twin> /system/license             # hashed, file deleted
centrs execute --quickchr <twin> '/system/note/set note="WIP: unbox-drill 2026-10-30"' --yes
centrs execute --quickchr <twin> '/system/script/add name=unbox-baseline source="/system/identity/set name=demo-unbox-drill;/system/note/set note=demo-unbox-baseline-ok"' --yes   # *1
centrs execute --quickchr <twin> '/system/script/run unbox-baseline' --yes    # positional
centrs retrieve --quickchr <twin> /system/identity            # demo-unbox-drill
centrs retrieve --quickchr <twin> /system/note                # demo-unbox-baseline-ok
bun pull.ts --quickchr <twin> --out out                       # status ok, 5 files
bun checker.ts --device <twin> --out out                     # ok true, 5 files, 0 problems
centrs execute --quickchr <twin> '/system/script/remove numbers=unbox-baseline' --yes
centrs execute --quickchr <twin> '/system/identity/set name=CHR' --yes
centrs execute --quickchr <twin> '/system/note/set note=""' --yes
quickchr stop <twin>
```

## Facts established

- Staged-script apply: `;`-separated two-command source
  stages (*1), runs positionally, reads back exact.
- First pull on a fresh device: status ok, 5 files, CHR
  identity note; checker ok:true, 2739 bytes, 0 problems.
- Device binding: manifest serial == `system-id:`+license
  system-id (pull.ts prefix rule; first bare-id compare
  mismatched and was corrected during the run).
- Teardown: scripts {}, identity CHR, note empty, 45 file
  names identical to pre-state, twin stopped (host left as found).

## Limits of this run

CHR has no sticker: the photo-binding step is unexecuted.
Identity+note is the executed baseline subset; accounts,
access, time, DNS, device-mode prescribed, not run.
Netinstall/reset path not exercised. UM specimen untouched.
