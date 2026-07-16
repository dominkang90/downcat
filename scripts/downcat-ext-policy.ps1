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

$ChromeForce = 'HKCU:\Software\Policies\Google\Chrome\ExtensionInstallForcelist'
$EdgeForce   = 'HKCU:\Software\Policies\Microsoft\Edge\ExtensionInstallForcelist'
$Chrome3p    = "HKCU:\Software\Policies\Google\Chrome\3rdparty\extensions\$ExtId\policy"
$Edge3p      = "HKCU:\Software\Policies\Microsoft\Edge\3rdparty\extensions\$ExtId\policy"

function Remove-ValueIfExists($key, $name) {
  if (Test-Path $key) { Remove-ItemProperty -Path $key -Name $name -ErrorAction SilentlyContinue }
}

if ($Uninstall) {
  # 강제설치 목록에서 우리 항목(이름=확장ID)만 제거
  Remove-ValueIfExists $ChromeForce $ExtId
  Remove-ValueIfExists $EdgeForce   $ExtId
  # managed 토큰 정책 키 제거
  if (Test-Path $Chrome3p) { Remove-Item -Path $Chrome3p -Recurse -Force -ErrorAction SilentlyContinue }
  if (Test-Path $Edge3p)   { Remove-Item -Path $Edge3p   -Recurse -Force -ErrorAction SilentlyContinue }
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

# 강제설치 정책: 값 이름=확장ID, 데이터="<ID>;<update.xml file URL>"
$forceVal = "$ExtId;$xmlUrl"
foreach ($key in @($ChromeForce, $EdgeForce)) {
  New-Item -Path $key -Force | Out-Null
  New-ItemProperty -Path $key -Name $ExtId -Value $forceVal -PropertyType String -Force | Out-Null
}

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
