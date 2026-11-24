$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker CLI is required.' }
    docker compose version
    if ($LASTEXITCODE -ne 0) { throw 'Docker Compose is required.' }
    if (-not (Test-Path -LiteralPath '.env')) {
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try {
            $lines = foreach ($key in @('COLOGI_DB_ADMIN_PASSWORD', 'COLOGI_DB_RUNTIME_PASSWORD', 'COLOGI_DEMO_PASSWORD', 'DJANGO_SECRET_KEY')) {
                $bytes = New-Object byte[] 32
                $rng.GetBytes($bytes)
                "$key=$([BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant())"
                [Array]::Clear($bytes, 0, $bytes.Length)
            }
        } finally { $rng.Dispose() }
        $lines + 'COLOGI_FRONTEND_PORT=15173' | Set-Content -LiteralPath '.env' -Encoding ASCII
    }
    docker compose up -d --build --wait
    if ($LASTEXITCODE -ne 0) { throw 'CoLogi setup failed. Check docker compose logs.' }
    Write-Output 'See COLOGI_FRONTEND_PORT in .env and accounts in DEMO_ACCOUNTS.md.'
} finally { Pop-Location }
