# Corrige la fermeture des blocs runAudited.
# Le remplacement précédent avait laissé une parenthèse fermante en trop, et
# avait abîmé d'autres fermetures : on répare ligne par ligne, en s'appuyant
# uniquement sur la structure indentée du fichier.
$ErrorActionPreference = 'Stop'
$path = 'C:\MwanaClasse\api\src\routes\school.ts'
$lines = [System.IO.File]::ReadAllLines($path)
$out = New-Object System.Collections.Generic.List[string]

for ($i = 0; $i -lt $lines.Count; $i++) {
    $line = $lines[$i]

    # Motif : une ligne ne contenant que ")," suivie d'une ligne ne contenant
    # que ");" -> on supprime la seconde (parenthèse en trop de la fonction
    # fléchée supprimée) et on garde la première comme fermeture du bloc.
    if ($line -match '^(\s*)\),\s*$') {
        $indent = $Matches[1]
        if ($i + 1 -lt $lines.Count -and $lines[$i + 1] -match '^\s*\);\s*$') {
            # On remplace la fermeture de l'appel runAudited par la bonne
            # indentation : deux niveaux de moins que la parenthèse observée.
            $callIndent = $indent
            if ($callIndent.Length -ge 4) { $callIndent = $callIndent.Substring(0, $callIndent.Length - 2) }
            $out.Add($callIndent + ');')
            $i++  # on saute la ligne suivante, désormais inutile
            continue
        }
    }

    $out.Add($line)
}

[System.IO.File]::WriteAllLines($path, $out)
Write-Output "lignes : $($lines.Count) -> $($out.Count)"
