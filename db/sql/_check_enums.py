"""Extraction fiable des litteraux du seed : lexer qui ignore commentaires et
blocs $html$ (contenu HTML), mais descend dans le corps du bloc $seed$."""
import re

BASE = r"C:\MwanaClasse\db\sql"
t001 = open(f"{BASE}\\001_extensions_and_helpers.sql", encoding="utf-8").read()
src = open(f"{BASE}\\006_seed_demo.sql", encoding="utf-8").read()

enums, values = {}, set()
for m in re.finditer(r"CREATE\s+TYPE\s+([a-z_]+\.[a-z_]+)\s+AS\s+ENUM\s*\((.*?)\)\s*;",
                     t001, re.S | re.I):
    vals = re.findall(r"'([^']*)'", m.group(2))
    enums[m.group(1).lower()] = vals
    values.update(vals)

lits = []
i, n, line = 0, len(src), 1
while i < n:
    c = src[i]
    if c == "\n":
        line += 1
        i += 1
        continue
    if src.startswith("--", i):
        j = src.find("\n", i)
        i = n if j < 0 else j
        continue
    if src.startswith("/*", i):
        j = src.find("*/", i + 2)
        i = n if j < 0 else j + 2
        continue
    if c == "'":
        j = i + 1
        while j < n:
            if src[j] == "'":
                if j + 1 < n and src[j + 1] == "'":
                    j += 2
                    continue
                break
            j += 1
        lits.append((src[i + 1:j].replace("''", "'"), line))
        i = j + 1
        continue
    if c == "$":
        m = re.match(r"\$([A-Za-z_]\w*)?\$", src[i:])
        if m:
            tag = m.group(0)
            if tag == "$html$":                       # contenu HTML : ignore
                j = src.find(tag, i + len(tag))
                i = n if j < 0 else j + len(tag)
                continue
            i += len(tag)                             # $seed$ : on descend
            continue
    i += 1

cand = sorted({(t, l) for t, l in lits if re.fullmatch(r"[a-z][a-z0-9_]*", t)})
print(f"litteraux extraits : {len(lits)} ; de forme identifiant : {len(cand)}")
print("\n-- valeurs d'enum utilisees --")
used = sorted({t for t, _ in cand if t in values})
print("  " + ", ".join(used))
print("\n-- litteraux identifiant HORS enum (a confirmer a la main) --")
for t, l in cand:
    if t not in values:
        print(f"  ligne {l:>5} : {t}")
