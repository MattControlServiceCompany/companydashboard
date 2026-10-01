#!/usr/bin/env python3
"""Independent recalculation of an .xlsx with the `formulas` package (pip install formulas).
Usage: python scripts/recalc-xlsx.py <file.xlsx> <out.json>
Writes {"SHEET!A1": value, ...} for every cell of the Dash, Mat & Equip and Labor Rates sheets."""
import json
import re
import sys
import warnings

import formulas

warnings.filterwarnings('ignore')
src, out = sys.argv[1], sys.argv[2]
sol = formulas.ExcelModel().loads(src).finish().calculate()
res = {}
for k, rng in sol.items():
    m = re.match(r"^'\[[^\]]+\](.+)'!([A-Z]+\d+)$", k)
    if not m or m.group(1) not in ('DASH', 'MAT & EQUIP', 'LABOR RATES'):
        continue
    try:
        v = rng.value[0][0]
    except Exception:
        continue
    if hasattr(v, 'item'):
        v = v.item()
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        res[m.group(1) + '!' + m.group(2)] = float(v)
    elif isinstance(v, str):
        res[m.group(1) + '!' + m.group(2)] = v
json.dump(res, open(out, 'w'))
print('cells', len(res))
