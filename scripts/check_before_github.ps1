param(
    [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$ErrorActionPreference = "Stop"
$failed = $false

function Write-Check {
    param([string]$Status, [string]$Message)
    Write-Host "[$Status] $Message"
}

function Mark-Failed {
    param([string]$Message)
    $script:failed = $true
    Write-Check "FAIL" $Message
}

Set-Location $Root
Write-Host "Daily Intel Briefing GitHub safety check"
Write-Host "Root: $Root"
Write-Host ""

$blockedPaths = @(
    ".env",
    "data\daily_intel_jobs.json",
    "data\daily_intel_runs.json",
    "data\reports.json",
    "outputs",
    "logs",
    ".venv"
)

foreach ($relativePath in $blockedPaths) {
    if (Test-Path -LiteralPath (Join-Path $Root $relativePath)) {
        Write-Check "WARN" "$relativePath exists locally. It must stay ignored and must not be uploaded."
    } else {
        Write-Check "OK" "$relativePath not found locally."
    }
}

$gitignore = Join-Path $Root ".gitignore"
if (-not (Test-Path -LiteralPath $gitignore)) {
    Mark-Failed ".gitignore is missing."
} else {
    $gitignoreText = Get-Content -Raw -LiteralPath $gitignore
    $requiredIgnoreRules = @(".env", "data/*.json", "outputs/", "logs/", ".venv")
    foreach ($rule in $requiredIgnoreRules) {
        if ($gitignoreText -notmatch [regex]::Escape($rule)) {
            Mark-Failed ".gitignore does not contain required rule: $rule"
        } else {
            Write-Check "OK" ".gitignore contains $rule"
        }
    }
}

$envExample = Join-Path $Root ".env.example"
if (-not (Test-Path -LiteralPath $envExample)) {
    Mark-Failed ".env.example is missing."
} else {
    $exampleText = Get-Content -Raw -LiteralPath $envExample
    foreach ($placeholder in @("your-openai-or-compatible-api-key", "your-tavily-api-key")) {
        if ($exampleText -notmatch [regex]::Escape($placeholder)) {
            Mark-Failed ".env.example should use placeholder: $placeholder"
        }
    }
}

$secretPatterns = @(
    "sk-[A-Za-z0-9_\-]{20,}",
    "tvly-[A-Za-z0-9_\-]{20,}",
    "xai-[A-Za-z0-9_\-]{20,}",
    "ghp_[A-Za-z0-9_]{20,}",
    "(?m)^\s*SMTP_PASSWORD\s*=\s*(?!\s*(your-|os\.|os\.environ|os\.getenv|[`"'])).+",
    "(?m)^\s*OPENAI_API_KEY\s*=\s*(?!\s*(your-|os\.|os\.environ|os\.getenv|[`"'])).+",
    "(?m)^\s*TAVILY_API_KEY\s*=\s*(?!\s*(your-|os\.|os\.environ|os\.getenv|[`"'])).+"
)

$excludedDirectories = @("\.git\", "\.venv\", "\data\", "\outputs\", "\logs\", "\__pycache__\")
$files = Get-ChildItem -LiteralPath $Root -Recurse -File -Force |
    Where-Object {
        $fullName = $_.FullName
        -not ($excludedDirectories | Where-Object { $fullName.Contains($_) }) -and
        $_.Name -ne ".env" -and
        $fullName -ne $PSCommandPath
    }

foreach ($file in $files) {
    try {
        $content = Get-Content -Raw -LiteralPath $file.FullName -ErrorAction Stop
    } catch {
        continue
    }
    if ($null -eq $content) {
        $content = ""
    }
    foreach ($pattern in $secretPatterns) {
        if ([regex]::IsMatch($content, $pattern)) {
            $relative = Resolve-Path -LiteralPath $file.FullName -Relative
            Mark-Failed "Possible secret matched in $relative with pattern $pattern"
        }
    }
}

if ($failed) {
    Write-Host ""
    Write-Host "Safety check failed. Remove secrets or update .gitignore before uploading to GitHub."
    exit 1
}

Write-Host ""
Write-Host "Safety check passed. Local private files may exist, but required ignore rules are present and no obvious committed secret pattern was found."
