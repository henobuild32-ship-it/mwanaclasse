# Remplace le couple withIdentity+withAudit par l'appel combiné runAudited.
# Écrit en fichier pour éviter les problèmes d'échappement en ligne de commande.
$ErrorActionPreference = 'Stop'
$path = 'C:\MwanaClasse\api\src\routes\school.ts'
$text = [System.IO.File]::ReadAllText($path)

$newline = [char]10

$evaluator = [System.Text.RegularExpressions.MatchEvaluator]{
    param($m)
    $indent = $m.Groups[1].Value
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('runAudited(').Append($newline)
    [void]$sb.Append($indent).Append('{ db, audit },').Append($newline)
    [void]$sb.Append($indent).Append('req,')
    return $sb.ToString()
}

$pattern = 'db\.withIdentity\(dbIdentityFrom\(req\), \(client\) =>\r?\n(\s*)withAudit\(\r?\n\s*\{ audit \},'
$text = [regex]::Replace($text, $pattern, $evaluator)

# Supprime la parenthèse fermante supplémentaire qui terminait la fonction fléchée
$text = [regex]::Replace($text, '\);\r?\n\s*\),\r?\n\s*\);', ');' + $newline + '    );')

$text = $text.Replace('  withAudit,' + $newline + '  type QueryableClient,', '  runAudited,' + $newline + '  type QueryableClient,')

[System.IO.File]::WriteAllText($path, $text)

$remaining = ([regex]::Matches($text, 'withAudit\(')).Count
$created = ([regex]::Matches($text, 'runAudited\(')).Count
Write-Output "withAudit restants : $remaining"
Write-Output "runAudited crees   : $created"
