param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('tests', 'source-smoke', 'packaged-smoke')]
  [string]$Scenario
)

$ErrorActionPreference = 'Stop'
$workspace = $env:GITHUB_WORKSPACE
$testRoot = $env:SQUABBLE_CI_TEMP
$userName = $env:SQUABBLE_CI_USER
$password = $env:SQUABBLE_CI_PASSWORD
if (-not $workspace -or -not $testRoot -or -not $userName -or -not $password) {
  throw 'Standard-user desktop CI environment is incomplete'
}

$credential = [pscredential]::new(
  "$env:COMPUTERNAME\$userName",
  (ConvertTo-SecureString $password -AsPlainText -Force)
)
$roaming = Join-Path $testRoot 'Roaming'
$local = Join-Path $testRoot 'Local'
$npmCache = Join-Path $testRoot 'npm-cache'
foreach ($directory in @($roaming, $local, $npmCache)) {
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
}
$environment = @{
  APPDATA = $roaming
  LOCALAPPDATA = $local
  TEMP = $testRoot
  TMP = $testRoot
  npm_config_cache = $npmCache
  PATH = $env:PATH
}

$arguments = @()
switch ($Scenario) {
  'tests' {
    $executable = Join-Path $env:SystemRoot 'System32/cmd.exe'
    $arguments = @('/d', '/c', 'npm run test:desktop')
  }
  'source-smoke' {
    $executable = (Get-Command node).Source
    $arguments = @('--import', 'tsx', 'desktop/smoke.mts')
  }
  'packaged-smoke' {
    $executable = Join-Path $workspace 'output/installers/win-unpacked/Squabble.exe'
    # This CI account has no interactive desktop. The shipped app uses its normal sandbox.
    $arguments = @('--disable-gpu', '--no-sandbox', '--enable-logging=file')
    $account = Get-LocalUser -Name $userName
    $profileKey = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$($account.SID.Value)"
    $profile = [Environment]::ExpandEnvironmentVariables((Get-ItemProperty -LiteralPath $profileKey).ProfileImagePath)
    if (-not (Test-Path -LiteralPath $profile -PathType Container)) {
      throw "Standard Windows user profile was not loaded: $profile"
    }
    $environment.APPDATA = Join-Path $profile 'AppData/Roaming'
    $environment.LOCALAPPDATA = Join-Path $profile 'AppData/Local'
    $environment.USERPROFILE = $profile
    $environment.HOMEDRIVE = Split-Path -Path $profile -Qualifier
    $environment.HOMEPATH = $profile.Substring($environment.HOMEDRIVE.Length)
    $environment.HOME = $profile
    $dataRoot = Join-Path $testRoot 'packaged-data'
    New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
    $environment.SQUABBLE_DESKTOP_DATA_DIR = $dataRoot
    $environment.SQUABBLE_DESKTOP_SMOKE = '1'
    $environment.ELECTRON_ENABLE_LOGGING = '1'
    $environment.ELECTRON_ENABLE_STACK_DUMPING = '1'
    $environment.ELECTRON_LOG_FILE = Join-Path $testRoot 'electron.log'
  }
}
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
  throw "Missing desktop CI executable: $executable"
}

$stdout = Join-Path $testRoot "$Scenario.stdout.log"
$stderr = Join-Path $testRoot "$Scenario.stderr.log"
$options = @{
  FilePath = $executable
  Credential = $credential
  LoadUserProfile = $true
  Environment = $environment
  WorkingDirectory = $workspace
  RedirectStandardOutput = $stdout
  RedirectStandardError = $stderr
  WindowStyle = 'Hidden'
  PassThru = $true
}
if ($arguments.Count) { $options.ArgumentList = $arguments }
if ($Scenario -eq 'packaged-smoke') {
  $probeOptions = $options.Clone()
  $probeOptions.ArgumentList = @('--disable-gpu', '--no-sandbox', '--version')
  $probeOptions.RedirectStandardOutput = Join-Path $testRoot 'packaged-version.stdout.log'
  $probeOptions.RedirectStandardError = Join-Path $testRoot 'packaged-version.stderr.log'
  $probe = Start-Process @probeOptions
  if (-not $probe.WaitForExit(15000)) {
    Stop-Process -Id $probe.Id -Force
    throw 'Standard-user packaged Electron --version probe timed out'
  }
  foreach ($logFile in @($probeOptions.RedirectStandardOutput, $probeOptions.RedirectStandardError)) {
    if (Test-Path -LiteralPath $logFile) { Get-Content -LiteralPath $logFile }
  }
  Write-Output "Standard-user packaged Electron --version exit: $($probe.ExitCode)"
  if ($probe.ExitCode -ne 0) {
    throw "Standard-user packaged Electron --version probe exited with code $($probe.ExitCode)"
  }
}
$application = Start-Process @options
$timeoutMs = switch ($Scenario) {
  'tests' { 180000 }
  'source-smoke' { 90000 }
  'packaged-smoke' { 60000 }
}
if (-not $application.WaitForExit($timeoutMs)) {
  Stop-Process -Id $application.Id -Force
  throw "Standard-user desktop $Scenario exceeded its $timeoutMs ms timeout"
}
if (Test-Path -LiteralPath $stdout) { Get-Content -LiteralPath $stdout }
if (Test-Path -LiteralPath $stderr) { Get-Content -LiteralPath $stderr }
if ($Scenario -eq 'packaged-smoke' -and $application.ExitCode -ne 0) {
  $marker = Join-Path $dataRoot 'packaged-smoke.json'
  Write-Output "Packaged marker exists: $(Test-Path -LiteralPath $marker -PathType Leaf)"
  if (Test-Path -LiteralPath $marker -PathType Leaf) {
    Write-Output "Packaged marker: $(Get-Content -LiteralPath $marker -Raw)"
  }
  $stageFile = Join-Path $dataRoot 'packaged-smoke-stage.log'
  if (Test-Path -LiteralPath $stageFile -PathType Leaf) {
    Write-Output "Packaged startup stages: $(Get-Content -LiteralPath $stageFile -Raw)"
  } else {
    Write-Output 'Packaged startup stage log does not exist'
  }
  Write-Output "PostgreSQL PID file exists: $(Test-Path -LiteralPath (Join-Path $dataRoot 'postgres/postmaster.pid'))"
  $secretsFile = Join-Path $dataRoot 'secrets.json'
  $privateSecrets = if (Test-Path -LiteralPath $secretsFile) {
    $values = Get-Content -LiteralPath $secretsFile -Raw | ConvertFrom-Json
    @($values.databasePassword, $values.jwtSecret, $values.settingsEncryptionKey)
  } else { @() }
  foreach ($name in @('backend.log', 'postgres.log')) {
    $logFile = Join-Path $dataRoot "logs/$name"
    if (Test-Path -LiteralPath $logFile) {
      Write-Output "Last 40 lines of $name (secrets redacted):"
      foreach ($line in (Get-Content -LiteralPath $logFile -Tail 40)) {
        foreach ($secret in $privateSecrets) {
          if ($secret) { $line = $line.Replace($secret, '[redacted]') }
        }
        Write-Output $line
      }
    }
  }
  $electronLog = Join-Path $testRoot 'electron.log'
  if (Test-Path -LiteralPath $electronLog) {
    Write-Output 'Last 60 lines of Electron log (secrets redacted):'
    foreach ($line in (Get-Content -LiteralPath $electronLog -Tail 60)) {
      foreach ($secret in $privateSecrets) {
        if ($secret) { $line = $line.Replace($secret, '[redacted]') }
      }
      Write-Output $line
    }
  }
  $userData = Join-Path $environment.APPDATA 'Squabble'
  if (Test-Path -LiteralPath $userData) {
    foreach ($filter in @('*.dmp', '*.log')) {
      Get-ChildItem -LiteralPath $userData -Recurse -File -Filter $filter -ErrorAction SilentlyContinue |
        ForEach-Object { Write-Output "Electron userData file: $($_.FullName) ($($_.Length) bytes)" }
    }
  }
}
if ($application.ExitCode -ne 0) {
  throw "Standard-user desktop $Scenario exited with code $($application.ExitCode)"
}

if ($Scenario -eq 'packaged-smoke') {
  $marker = Join-Path $dataRoot 'packaged-smoke.json'
  if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) {
    $backendLog = Join-Path $dataRoot 'logs/backend.log'
    if (Test-Path -LiteralPath $backendLog) { Get-Content -LiteralPath $backendLog -Tail 40 }
    throw 'Packaged application did not start its API'
  }
  $result = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
  if ($result.healthy -ne $true -or $result.authMode -ne 'local' -or $result.registrationOpen -ne $false -or $result.anonymousAccess -ne $true) {
    throw 'Packaged API returned an invalid first-run result'
  }
  if ((Split-Path -Path $result.defaultDataRoot -Leaf) -ne 'Squabble') {
    throw 'Default user data directory does not use the product name'
  }
  if (Test-Path -LiteralPath (Join-Path $dataRoot 'postgres/postmaster.pid')) {
    throw 'Packaged PostgreSQL did not stop cleanly'
  }
}
