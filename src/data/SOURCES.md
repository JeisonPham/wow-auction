# WoW Forever craft catalog

The scanner bundles a market-independent catalog. Live prices and character records come from the selected market and game installation.

| Input | Use |
| --- | --- |
| [Dwarf Explorer’s Bible, Data.lua](https://github.com/masterred92/DwarfExplorersBible/blob/f56c16a72671143cb3c86b0e62462fac558c4bf6/Data.lua) | Output item, minimum quantity, spell ID, profession, reagents, tools and confirmed vendor reagent prices from Forever build 1.60.1.71037 with the upstream 70959 hotfix overlay. Kenny (masterred92), MIT. See DWARF-LICENSE.txt. |
| [WoW Forever Knowledge Base](https://github.com/gBlaku/wow-forever-kb) | Item names, vendor sell prices, binding, quality, item level, class and equipment slot from the published items.json, build 1.60.1.70938. Classic-estimated entries are excluded from this import. |
| [Peligaming profession catalog](https://github.com/peligwen/peligaming/tree/a8a26d10c6d1dec3acfc677010f914d7cd0dc7ee/public/tools/wow-forever/data/professions) | Acquisition source, skill and character level when known, patterns, stations, cast durations (the `ct` field in seconds, including Disenchant spell 13262), cooldowns and supplementary item sell values. Build 1.60.1.70888. Trainer data incorporates Classic references, including CMaNGOS, and estimated learning ranks. The dashboard labels those sources. |
| [Professions Forever disenchant data](https://github.com/ProfessionsForever/Professions_Forever/blob/94e0dac68c61dd56d67bcbec4ea5e2ce04068caa/Data/Disenchant.lua) | Forever 1.60.1.70938 equipment brackets and Classic loot probabilities, item overrides and exclusions. Upstream derives loot data from [CMaNGOS Classic DB](https://github.com/cmangos/classic-db/tree/c33f90b8eeb3f8bacb53d5cbfee45075c80b416c). See DISENCHANT-LICENSE.txt for GPL-3.0 and the corresponding source in Disenchant.lua. |

The catalog includes named item-producing recipes with a known positive minimum yield and a reagent list. Hidden products and recipes flagged as historical leftovers are excluded. The route planner uses the catalog or uploaded planning quantity. Craft simulations use the recorded minimum and maximum when available, with equal odds between the bounds. The pinned data lists three pieces for Heavy Dynamite (spell 3946). Its simulation range is corrected to 1–5, preserving three as the bundled planning quantity. Sources: [ForeverDB recipe](https://www.foreverdb.app/en/forever/spells/3946/heavy-dynamite) and [Azeroth Wiki item](https://azeroth.wiki/forever/items/heavy-dynamite). Random loot containers, direct enchants without a sellable item, camp actions and gather-only skills have no craft-to-sale calculation. A client recipe entry does not establish that its pattern is currently obtainable. Direct routes buy reagents at the selected vendor or auction price. Chained routes compare those purchases with producing reagents through intermediate recipes or disenchanting.

The bundled disenchant estimator averages the minimum and maximum stack sizes, weights by each drop chance and applies item-specific overrides. If the uploader recognizes a complete installed TSM yield and exclusion table, its yields take precedence. All game names and underlying game data belong to their respective owners.

To build from source, run the following from the project root. The first argument is a scratch directory for the four upstream inputs. Omit the download flag to use existing files.

```sh
python3 tools/build_catalog.py /tmp/wam-forever-sources --download
```
