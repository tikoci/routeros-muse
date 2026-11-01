# inventory/ — grows past N=1

At N=1 the inventory IS `router.toml` at the root: one file, one box,
zero ceremony.

When the second box appears:

1. Copy each box's definition here as `<device-id>.toml` (same shape as
   `router.toml`: device + expect).
2. Remove root `router.toml` (record the move in `decisions.md`).
3. From then on, per-device files under `inventory/` are canonical.

Device ids name jobs (`site-location-role`), never hardware. Labels name
units. Serials bind at unbox and live in pulls, never in committed files.
