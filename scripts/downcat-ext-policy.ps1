<#
받냥이 크롬/엣지 확장 "로컬 강제설치" 정책을 켜고 끈다(HKCU, 관리자 권한 불필요).
- update.xml을 CRX 옆에 만들고, ExtensionInstallForcelist 정책으로 확장을 자동설치한다.
- 토큰이 주어지면 managed 정책(3rdparty)에 넣어 확장이 자동으로 짝을 맞추게 한다.
- -Uninstall 이면 정책을 지운다.

예) 설치:  powershell -File downcat-ext-policy.ps1 -CrxPath "C:\...\downcat-ext.crx" -ConfigPath "C:\...\config.json"
   제거:  powershell -File downcat-ext-policy.ps1 -Uninstall
#>
param(
  [string]$CrxPath = '',
  [string]$ExtId = 'hcaehgnpahddjceeamipjimeokagpgno',
  [string]$Token = '',
  [string]$ConfigPath = '',
  [string]$Version = '0.1.0',
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'

# HKLM(전 사용자 정책)에 쓴다 — 크롬은 HKCU\Software\Policies를 무시하는 경우가 많음. bat이 관리자로 실행하므로 HKLM 쓰기 가능.
$ChromeForce = 'HKLM:\Software\Policies\Google\Chrome\ExtensionInstallForcelist'
$EdgeForce   = 'HKLM:\Software\Policies\Microsoft\Edge\ExtensionInstallForcelist'
$Chrome3p    = "HKLM:\Software\Policies\Google\Chrome\3rdparty\extensions\$ExtId\policy"
$Edge3p      = "HKLM:\Software\Policies\Microsoft\Edge\3rdparty\extensions\$ExtId\policy"
# 옛 버전이 HKCU에 남긴 값도 제거용으로 들고 있는다
$ChromeForceHKCU = 'HKCU:\Software\Policies\Google\Chrome\ExtensionInstallForcelist'
$EdgeForceHKCU   = 'HKCU:\Software\Policies\Microsoft\Edge\ExtensionInstallForcelist'
$Chrome3pHKCU    = "HKCU:\Software\Policies\Google\Chrome\3rdparty\extensions\$ExtId\policy"
$Edge3pHKCU      = "HKCU:\Software\Policies\Microsoft\Edge\3rdparty\extensions\$ExtId\policy"

function Remove-ValueIfExists($key, $name) {
  if (Test-Path $key) { Remove-ItemProperty -Path $key -Name $name -ErrorAction SilentlyContinue }
}

# 강제설치 목록에서 우리 확장(데이터가 "<ID>;"로 시작) 항목을 제거한다.
function Remove-ForceEntry($key, $extId) {
  if (-not (Test-Path $key)) { return }
  foreach ($n in (Get-Item $key).Property) {
    $v = (Get-ItemProperty -Path $key -Name $n).$n
    if ($v -like "$extId;*") { Remove-ItemProperty -Path $key -Name $n -ErrorAction SilentlyContinue }
  }
}

# 강제설치 목록에 우리 항목을 넣는다. 목록 값 이름은 반드시 숫자("1","2"...)여야 크롬이 읽는다.
function Set-ForceEntry($key, $extId, $data) {
  New-Item -Path $key -Force | Out-Null
  Remove-ForceEntry $key $extId                    # 중복 방지(재실행 대비)
  $nums = (Get-Item $key).Property | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ }
  $next = if ($nums) { (($nums | Measure-Object -Maximum).Maximum + 1) } else { 1 }
  New-ItemProperty -Path $key -Name "$next" -Value $data -PropertyType String -Force | Out-Null
}

if ($Uninstall) {
  # 강제설치 목록에서 우리 항목(데이터가 <ID>;로 시작)만 제거 (HKLM + 옛 HKCU 둘 다). 옛 ID-이름 값도 정리.
  foreach ($k in @($ChromeForce, $EdgeForce, $ChromeForceHKCU, $EdgeForceHKCU)) {
    Remove-ForceEntry $k $ExtId
    Remove-ValueIfExists $k $ExtId   # 옛 버전이 ID를 값 이름으로 쓴 잔재 제거
  }
  # managed 토큰 정책 키 제거 (HKLM + 옛 HKCU)
  foreach ($k in @($Chrome3p, $Edge3p, $Chrome3pHKCU, $Edge3pHKCU)) {
    if (Test-Path $k) { Remove-Item -Path $k -Recurse -Force -ErrorAction SilentlyContinue }
  }
  Write-Host '받냥이 확장 강제설치 정책 제거됨. (크롬/엣지 다시 시작 후 확장 사라짐)'
  return
}

if (-not $CrxPath -or -not (Test-Path $CrxPath)) { throw "CRX를 못 찾음: $CrxPath" }
$CrxPath = (Resolve-Path $CrxPath).Path
$dir = Split-Path $CrxPath -Parent
$xmlPath = Join-Path $dir 'downcat-update.xml'

# 파일 경로 → file:/// URL (역슬래시를 슬래시로)
function To-FileUrl($p) { 'file:///' + ($p -replace '\\','/') }
$crxUrl = To-FileUrl $CrxPath
$xmlUrl = To-FileUrl $xmlPath

# update.xml(Omaha gupdate) 작성
$xml = @"
<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='$ExtId'>
    <updatecheck codebase='$crxUrl' version='$Version' />
  </app>
</gupdate>
"@
Set-Content -Path $xmlPath -Value $xml -Encoding UTF8

# 강제설치 정책: 데이터="<ID>;<update.xml file URL>". 값 이름은 숫자여야 크롬이 목록으로 인식.
$forceVal = "$ExtId;$xmlUrl"
foreach ($key in @($ChromeForce, $EdgeForce)) { Set-ForceEntry $key $ExtId $forceVal }

# 토큰 자동 페어링(선택): config.json에서 읽거나 새로 만들어 managed 정책에 넣는다
if ($ConfigPath) {
  if (-not $Token) {
    if (Test-Path $ConfigPath) {
      try { $Token = (Get-Content $ConfigPath -Raw | ConvertFrom-Json).bridgeToken } catch { $Token = '' }
    }
    if (-not $Token) {
      $bytes = New-Object byte[] 24
      [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
      $Token = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    }
  }
  # 받냥이가 같은 토큰을 쓰도록 config.json 시드(없을 때만). PS 5.1은 ConvertFrom-Json이 PSCustomObject.
  $existing = ''
  if (Test-Path $ConfigPath) { try { $existing = (Get-Content $ConfigPath -Raw | ConvertFrom-Json).bridgeToken } catch { $existing = '' } }
  if ($existing) {
    $Token = $existing            # 받냥이가 이미 정한 토큰을 따른다
  } else {
    $obj = @{}
    if (Test-Path $ConfigPath) {
      try { (Get-Content $ConfigPath -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $obj[$_.Name] = $_.Value } } catch { $obj = @{} }
    }
    $obj['bridgeToken'] = $Token
    ($obj | ConvertTo-Json -Depth 10) | Set-Content -Path $ConfigPath -Encoding UTF8
  }
  foreach ($key in @($Chrome3p, $Edge3p)) {
    New-Item -Path $key -Force | Out-Null
    New-ItemProperty -Path $key -Name 'bridgeToken' -Value $Token -PropertyType String -Force | Out-Null
  }
  Write-Host "토큰 자동 페어링 설정됨 (managed 정책)."
}

Write-Host "받냥이 확장 강제설치 정책 적용됨. 크롬/엣지를 완전히 종료 후 다시 켜면 자동 설치됩니다."
Write-Host "  ExtId    : $ExtId"
Write-Host "  update   : $xmlPath"
Write-Host "  crx      : $CrxPath"
