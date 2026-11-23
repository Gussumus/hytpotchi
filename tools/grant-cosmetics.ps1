# Выдать или забрать платную косметику у игрока (пишет прямо в KV сервера через wrangler).
#
#   .\tools\grant-cosmetics.ps1 -Nick gussumus -All              # выдать все платные вещи
#   .\tools\grant-cosmetics.ps1 -Nick gussumus crown halo        # выдать конкретные
#   .\tools\grant-cosmetics.ps1 -Nick gussumus crown -Remove     # забрать
#   .\tools\grant-cosmetics.ps1 -Nick gussumus                   # просто показать, что есть
#
# Нужен вход в Cloudflare: npx wrangler login
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Nick,
  [Parameter(Position = 1, ValueFromRemainingArguments = $true)][string[]]$Items = @(),
  [switch]$All,
  [switch]$Remove,
  [string]$Server = $(if ($env:HYTPOTCHI_SKIN_SERVER) { $env:HYTPOTCHI_SKIN_SERVER } else { 'https://hytpotchi-skins.akiom31.workers.dev' })
)
$ErrorActionPreference = 'Stop'

$catalog = (Invoke-RestMethod "$($Server.TrimEnd('/'))/api/cosmetics/catalog").items
$paid = @($catalog | Where-Object { $_.price -gt 0 } | ForEach-Object { $_.id })
$known = @($catalog | ForEach-Object { $_.id })

if ($All) { $Items = $paid }
foreach ($i in $Items) {
  if ($known -notcontains $i) { throw "Нет такого предмета: $i. Есть: $($known -join ', ')" }
}

$key = "own:$($Nick.ToLower())"
Push-Location (Join-Path $PSScriptRoot '..\server\skins')
try {
  # wrangler пишет предупреждения в stderr — в Windows PowerShell это не должно ронять скрипт
  $ErrorActionPreference = 'Continue'
  $raw = (& npx --no-install wrangler kv key get --binding SKINS $key --remote 2>$null) -join ''
  $current = @()
  try { if ($raw) { $current = @((ConvertFrom-Json $raw) | ForEach-Object { [string]$_ }) } } catch { $current = @() }

  if ($Items.Count -eq 0) {
    Write-Host "$Nick владеет: $(if ($current.Count) { $current -join ', ' } else { '(ничего)' })"
    return
  }

  if ($Remove) { $list = @($current | Where-Object { $Items -notcontains $_ }) }
  else { $list = @($current + $Items | Select-Object -Unique) }

  $json = ConvertTo-Json -InputObject @($list) -Compress
  $tmp = [IO.Path]::GetTempFileName()
  [IO.File]::WriteAllText($tmp, $json)
  & npx --no-install wrangler kv key put --binding SKINS $key --path $tmp --remote 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'wrangler не смог записать значение' }
  Remove-Item $tmp
  Write-Host "Готово. $Nick теперь владеет ($($list.Count)): $($list -join ', ')"
} finally {
  Pop-Location
}
