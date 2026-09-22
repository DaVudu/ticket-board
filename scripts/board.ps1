param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('start', 'stop', 'status')]
  [string]$Aktion
)

$ProgressPreference = 'SilentlyContinue'
$projekt = Split-Path -Parent $PSScriptRoot
$projektMuster = [regex]::Escape($projekt)
$daten = Join-Path $projekt 'data'
$pidDatei = Join-Path $daten 'server.pid'
$logDatei = Join-Path $daten 'server.log'

$apiPort = 8787
$envDatei = Join-Path $projekt '.env'
if (Test-Path $envDatei) {
  $treffer = Select-String -Path $envDatei -Pattern '^\s*API_PORT\s*=\s*(\d+)' | Select-Object -First 1
  if ($treffer) { $apiPort = [int]$treffer.Matches[0].Groups[1].Value }
}
$webPort = 5173
$ports = @($apiPort, $webPort)

function Get-Prozess([int]$id) {
  Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
}

# Nur node und cmd zaehlen: Ein Editor, der mit dem Projektpfad gestartet wurde, darf nie als
# Board gelten, sonst beendet stop seinen ganzen Prozessbaum.
function Test-Board($p) {
  $p -and (@('node.exe', 'cmd.exe') -contains $p.Name) -and ($p.CommandLine -match $projektMuster)
}

# Oberster Vorfahr, der zum Board gehoert. Die Kette ist lang (npm, cmd, concurrently, npm,
# cmd, node), und nicht jedes Glied traegt den Projektpfad in der Befehlszeile.
function Get-BoardWurzel([int]$id) {
  $wurzel = $null
  for ($i = 0; $i -lt 12 -and $id -gt 0; $i++) {
    $p = Get-Prozess $id
    if (-not $p) { break }
    if (Test-Board $p) { $wurzel = [int]$p.ProcessId }
    $id = [int]$p.ParentProcessId
  }
  $wurzel
}

function Get-Lauscher {
  @(Get-NetTCPConnection -LocalPort $ports -State Listen -ErrorAction SilentlyContinue |
    Select-Object LocalPort, OwningProcess |
    Sort-Object LocalPort, OwningProcess -Unique)
}

function Test-Port([int]$port) {
  [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

function Get-Laeufe {
  try { Invoke-RestMethod "http://127.0.0.1:$apiPort/api/runs" -TimeoutSec 2 } catch { $null }
}

function Start-Board {
  $belegt = Get-Lauscher
  if ($belegt.Count -gt 0) {
    $fremd = @($belegt | Where-Object { -not (Get-BoardWurzel $_.OwningProcess) })
    if ($fremd.Count -gt 0) {
      foreach ($l in $fremd) {
        Write-Host "Port $($l.LocalPort) ist von einem fremden Prozess belegt (PID $($l.OwningProcess))."
      }
      Write-Host 'Nicht gestartet.'
      exit 1
    }
    Write-Host "Ticket Board laeuft bereits: http://localhost:$webPort"
    return
  }

  New-Item -ItemType Directory -Force -Path $daten | Out-Null
  # Absoluter Logpfad: So steht der Projektpfad in der Befehlszeile, und stop erkennt den Prozess.
  $befehl = "npm run dev > `"$logDatei`" 2>&1"
  $wurzel = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $befehl `
    -WorkingDirectory $projekt -WindowStyle Hidden -PassThru
  Set-Content -Path $pidDatei -Value $wurzel.Id -Encoding ascii

  Write-Host 'Starte Ticket Board ...'
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    if ($wurzel.HasExited) { break }
    if ((Get-Laeufe) -and (Test-Port $webPort)) {
      Write-Host "Ticket Board laeuft: http://localhost:$webPort"
      Write-Host "Log: $logDatei"
      return
    }
  }

  if ($wurzel.HasExited) {
    Remove-Item $pidDatei -ErrorAction SilentlyContinue
    Write-Host 'Start fehlgeschlagen. Letzte Logzeilen:'
  } else {
    Write-Host 'Server antwortet nach 20 s noch nicht, laeuft aber weiter. Letzte Logzeilen:'
  }
  Get-Content $logDatei -Tail 15 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" }
  exit 1
}

function Stop-Board {
  $wurzeln = @()
  if (Test-Path $pidDatei) {
    $id = [int](Get-Content $pidDatei -Raw).Trim()
    if (Test-Board (Get-Prozess $id)) { $wurzeln += $id }
  }
  foreach ($l in Get-Lauscher) {
    $w = Get-BoardWurzel $l.OwningProcess
    if ($w) { $wurzeln += $w }
    else { Write-Host "Port $($l.LocalPort) gehoert einem fremden Prozess (PID $($l.OwningProcess)), nicht beendet." }
  }
  $wurzeln = @($wurzeln | Sort-Object -Unique)
  Remove-Item $pidDatei -ErrorAction SilentlyContinue

  if ($wurzeln.Count -eq 0) {
    Write-Host 'Ticket Board laeuft nicht.'
    return
  }

  # /T nimmt die Kindprozesse mit; ohne das blieben unter Windows API und Vite am Leben.
  foreach ($id in $wurzeln) { $null = & taskkill.exe /PID $id /T /F 2>&1 }
  Start-Sleep -Seconds 1

  $rest = @(Get-Lauscher | Where-Object { Get-BoardWurzel $_.OwningProcess })
  if ($rest.Count -gt 0) {
    Write-Host "Noch belegt: Port $(($rest | ForEach-Object { $_.LocalPort }) -join ', ')"
    exit 1
  }
  Write-Host 'Ticket Board beendet.'
}

function Show-Status {
  $lauscher = Get-Lauscher
  if ($lauscher.Count -eq 0) {
    Write-Host 'Ticket Board laeuft nicht.'
    return
  }
  foreach ($l in $lauscher) {
    $art = if ($l.LocalPort -eq $apiPort) { 'API' } else { 'Web' }
    $wem = if (Get-BoardWurzel $l.OwningProcess) { 'Ticket Board' } else { 'fremder Prozess' }
    Write-Host ('{0,-4} Port {1}: {2}, PID {3}' -f $art, $l.LocalPort, $wem, $l.OwningProcess)
  }
  $laeufe = Get-Laeufe
  if ($laeufe -and $laeufe.current) { Write-Host "Implementierer arbeitet an $($laeufe.current.key)" }
  elseif ($laeufe) { Write-Host 'Implementierer: kein laufender Auftrag' }
  else { Write-Host 'API antwortet nicht.' }
}

switch ($Aktion) {
  'start'  { Start-Board }
  'stop'   { Stop-Board }
  'status' { Show-Status }
}
