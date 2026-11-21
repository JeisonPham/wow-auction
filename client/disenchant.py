"""Normalize recognized, unconditional Forever yield rules; unknown data disables DE."""

from lua_data import named_table


def item_id(value):
    text = str(value)
    if text.startswith("i:"):
        text = text[2:]
    item = int(text)
    if not 1 <= item <= 0xFFFFFFFF:
        raise ValueError("Invalid base item ID")
    return item


def import_tables(yields, exclusions):
    try:
        bands = named_table(yields, "DATA.Forever")
        all_items = named_table(exclusions, "DATA.All")
        forever = named_table(exclusions, "DATA.Forever")
    except ValueError:
        return {}
    if bands is None or (all_items is None and forever is None):
        return {}
    excluded = set()
    try:
        for group in (all_items, forever):
            for key, value in (group or {}).items():
                if value is True:
                    excluded.add(item_id(key))
                elif type(value) in (int, str):
                    excluded.add(item_id(value))
                else:
                    raise ValueError("Unrecognized exclusion")
        result = []

        def visit(node, path):
            if not isinstance(node, dict):
                raise ValueError("Unknown yield condition")
            if "minItemLevel" in node or "min_level" in node:
                allowed = {
                    "minItemLevel",
                    "maxItemLevel",
                    "min_level",
                    "max_level",
                    "class",
                    "classID",
                    "quality",
                    "requiredSkill",
                    "materials",
                    "mats",
                    "itemID",
                    "itemString",
                    "amountOfMats",
                    "dropChance",
                }
                if set(node) - allowed:
                    raise ValueError("Unknown yield condition")
                cls = node.get("class", node.get("classID", path[0] if path else None))
                quality = node.get("quality", path[1] if len(path) > 1 else None)
                mats = {}
                for key, row in node.get(
                    "materials", node.get("mats", {1: node})
                ).items():
                    if isinstance(row, dict):
                        if row is not node and set(row) - {
                            "itemID",
                            "itemString",
                            "amountOfMats",
                            "dropChance",
                            "chance",
                        }:
                            raise ValueError("Unknown material rule")
                        material = item_id(
                            row.get("itemID", row.get("itemString", key))
                        )
                        if material in mats:
                            raise ValueError("Duplicate yield")
                        mats[material] = float(row["amountOfMats"])
                    else:
                        mats[item_id(key)] = float(row)
                result.append(
                    dict(
                        min_level=int(node.get("min_level", node.get("minItemLevel"))),
                        max_level=int(node.get("max_level", node.get("maxItemLevel"))),
                        quality=int(
                            {"Uncommon": 2, "Rare": 3, "Epic": 4}.get(quality, quality)
                        ),
                        **{"class": int({"Weapon": 2, "Armor": 4}.get(cls, cls))},
                        skill=int(node.get("requiredSkill", 0)),
                        mats=mats,
                    )
                )
            else:
                for key, child in node.items():
                    visit(child, path + [key])

        visit(bands, [])
        return {"disenchant": result, "non_disenchantable": sorted(excluded)}
    except (TypeError, ValueError, KeyError):
        return {}
