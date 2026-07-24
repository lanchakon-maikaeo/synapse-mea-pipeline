param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('fvdfduuanfrncrwuareb')]
  [string]$ProjectRef,

  [Parameter(Mandatory = $true)]
  [ValidateSet('PRODUCTION')]
  [string]$ConfirmProduction
)

$ErrorActionPreference = 'Stop'
$packageRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repositoryRoot = Split-Path -Parent (Split-Path -Parent $packageRoot)

if (-not $env:SUPABASE_URL) {
  throw 'SUPABASE_URL is not set.'
}
if (-not $env:SUPABASE_SECRET_KEY -and
    -not $env:SUPABASE_SERVICE_ROLE_KEY) {
  throw 'Set SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY.'
}
if ($env:SUPABASE_URL -ne 'https://fvdfduuanfrncrwuareb.supabase.co') {
  throw 'SUPABASE_URL does not match the approved Production project.'
}
if ($ProjectRef -ne 'fvdfduuanfrncrwuareb' -or
    $ConfirmProduction -ne 'PRODUCTION') {
  throw 'Production confirmation failed.'
}

$pythonCommand = Get-Command 'python' -ErrorAction SilentlyContinue
if (-not $pythonCommand) {
  throw 'Python is not available.'
}

$env:PYTHONPATH = Join-Path $repositoryRoot 'pipeline\src'
Set-Location -LiteralPath $repositoryRoot

& $pythonCommand.Source -m synapse_pipeline.cli `
  import-actual-workbooks `
  --data-dir data `
  --attested-by 'synapse.mea project owner' `
  --attestation-text 'Owner confirms the four checksummed workbooks are complete for the declared Production scope; exhaustive source omission means zero.' `
  --change-ticket 'SYNAPSE-PROD-20260724' `
  --confirm-actual-data `
  --confirm-production-attestation
