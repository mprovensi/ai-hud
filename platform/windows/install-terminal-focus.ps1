# Empacota a integração local sem npm/dependências e instala pelo CLI oficial do VS Code.
param([switch]$PackageOnly, [string]$Output = '')
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$source = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'integrations\vscode-terminal'
$package = Get-Content -LiteralPath (Join-Path $source 'package.json') -Raw | ConvertFrom-Json
$stage = Join-Path ([IO.Path]::GetTempPath()) ('ai-hud-extension-' + [guid]::NewGuid().ToString('N'))
$extension = Join-Path $stage 'extension'
New-Item -ItemType Directory -Path $extension | Out-Null
foreach ($name in @('package.json', 'extension.js', 'bridge.js')) { Copy-Item -LiteralPath (Join-Path $source $name) -Destination (Join-Path $extension $name) }
$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="$($package.name)" Version="$($package.version)" Publisher="$($package.publisher)" />
    <DisplayName>AI HUD Terminal Focus</DisplayName>
    <Description xml:space="preserve">Seleciona o terminal integrado solicitado pelo AI HUD local.</Description>
    <Categories>Other</Categories>
    <Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="$($package.engines.vscode)" /><Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui" /></Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" /></Assets>
</PackageManifest>
"@
[IO.File]::WriteAllText((Join-Path $stage 'extension.vsixmanifest'), $manifest, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $stage '[Content_Types].xml'), '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="js" ContentType="application/javascript"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>', [Text.UTF8Encoding]::new($false))
if (-not $Output) { $Output = Join-Path ([IO.Path]::GetTempPath()) ('ai-hud-terminal-focus-' + $package.version + '-' + [guid]::NewGuid().ToString('N') + '.vsix') }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($stage, $Output)
if ($PackageOnly) { Write-Output $Output; exit 0 }
$code = Get-Command code.cmd -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1
if (-not $code) {
  $known = @(Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\bin\code.cmd'; Join-Path $env:ProgramFiles 'Microsoft VS Code\bin\code.cmd')
  $code = $known | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if (-not $code) { throw 'Não encontrei o CLI do VS Code. Instale o VSIX pelo menu Extensões > Instalar do VSIX: ' + $Output }
& $code --install-extension $Output --force
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Output 'Integração AI HUD Terminal Focus instalada.'
