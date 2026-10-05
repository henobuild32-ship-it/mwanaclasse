"""Verifie que chaque colonne referencee par 006_seed_demo.sql existe reellement
dans les tables definies par 001..005 (analyse des CREATE TABLE)."""
import re
import sys
from collections import defaultdict

BASE = r"C:\MwanaClasse\db\sql"
SCHEMA_FILES = ["001_extensions_and_helpers.sql", "002_core_schema.sql",
                "003_security_schema.sql", "004_rls_views.sql", "005_sync_offline.sql"]

tables = {}          # 'schema.table' -> set(colonnes)

create_re = re.compile(
    r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_]+\.[a-z_]+)\s*\((.*?)\n\)\s*;",
    re.S | re.I)

for f in SCHEMA_FILES:
    src = open(f"{BASE}\\{f}", encoding="utf-8").read()
    for m in create_re.finditer(src):
        name, body = m.group(1).lower(), m.group(2)
        cols = set()
        depth = 0
        cur = []
        parts = []
        i = 0
        # decoupe sur les virgules de niveau 1 (hors parentheses et hors quotes)
        while i < len(body):
            c = body[i]
            if c == "'":
                j = i + 1
                while j < len(body):
                    if body[j] == "'":
                        if j + 1 < len(body) and body[j + 1] == "'":
                            j += 2
                            continue
                        break
                    j += 1
                cur.append(body[i:j + 1])
                i = j + 1
                continue
            if body.startswith("--", i):
                j = body.find("\n", i)
                i = len(body) if j < 0 else j
                continue
            if c == "(":
                depth += 1
            elif c == ")":
                depth -= 1
            if c == "," and depth == 0:
                parts.append("".join(cur))
                cur = []
                i += 1
                continue
            cur.append(c)
            i += 1
        parts.append("".join(cur))
        for p in parts:
            p = re.sub(r"--[^\n]*", "", p).strip()
            if not p:
                continue
            first = p.split()[0].lower().strip('"')
            if first in ("constraint", "primary", "unique", "check", "foreign", "exclude"):
                continue
            cols.add(first)
        tables[name] = cols

print(f"tables detectees : {len(tables)}")

seed = open(f"{BASE}\\006_seed_demo.sql", encoding="utf-8").read()

# 1) INSERT INTO t (a, b, c)
ins_re = re.compile(r"INSERT\s+INTO\s+([a-z_]+\.[a-z_]+)\s*\(([^)]*)\)", re.I | re.S)
problems = []
n_checked = 0
for m in ins_re.finditer(seed):
    tbl = m.group(1).lower()
    if tbl not in tables:
        problems.append(f"table inconnue : {tbl}")
        continue
    cols = [c.strip().lower() for c in m.group(2).split(",") if c.strip()]
    for c in cols:
        n_checked += 1
        if c not in tables[tbl]:
            problems.append(f"{tbl} : colonne inexistante '{c}'")

# 2) UPDATE t SET a = ..., b = ...
upd_re = re.compile(r"UPDATE\s+([a-z_]+\.[a-z_]+)\s+SET\s+(.*?)(?:WHERE|;)", re.I | re.S)
for m in upd_re.finditer(seed):
    tbl = m.group(1).lower()
    if tbl not in tables:
        problems.append(f"table inconnue (UPDATE) : {tbl}")
        continue
    for assign in m.group(2).split(","):
        if "=" not in assign:
            continue
        col = assign.split("=")[0].strip().lower()
        n_checked += 1
        if col not in tables[tbl]:
            problems.append(f"{tbl} (UPDATE) : colonne inexistante '{col}'")

# 3) INSERT INTO t sans liste de colonnes -> doit fournir toutes les colonnes
for m in re.finditer(r"INSERT\s+INTO\s+([a-z_]+\.[a-z_]+)\s*(?:VALUES|\()", seed, re.I):
    pass

# 4) SELECT ... INTO v FROM t : colonnes qualifiees s.xxx / a.xxx / c.xxx / l.xxx / p.xxx / r.xxx
#    (controle indirect : on verifie les alias de table utilises dans les FROM)
alias_re = re.compile(r"\b(?:FROM|JOIN)\s+([a-z_]+\.[a-z_]+)\s+(?:AS\s+)?([a-z][a-z0-9_]{0,3})\b", re.I)
alias_map = {}
for m in alias_re.finditer(seed):
    alias_map.setdefault(m.group(2).lower(), set()).add(m.group(1).lower())
# les variables RECORD de PL/pgSQL (FOR r IN ...) ne sont pas des alias de table
record_aliases = set(x.lower() for x in re.findall(r"FOR\s+([a-z_]\w*)\s+IN\b", seed, re.I))
print(f"alias de table detectes : {len(alias_map)} (variables record exclues : {record_aliases})")
for alias in list(alias_map):
    if alias in record_aliases:
        del alias_map[alias]
for alias, tbls in sorted(alias_map.items()):
    for t in tbls:
        if t not in tables:
            problems.append(f"alias {alias} -> table inconnue {t}")

# 5) colonnes qualifiees par alias : alias.colonne
qual_re = re.compile(r"\b([a-z][a-z0-9_]{0,3})\.([a-z_][a-z0-9_]*)\b")
seen = set()
for m in qual_re.finditer(seed):
    alias, col = m.group(1).lower(), m.group(2).lower()
    if alias not in alias_map:
        continue
    key = (alias, col)
    if key in seen:
        continue
    seen.add(key)
    tbls = alias_map[alias]
    if not any(col in tables[t] for t in tbls if t in tables):
        problems.append(f"alias {alias} ({'/'.join(sorted(tbls))}) : colonne inexistante '{col}'")

print(f"colonnes verifiees : {n_checked} (+ {len(seen)} qualifiees)")
if problems:
    print("\nPROBLEMES :")
    for p in sorted(set(problems)):
        print("  -", p)
    sys.exit(1)
print("\nOK : toutes les colonnes referencees existent.")
