[CmdletBinding()]
param(
  [int]$Port = 55432,
  [switch]$SkipUnit,
  [string[]]$Scenarios = @(
    "basic-crud",
    "file-uploads",
    "webhooks",
    "webhooks-multitenant",
    "background-jobs",
    "authentication",
    "multi-tenant-saas",
    "hotel-reservation",
    "appointment-scheduling",
    "all-features"
  )
)

$ErrorActionPreference = "Stop"
$Scenarios = @(
  $Scenarios |
    ForEach-Object { $_ -split "," } |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ -ne "" }
)
if ($Scenarios.Count -eq 0) {
  throw "At least one verification scenario is required."
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$runRoot = Join-Path ([IO.Path]::GetTempPath()) ("backendgen-postgres-" + [guid]::NewGuid().ToString("N"))
$dataDirectory = Join-Path $runRoot "data"
$logPath = Join-Path $runRoot "postgres.log"
$serverStarted = $false

function Require-NativeCommand([string]$Name) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($null -eq $command) {
    throw "Required command '$Name' was not found on PATH. Install PostgreSQL client/server tools first."
  }
  return $command.Source
}

function Invoke-Native([string]$Executable, [string[]]$Arguments) {
  & $Executable @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code ${LASTEXITCODE}: $Executable $($Arguments -join ' ')"
  }
}

$initdb = Require-NativeCommand "initdb"
$pgCtl = Require-NativeCommand "pg_ctl"
$createdb = Require-NativeCommand "createdb"
$dropdb = Require-NativeCommand "dropdb"
$npm = Require-NativeCommand "npm"

$previousBuild = $env:BACKENDGEN_E2E_BUILD
$previousScenario = $env:BACKENDGEN_E2E_SCENARIO
$previousDatabaseUrl = $env:DATABASE_URL

New-Item -ItemType Directory -Path $runRoot | Out-Null

try {
  Write-Host "Initializing disposable PostgreSQL cluster at $runRoot"
  Invoke-Native $initdb @(
    "-D", $dataDirectory,
    "--auth=trust",
    "--username=backendgen",
    "--encoding=UTF8",
    "--no-locale"
  )

  Invoke-Native $pgCtl @(
    "-D", $dataDirectory,
    "-l", $logPath,
    "-o", "-p $Port -h 127.0.0.1",
    "-w", "start"
  )
  $serverStarted = $true

  Push-Location $repoRoot
  try {
    if (-not $SkipUnit) {
      Write-Host "Running compiler unit suite"
      Invoke-Native $npm @("test")
    }

    foreach ($scenario in $Scenarios) {
      if ($scenario -notmatch "^[a-z0-9-]+$") {
        throw "Unsafe scenario name '$scenario'."
      }

      $database = "backendgen_" + $scenario.Replace("-", "_")
      Write-Host "Running PostgreSQL lifecycle: $scenario ($database)"
      Invoke-Native $createdb @(
        "-h", "127.0.0.1",
        "-p", [string]$Port,
        "-U", "backendgen",
        $database
      )

      try {
        $env:BACKENDGEN_E2E_BUILD = "1"
        $env:BACKENDGEN_E2E_SCENARIO = $scenario
        $env:DATABASE_URL = "postgresql://backendgen:backendgen@127.0.0.1:${Port}/$database`?schema=public"
        Invoke-Native $npm @("run", "test:e2e")
      }
      finally {
        Remove-Item Env:BACKENDGEN_E2E_SCENARIO -ErrorAction SilentlyContinue
        Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
        Invoke-Native $dropdb @(
          "-h", "127.0.0.1",
          "-p", [string]$Port,
          "-U", "backendgen",
          "--if-exists",
          "--force",
          $database
        )
      }
    }

    Write-Host "Running dependency audit"
    Invoke-Native $npm @("audit", "--audit-level=high")
  }
  finally {
    Pop-Location
  }

  Write-Host "Local verification passed for $($Scenarios.Count) PostgreSQL scenario(s)."
}
finally {
  if ($null -eq $previousBuild) {
    Remove-Item Env:BACKENDGEN_E2E_BUILD -ErrorAction SilentlyContinue
  }
  else {
    $env:BACKENDGEN_E2E_BUILD = $previousBuild
  }
  if ($null -eq $previousScenario) {
    Remove-Item Env:BACKENDGEN_E2E_SCENARIO -ErrorAction SilentlyContinue
  }
  else {
    $env:BACKENDGEN_E2E_SCENARIO = $previousScenario
  }
  if ($null -eq $previousDatabaseUrl) {
    Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
  }
  else {
    $env:DATABASE_URL = $previousDatabaseUrl
  }

  if ($serverStarted) {
    & $pgCtl -D $dataDirectory -m fast -w stop
  }

  $resolvedRunRoot = [IO.Path]::GetFullPath($runRoot)
  $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  if ($resolvedRunRoot.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $resolvedRunRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
