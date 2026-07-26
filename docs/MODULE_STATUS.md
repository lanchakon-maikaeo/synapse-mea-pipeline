# SYNAPSE module status

Status date: 2026-07-26

Release: `M13e-non-ai`

| Module | Status | Operational activation |
|---|---|---|
| M01 Platform & Security | Complete and deployed | Supabase Test active |
| M02 Source Connectors | Complete, tested and actual-source activated | Old Apps Script/Google Sheets sources and Web submissions use governed checksum/idempotency |
| M03 Ingestion & Raw | Complete and deployed | Contract baseline plus 658 material, 462 warehouse and 5,926 CMP source rows reconciled |
| M04 Data Quality & Staging | Complete and deployed | 18-district mapping active; signed SAP adjustments retained in Raw and quality flagged |
| M05 Core Data Model | Complete and deployed | 1,043 materials, warehouse stock and district usage rates active |
| M06 Stock & Replenishment | Complete and deployed | 462 actual warehouse snapshots loaded; district stock source remains unavailable and is not fabricated |
| M07 Forecasting | Implemented; activation gated | 48,259 monthly-demand-v1 observations loaded; forecast remains gated because sources contain at most 12 months (<14) |
| M08 Transport & Route | Schema/API deployed; runtime gated | Depot geocodes/mappings and V707/V708 evidence are verified; waiting for controlled routing services, locked plan, packaging, remaining fleet and trip activation |
| M09 API | Complete, tested and serverless deployed | 48-path same-origin `/api` (SYNAPSE API `1.3.0`) includes actual-source status/warehouse data, input context, governed publish and the M13 transport namespace; FastAPI remains optional |
| M10 Dashboard | Complete and publicly deployed | Native Next.js release at `https://mea-synapse-production.vercel.app`; Supabase Auth protects business data and governed actions |
| M11 RAG & MCP / AI | Excluded by user scope | Not implemented |
| M12 Operations & CI/CD | Implementation complete and locally tested | `make ci` passes the 32-migration clean database contract, schema/RLS checks, dispatcher workflows and worker execution tests; protected production promotion remains unexecuted and backups still need an operator schedule |

“Waiting” means the implementation fails closed until real data or infrastructure is supplied; it does not mean fabricated operational records were inserted.
