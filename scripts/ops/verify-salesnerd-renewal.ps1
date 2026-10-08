[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [switch] $DeploymentConfirmed,

  [ValidateRange(1, 30)]
  [int] $WindowMinutes = 15,

  [string] $ProjectId = 'gen-lang-client-0561071620',
  [string] $Region = 'europe-west1',
  [string] $Service = 'uoa-auth',

  [ValidateRange(1, 5000)]
  [int] $MaxEntries = 2000,

  [string] $ExpectedImageTag
)

$ErrorActionPreference = 'Stop'
if (-not $DeploymentConfirmed) {
  throw 'Wait for the operator to confirm deployment before querying production.'
}

$gcloudCommand = Get-Command gcloud -ErrorAction Stop
$gcloud = $gcloudCommand.Source

function Invoke-GcloudJson {
  param([Parameter(Mandatory = $true)][string[]] $Arguments)

  $output = & $gcloud @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "gcloud command failed with exit code $LASTEXITCODE. No command output was retained."
  }
  $json = ($output -join "`n").Trim()
  if (-not $json) { return $null }
  return $json | ConvertFrom-Json
}

$serviceState = Invoke-GcloudJson @(
  'run', 'services', 'describe', $Service,
  '--project', $ProjectId,
  '--region', $Region,
  '--format=json'
)
$readyRevision = [string]$serviceState.status.latestReadyRevisionName
$createdRevision = [string]$serviceState.status.latestCreatedRevisionName
if (-not $readyRevision) { throw 'Cloud Run has no ready revision to inspect.' }

$revisionState = Invoke-GcloudJson @(
  'run', 'revisions', 'describe', $readyRevision,
  '--project', $ProjectId,
  '--region', $Region,
  '--format=json'
)
$image = [string]$revisionState.spec.containers[0].image
$traffic = @(
  foreach ($entry in @($serviceState.status.traffic)) {
    $revisionName = [string]$entry.revisionName
    if (-not $revisionName -and $entry.latestRevision) { $revisionName = $readyRevision }
    [pscustomobject]@{
      revision = $revisionName
      percent = [int]$entry.percent
    }
  }
)
$readyTrafficPercent = ($traffic | Where-Object { $_.revision -eq $readyRevision } |
  Measure-Object -Property percent -Sum).Sum
if ($null -eq $readyTrafficPercent) { $readyTrafficPercent = 0 }

$since = [DateTimeOffset]::UtcNow.AddMinutes(-$WindowMinutes).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
$commonFilter = 'resource.type="cloud_run_revision" AND resource.labels.service_name="{0}" AND timestamp >= "{1}"' -f $Service, $since
$requestFilter = '{0} AND logName="projects/{1}/logs/run.googleapis.com%2Frequests"' -f $commonFilter, $ProjectId
$errorFilter = '{0} AND severity>=ERROR' -f $commonFilter
$requests = @(Invoke-GcloudJson @('logging', 'read', $requestFilter, '--project', $ProjectId, '--format=json', '--limit', [string]$MaxEntries))
$errors = @(Invoke-GcloudJson @('logging', 'read', $errorFilter, '--project', $ProjectId, '--format=json', '--limit', [string]$MaxEntries))

$requestSummary = @{}
foreach ($name in @('org_me', 'compute_renewal', 'other_compute_renewal')) {
  $matched = @(
    foreach ($entry in $requests) {
      $url = [string]$entry.httpRequest.requestUrl
      $path = $url
      try { $path = ([Uri]$url).AbsolutePath } catch { $path = ($url -split '\?', 2)[0] }
      $method = [string]$entry.httpRequest.requestMethod
      $isMatch = switch ($name) {
        'org_me' { $method -eq 'GET' -and $path -eq '/org/me' }
        'compute_renewal' { $method -eq 'POST' -and $path -match '^/billing/v1/job-compute-renewals/[^/]+/renew$' }
        'other_compute_renewal' { $method -eq 'POST' -and $path -match '^/billing/v1/ledger/job-compute-renewals(?:/recover)?$' }
      }
      if ($isMatch) { $entry }
    }
  )
  $requestSummary[$name] = [pscustomobject]@{
    total = $matched.Count
    success2xx = @($matched | Where-Object { [int]$_.httpRequest.status -ge 200 -and [int]$_.httpRequest.status -lt 300 }).Count
    client4xx = @($matched | Where-Object { [int]$_.httpRequest.status -ge 400 -and [int]$_.httpRequest.status -lt 500 }).Count
    server5xx = @($matched | Where-Object { [int]$_.httpRequest.status -ge 500 }).Count
  }
}

$errorKinds = @{
  P2028 = 0
  P2010 = 0
  SQL25P02 = 0
  PRODUCT_API_BUSY = 0
  renewalUnavailable = 0
  otherErrors = 0
}
foreach ($entry in $errors) {
  $parts = [System.Collections.Generic.List[string]]::new()
  if ($entry.textPayload) { $parts.Add([string]$entry.textPayload) }
  if ($entry.jsonPayload) { $parts.Add(($entry.jsonPayload | ConvertTo-Json -Compress -Depth 12)) }
  if ($entry.protoPayload -and $entry.protoPayload.status) { $parts.Add([string]$entry.protoPayload.status.message) }
  $text = $parts -join ' '
  $matchedKnown = $false
  foreach ($code in @('P2028', 'P2010', 'SQL25P02', 'PRODUCT_API_BUSY', 'renewalUnavailable')) {
    $pattern = switch ($code) {
      'SQL25P02' { '25P02' }
      'renewalUnavailable' { 'renewal_unavailable' }
      default { [regex]::Escape($code) }
    }
    if ($text -match $pattern) {
      $errorKinds[$code] += 1
      $matchedKnown = $true
    }
  }
  if (-not $matchedKnown) { $errorKinds.otherErrors += 1 }
}

$expectedImageMatches = $null
if ($ExpectedImageTag) { $expectedImageMatches = $image.EndsWith(":$ExpectedImageTag", [StringComparison]::OrdinalIgnoreCase) }

[pscustomobject]@{
  project = $ProjectId
  region = $Region
  service = $Service
  windowMinutes = $WindowMinutes
  sinceUtc = $since
  readyRevision = $readyRevision
  latestCreatedRevision = $createdRevision
  image = $image
  expectedImageTagMatches = $expectedImageMatches
  trafficToReadyRevisionPercent = [int]$readyTrafficPercent
  traffic = $traffic
  requestLogEntriesRead = $requests.Count
  requestLogLimitReached = ($requests.Count -ge $MaxEntries)
  routeRequests = $requestSummary
  errorLogEntriesRead = $errors.Count
  errorLogLimitReached = ($errors.Count -ge $MaxEntries)
  errorCounts = $errorKinds
  note = 'Counts only; request URLs, user data, tokens, and log payloads are not emitted.'
} | ConvertTo-Json -Depth 6
