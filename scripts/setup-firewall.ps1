# setup-firewall.ps1 — 최초 1회, 관리자 권한 PowerShell 에서 실행
# 다른 기기(LAN / Tailscale)에서 이 PC의 정처기 배틀 서버에 접속할 수 있도록
# Windows 방화벽 인바운드 규칙을 추가한다.
#
#   powershell -ExecutionPolicy Bypass -File scripts\setup-firewall.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\setup-firewall.ps1 -Port 4000

param([int]$Port = 3000)

$ruleName = "JPK Battle ($Port)"

$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
  Write-Host "관리자 권한이 필요합니다." -ForegroundColor Red
  Write-Host "PowerShell 을 '관리자 권한으로 실행' 한 뒤 다시 시도하세요."
  exit 1
}

$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "이미 규칙이 있습니다: $ruleName" -ForegroundColor Yellow
} else {
  New-NetFirewallRule `
    -DisplayName $ruleName `
    -Direction Inbound `
    -LocalPort $Port `
    -Protocol TCP `
    -Action Allow `
    -Profile Any | Out-Null
  Write-Host "방화벽 규칙을 추가했습니다: $ruleName" -ForegroundColor Green
}

Write-Host ""
Write-Host "이 PC의 접속 주소:" -ForegroundColor Cyan
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
  ForEach-Object {
    $tag = if ($_.IPAddress -like '100.*') { ' (Tailscale)' } else { '' }
    Write-Host ("  http://{0}:{1}{2}" -f $_.IPAddress, $Port, $tag)
  }
Write-Host ""
Write-Host "규칙을 지우려면: Remove-NetFirewallRule -DisplayName '$ruleName'"
