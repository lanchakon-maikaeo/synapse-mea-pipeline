# SYNAPSE module status

Status date: 2026-07-23  
Release: `1.0.0-non-ai`

| Module | Status | Operational activation |
|---|---|---|
| M01 Platform & Security | Complete and deployed | Supabase Test active |
| M02 Source Connectors | Complete, tested and actual-source activated | Old Apps Script/Google Sheets sources and Web submissions use governed checksum/idempotency |
| M03 Ingestion & Raw | Complete and deployed | Contract baseline plus 658 material, 462 warehouse and 5,926 CMP source rows reconciled |
| M04 Data Quality & Staging | Complete and deployed | 18-district mapping active; signed SAP adjustments retained in Raw and quality flagged |
| M05 Core Data Model | Complete and deployed | 1,043 materials, warehouse stock and district usage rates active |
| M06 Stock & Replenishment | Complete and deployed | 462 actual warehouse snapshots loaded; district stock source remains unavailable and is not fabricated |
| M07 Forecasting | Complete and deployed | 48,259 monthly-demand-v1 observations loaded; forecast remains gated because sources contain at most 12 months (<14) |
| M08 Transport & Route | Complete and deployed | Waiting for verified geocodes/packaging/vehicles/drivers and approved plan |
| M09 API | Complete, tested and serverless deployed | 29-path same-origin `/api` includes actual-source status/warehouse data, input context and governed publish; FastAPI remains optional |
| M10 Dashboard | Complete and publicly deployed | Native Next.js revision `804c6f0` at `https://mea-synapse-staging.vercel.app`; Supabase Auth protects business data and governed actions |
| M11 RAG & MCP / AI | Excluded by user scope | Not implemented |
| M12 Operations & CI/CD | Implementation complete and locally tested | `make ci` passes, including 15 clean migrations, 29 schema/RLS checks, 17 dispatcher workflow checks and 10 real worker execution checks; full-pipeline workflow exists in the outer workspace but needs a Git remote, and backups still need an operator schedule |

“Waiting” means the implementation fails closed until real data or infrastructure is supplied; it does not mean fabricated operational records were inserted.
