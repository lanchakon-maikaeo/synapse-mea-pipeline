# Production data attestation

- Target: Supabase project `fvdfduuanfrncrwuareb` (`synapse-01`)
- Region: `ap-southeast-1`
- Change ticket: `SYNAPSE-PROD-20260724`
- Approval date: 2026-07-24
- Approved by: synapse.mea project owner

The project owner confirms that the four checksummed workbooks in
`source_files/` are the complete Production source set supplied for this
cutover.

Within the declared active VMI material and 18-district scope, absence of a
material/location or material/district row in an exhaustive source means a
business value of zero. Every such zero must remain identifiable as
`owner_attested_zero` and linked to this attestation; it must not be presented
as a directly observed SAP row.

No unknown material, district, stock quantity, usage quantity, pallet balance,
supplier identity, or receipt lot may be fabricated.
