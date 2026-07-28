import json

with open('data/violations.json') as f:
    d = json.load(f)

CUTOFF = '2025-10-01'

for b in d['buildings']:
    kept_apts = []
    for apt in b['apartments']:
        apt['violations'] = [v for v in apt['violations'] if v['approved_date'] >= CUTOFF]
        if apt['violations']:
            kept_apts.append(apt)
    b['apartments'] = kept_apts

d['buildings'] = [b for b in d['buildings'] if b['apartments']]

with open('data/violations.json', 'w') as f:
    json.dump(d, f)