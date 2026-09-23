"""
Cell-by-cell test: every hour/bin/month value in app/data/bas-weather-bins.js must equal the
corresponding cell in the source workbook's "Temperature Data" and "Humidity Data" sheets.

Usage: python tools/test-bas-weather-data.py
Exits non-zero if any mismatch is found.
"""
import json, sys, openpyxl

SRC = r"C:\Users\Matt Miller\AI\_context\my-knowledge-base\raw\Calcs\BAS Savings Calc Template.xlsm"
DATA = r"C:\Users\Matt Miller\AI\_context\temp\2026-09-22-bas-calc-weather-worktree\app\data\bas-weather-bins.js"

# load generated JS data (strip the const assignment / trailing semicolon)
with open(DATA, encoding="utf-8") as f:
    text = f.read()
idx0 = text.index("const BAS_WEATHER_BINS =") + len("const BAS_WEATHER_BINS =")
json_part = text[idx0:].strip().rstrip(";")
data = json.loads(json_part)
bins = data["bins"]
bin_index = {b:i for i,b in enumerate(bins)}
months = ["January","February","March","April","May","June","July","August","September","October","November","December"]

wb = openpyxl.load_workbook(SRC, data_only=True)

def check_city(loc_id, sheet_name, field, city_key):
    ws = wb[sheet_name]
    # find block
    blocks = []
    for r in range(1, ws.max_row+1):
        a = ws.cell(r,1).value; b = ws.cell(r,2).value
        if isinstance(a,(int,float)) and float(a).is_integer() and isinstance(b,str):
            blocks.append((r,int(a),b))
    start=None; end=ws.max_row
    for i,(r,lid,name) in enumerate(blocks):
        if lid==loc_id:
            start=r
            if i+1<len(blocks): end=blocks[i+1][0]-1
            break
    mismatches=0
    checked=0
    month_idx=None
    grid = data["cities"][str(loc_id)][city_key]
    for r in range(start+4, end+1):
        bin_val = ws.cell(r,2).value
        month_val = ws.cell(r,4).value
        if month_val is not None:
            if month_val not in months: continue
            month_idx = months.index(month_val)
        if bin_val is None or month_idx is None: continue
        if not isinstance(bin_val,(int,float)): continue
        bidx = bin_index[bin_val]
        for h in range(24):
            v = ws.cell(r, 5+h).value
            expected = float(v) if isinstance(v,(int,float)) else 0.0
            actual = grid[month_idx][bidx][h]
            checked+=1
            if abs(expected-actual) > 1e-9:
                mismatches+=1
                if mismatches<=5:
                    print("MISMATCH", field, "row",r,"bin",bin_val,"month",months[month_idx],"hour",h+1,"expected",expected,"actual",actual)
    print(field, "checked", checked, "mismatches", mismatches)
    return checked, mismatches

print("=== Kansas City (id 4) ===")
c1 = check_city(4, "Temperature Data", "temperature", "temp")
c2 = check_city(4, "Humidity Data", "humidity", "humidity")
print("=== St Louis, MO (id 16) ===")
c3 = check_city(16, "Temperature Data", "temperature", "temp")
c4 = check_city(16, "Humidity Data", "humidity", "humidity")

print("=== ALL CITIES SWEEP ===")
total_checked=0
total_mismatch=0
for lid in sorted(int(k) for k in data["cities"].keys()):
    ct,cm = check_city(lid, "Temperature Data", f"temp-{lid}", "temp")
    ch,hm = check_city(lid, "Humidity Data", f"hum-{lid}", "humidity")
    total_checked += ct+ch
    total_mismatch += cm+hm
print("TOTAL checked", total_checked, "TOTAL mismatches", total_mismatch)
sys.exit(1 if total_mismatch else 0)
