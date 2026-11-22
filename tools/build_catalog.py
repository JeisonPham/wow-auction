"""Rebuild the bundled catalog from Forever data files listed in src/data/SOURCES.md."""

import argparse
import gzip
import json
import re
import sys
from collections import Counter
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "client"))
from lua_data import array, named_table

URLS = {
    "Data.lua": "https://raw.githubusercontent.com/masterred92/DwarfExplorersBible/f56c16a72671143cb3c86b0e62462fac558c4bf6/Data.lua",
    "items.json": "https://raw.githubusercontent.com/gBlaku/wow-forever-kb/f93674b86e3a9d2a1f349bc942da7cb9b8ef76dd/items.json",
    "professions.json": "https://raw.githubusercontent.com/peligwen/peligaming/a8a26d10c6d1dec3acfc677010f914d7cd0dc7ee/public/tools/wow-forever/data/professions/professions.json",
    "Disenchant.lua": "https://raw.githubusercontent.com/ProfessionsForever/Professions_Forever/94e0dac68c61dd56d67bcbec4ea5e2ce04068caa/Data/Disenchant.lua",
}
SLOTS = {
    "Head": 1,
    "Neck": 2,
    "Shoulder": 3,
    "Shirt": 4,
    "Chest": 5,
    "Waist": 6,
    "Legs": 7,
    "Feet": 8,
    "Wrist": 9,
    "Hands": 10,
    "Finger": 11,
    "Trinket": 12,
    "One-Hand": 13,
    "Shield": 14,
    "Ranged": 15,
    "Back": 16,
    "Two-Hand": 17,
    "Tabard": 19,
    "Main Hand": 21,
    "Off Hand": 22,
    "Held In Off-hand": 23,
    "Thrown": 25,
    "Relic": 28,
}


def build(folder):
    data = named_table((folder / "Data.lua").read_text(), "ns.Data")
    prof = json.loads((folder / "professions.json").read_text())
    kb = json.loads((folder / "items.json").read_text())
    items = {}
    for row in kb["items"]:
        i = dict(zip(kb["fields"], row))
        if i["est"]:
            continue
        meta = dict(
            name=i["name"],
            level=i["ilvl"] or 0,
            quality=i["q"] or 0,
            binding=i["bind"] or "Unbound",
        )
        if i["ic"] in ("Armor", "Weapon"):
            meta.update(
                {
                    "class": 2 if i["ic"] == "Weapon" else 4,
                    "inventory_slot": SLOTS.get(i["slot"]),
                }
            )
        if i["sell"] is not None:
            meta["vendor_sell"] = i["sell"]
        items[i["id"]] = meta
    entries = {
        (p["name"], r["i"]): (r, p) for p in prof["professions"] for r in p["recipes"]
    }
    recipes, reqs = [], {}
    for line in array(data["recipes"]):
        product, qty, high, group, yellow, grey, spell, reagents = line.split(";")
        product, qty, spell = int(product), int(qty), int(spell)
        profession = data["professions"][int(group)]
        r, p = entries.get((profession, spell), ({}, {}))
        if product in data["hidden"] or r.get("x") or not reagents or qty <= 0:
            continue
        mats = Counter()
        for entry in reagents.split(","):
            id_, n = map(int, entry.split(":"))
            mats[id_] += n
        rid = str(spell)
        name = data["names"].get(product, r.get("n", f"Item {product}"))
        recipes.append(
            dict(
                id=rid,
                name=name,
                output=product,
                quantity=qty,
                mats=sorted(mats.items()),
            )
        )
        # The pinned table stores the midpoint for Heavy Dynamite; see SOURCES.md.
        if spell == 3946 and product == 4378 and qty == int(high) == 3:
            recipes[-1].update(quantity_min=1, quantity_max=5)
        elif int(high) > qty:
            recipes[-1]["quantity_max"] = int(high)
        req = {"profession": profession, "category": p.get("kind", "primary")}
        if r.get("l"):
            req["skill"] = r["l"]
        req["source"] = {
            "a": "Automatic",
            "i": "Recipe item",
            "t": "Classic trainer reference",
            "e": "Estimated trainer requirement",
            "u": "Learning source unknown",
        }.get(r.get("s"), "Learning source unknown")
        if r.get("ri"):
            req["pattern"] = items.get(r["ri"], {}).get(
                "name", data["names"].get(r["ri"], f"Item {r['ri']}")
            )
        if r.get("f"):
            req["station"] = r["f"]
        if r.get("lv"):
            req["character_level"] = r["lv"]
        if r.get("fa"):
            req["faction"] = {"A": "Alliance", "H": "Horde"}[r["fa"]]
        if "ct" in r:
            req["cast_seconds"] = r["ct"]
        if r.get("cd"):
            req["cooldown_seconds"] = r["cd"]
        if spell in data.get("tools", {}):
            req["tools"] = array(data["tools"][spell])
        reqs[rid] = req
    assert len({r["id"] for r in recipes}) == len(recipes)
    for id_, name in data["names"].items():
        meta = items.setdefault(id_, {"name": name})
        p = prof["items"].get(str(id_), [])
        if len(p) > 3 and p[3] and "vendor_sell" not in meta:
            meta["vendor_sell"] = p[3]
        if id_ in data["buy"]:
            meta["vendor_buy"] = data["buy"][id_]
    de = (folder / "Disenchant.lua").read_text()
    outcomes = {}
    for key, line in named_table(de, "FP.DisenchantTables").items():
        drops = Counter()
        for entry in line.split(";"):
            id_, pct, lo, hi = entry.split(",")
            drops[int(id_)] += float(pct) * (int(lo) + int(hi)) / 200
        outcomes[key] = dict(drops)
    bands = []
    for cls, qualities in named_table(de, "FP.DisenchantBrackets").items():
        for quality, bracket in qualities.items():
            for row in array(bracket):
                lo, hi, table = array(row)
                if table in outcomes:
                    bands.append(
                        {
                            "class": cls,
                            "quality": quality,
                            "min_level": lo,
                            "max_level": hi,
                            "mats": outcomes[table],
                        }
                    )
    never = [
        int(x)
        for x in re.search(r'FP\.DisenchantNever\s*=\s*"([^"]+)"', de)[1].split(",")
        if x
    ]
    overrides = {
        k: outcomes[v]
        for k, v in named_table(de, "FP.DisenchantOverride").items()
        if v in outcomes
    }
    return dict(
        build=data["build"],
        disenchant_seconds=entries[("Enchanting", 13262)][0]["ct"],
        snapshot=dict(
            recipes=recipes,
            recipe_requirements=reqs,
            items=items,
            disenchant=bands,
            non_disenchantable=never,
        ),
        overrides=overrides,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_dir", type=Path)
    parser.add_argument("--download", action="store_true")
    args = parser.parse_args()
    if args.download:
        args.source_dir.mkdir(parents=True, exist_ok=True)
        for name, url in URLS.items():
            with urlopen(url, timeout=90) as stream:
                (args.source_dir / name).write_bytes(stream.read())
    catalog = build(args.source_dir)
    out = ROOT / "src/data/forever.json.gz"
    out.write_bytes(
        gzip.compress(json.dumps(catalog, separators=(",", ":")).encode(), mtime=0)
    )
    print(
        len(catalog["snapshot"]["recipes"]),
        "crafts,",
        len(catalog["snapshot"]["items"]),
        "items,",
        len(catalog["snapshot"]["disenchant"]),
        "disenchant bands",
    )
