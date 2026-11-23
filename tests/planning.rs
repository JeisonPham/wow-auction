use serde_json::{json, Value};
use std::io::Write;
use wow_auction_monitor::{feed, planner, scan};
fn zip(bytes: &[u8]) -> Vec<u8> {
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    gz.write_all(bytes).unwrap();
    gz.finish().unwrap()
}
fn price(p: u64, n: u64, a: u64, t: u64) -> Value {
    json!({"total_buyout":p,"units":n,"auctions":a,"observed_at":t})
}
fn fixture() -> Value {
    json!({"version":1,"region":"Forever-US","market":"Normal-Alliance","revision":100000000,"snapshot":{
"items":{"1001":{"name":"Ore"},"2000":{"name":"Buckle","vendor_sell":100}},
"estimate_at":99,"estimate_prices":{"1001":price(7,1,6,99),"1003":price(15,1,15,99)},
"recipes":[{"id":"buckle","name":"Buckle","output":2000,"quantity":1,"mats":[[1001,3]],"characters":["Ada"]}]},"targeted":[{"captured_at":100,"prices":{"1001":price(22,4,2,100)},"listed_units":{"1001":4,"1002":0}}]})
}
fn decode(v: &Value) -> scan::Bundle {
    scan::decode(
        &zip(&serde_json::to_vec(v).unwrap()),
        "Forever-US",
        "Normal-Alliance",
        101,
    )
    .unwrap()
}
fn report(v: &Value, f: &feed::Feed, t: u64) -> Value {
    planner::report("Forever-US", "Normal-Alliance", Some(&decode(v)), f, 100, t)
}
fn item(r: &Value, id: u32) -> &Value {
    r["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["id"] == id)
        .unwrap()
}
#[test]
fn checked_lot_depth_round_trips_and_matches_scan_totals() {
    let mut v = fixture();
    let lots = json!([[2, 11, 2]]);
    v["targeted"][0]["prices"]["1001"]["lots"] = lots.clone();
    let r = report(&v, &Default::default(), 101);
    assert_eq!(item(&r, 1001)["lots"], lots);
    assert_eq!(r["shopping_max_age"], 100);
    for invalid in [
        json!([[2, 11, 1]]),
        json!([[2, 12, 2]]),
        json!([[0, 11, 2]]),
    ] {
        v["targeted"][0]["prices"]["1001"]["lots"] = invalid;
        assert!(scan::decode(
            &zip(&serde_json::to_vec(&v).unwrap()),
            "Forever-US",
            "Normal-Alliance",
            101
        )
        .is_err());
    }
}
#[test]
fn buckle_and_coverage() {
    let r = report(&fixture(), &Default::default(), 101);
    let route = &item(&r, 2000)["routes"][0];
    assert_eq!(route["profit"], 83);
    assert_eq!(route["timing"]["assumed_cast"], true);
    assert_eq!(route["timing"]["elapsed_seconds"], 3.0);
    assert_eq!(route["cost"], 17);
    assert_eq!(route["stock"], "verified");
    assert_eq!(r["scan_queue"], json!([1001]));
    assert_eq!(item(&r, 1001)["checked_price"], 5.5);
    assert_eq!(item(&r, 1002)["listed_units"], 0);
    assert!(item(&r, 1003)["listed_units"].is_null());
    assert_eq!(item(&r, 1003)["estimated_auctions"], 15)
}
#[test]
fn freshness_and_whole_books() {
    let mut f = feed::Feed {
        at: 99,
        ..Default::default()
    };
    f.items.insert(1002, ("Tin".into(), 88));
    let v = fixture();
    let r = report(&v, &f, 101);
    assert!(item(&r, 1002)["estimate"].is_null());
    assert_eq!(r["tsm"]["source"], "Desktop AppHelper");
    f.at = 100;
    let r = report(&v, &f, 101);
    assert_eq!(item(&r, 1001)["estimate"], 7);
    assert!(item(&r, 1002)["estimate"].is_null());
    let r = report(&v, &f, 200);
    assert!(item(&r, 1001)["estimate"].is_null());
    assert_eq!(item(&r, 1002)["estimate"], 88);
    let r = report(&v, &Default::default(), 201);
    assert_eq!(r["tsm"]["state"], "stale");
    assert!(item(&r, 1001)["estimate"].is_null());
    assert_eq!(item(&r, 1001)["estimated_auctions"], 6);
    assert!(item(&r, 1002)["listed_units"].is_null());
    assert_eq!(r["scan_queue"], json!([]))
}
#[test]
fn vendor_fallback_and_newer_full() {
    let mut v = fixture();
    v["snapshot"]["newest_price_at"] = 101.into();
    v["snapshot"]["items"]["1001"]["vendor_buy"] = 8.into();
    let r = report(&v, &Default::default(), 101);
    let route = &item(&r, 2000)["routes"][0];
    assert_eq!(route["profit"], 76);
    assert_eq!(route["inputs"][0]["source"], "vendor");
    assert_eq!(item(&r, 1001)["listed_units"], 0)
}
#[test]
fn disenchant_yields() {
    let mut v = fixture();
    let s = &mut v["snapshot"];
    s["items"]["30"] =
        json!({"name":"Blade","class":2,"level":10,"quality":2,"inventory_type":"INVTYPE_WEAPON"});
    s["professions"] = json!({"Ada":{"Enchanting":50}});
    s["non_disenchantable"] = json!([]);
    s["disenchant"] =
        json!([{"class":2,"quality":2,"min_level":8,"max_level":10,"skill":50,"mats":{"31":1.5}}]);
    s["estimate_prices"]["30"] = price(50, 1, 1, 99);
    s["estimate_prices"]["31"] = price(100, 1, 1, 99);
    let r = report(&v, &Default::default(), 101);
    assert_eq!(item(&r, 30)["routes"][0]["profit"], 71);
    assert_eq!(item(&r, 30)["routes"][0]["timing"]["elapsed_seconds"], 3.0);
    assert_eq!(item(&r, 30)["routes"][0]["stock"], "estimated");
    for (id, p) in [("30", 50), ("31", 100)] {
        v["targeted"][0]["prices"][id] = price(p, 1, 1, 100);
        v["targeted"][0]["listed_units"][id] = 1.into()
    }
    let r = report(&v, &Default::default(), 101);
    assert_eq!(item(&r, 30)["routes"][0]["stock"], "verified");
    v["snapshot"]["non_disenchantable"] = json!([30]);
    assert_eq!(
        item(&report(&v, &Default::default(), 101), 30)["routes"],
        json!([])
    )
}
#[test]
fn queue_never_splits_a_recipe() {
    let mut v = fixture();
    let s = &mut v["snapshot"];
    let mats = (3000..3251)
        .map(|id| {
            s["estimate_prices"][id.to_string()] = price(1, 1, 1, 99);
            json!([id, 1])
        })
        .collect::<Vec<_>>();
    s["items"]["9000"] = json!({"vendor_sell":100000});
    s["recipes"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"large","name":"Large","output":9000,"quantity":1,"mats":mats}));
    assert_eq!(
        report(&v, &Default::default(), 101)["scan_queue"],
        json!([1001])
    )
}
#[test]
fn csv_and_gzip_validation() {
    let csv = b"itemId,name,recent,updatedAt\r\n100,\"Ore, fine\",10,1970-01-01T00:01:40Z\r\n";
    let feed = feed::parse(csv, "Forever-US", "Normal-Alliance", 101).unwrap();
    assert_eq!(feed.items[&100].0, "Ore, fine");
    assert!(feed::parse(&[csv.as_slice(), &csv[29..]].concat(), "", "", 101).is_err());
    let check = |data: &[u8]| scan::decode(data, "Forever-US", "Normal-Alliance", 101).is_err();
    let b = decode(&fixture());
    let buf = scan::encode(&b).unwrap();
    assert!(check(&[buf.clone(), buf].concat()));
    assert!(check(&zip(br#"{"version":1,"version":1}"#)));
    let mut v = fixture();
    v["targeted"][0]["listed_units"]["1001"] = 3.into();
    assert!(check(&zip(&serde_json::to_vec(&v).unwrap())));
}
#[test]
#[ignore]
fn live_forever_market() {
    assert!(!feed::fetch("Forever-US", "Normal-Alliance")
        .unwrap()
        .items
        .is_empty())
}

fn recipe_route<'a>(r: &'a Value, id: u32, rid: &str, kind: &str) -> &'a Value {
    item(r, id)["routes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["recipe_id"] == rid && r["kind"] == kind)
        .unwrap()
}
#[test]
fn unlearned_catalog_recipe_is_priced_without_upload() {
    let mut f = feed::Feed {
        at: 100,
        ..Default::default()
    };
    f.items.insert(2840, ("Copper Bar".into(), 1));
    let r = planner::market_report("Forever-US", "Normal-Alliance", None, &f, 100, 101);
    let belt = recipe_route(&r, 2851, "2661", "craft");
    let dynamite = recipe_route(&r, 4378, "3946", "craft");
    assert_eq!(dynamite["quantity"], 3);
    assert_eq!(dynamite["quantity_min"], 1);
    assert_eq!(dynamite["quantity_max"], 5);
    assert_eq!(dynamite["required_character_level"], 10);
    let handbook = recipe_route(&r, 20844, "25347", "craft");
    assert_eq!(handbook["requirements"]["pattern_id"], 21302);
    assert_eq!(handbook["required_character_level"], 60);
    let bracers = recipe_route(&r, 12425, "16649", "craft");
    assert_eq!(bracers["requirements"]["pattern_character_level"], 0);
    assert_eq!(bracers["requirements"]["pattern_quest_level"], 50);
    assert_eq!(bracers["required_character_level"], 50);
    // The finished armor kit requires 40 to use. Its pattern only needs the profession rank.
    assert_eq!(
        recipe_route(&r, 252463, "1255073", "craft")["required_character_level"],
        20
    );
    // A tradable quest reward and a bound pattern with a vendor source may both bypass the quest.
    for (id, spell) in [(3728, "3399"), (3726, "3397")] {
        let recipe = recipe_route(&r, id, spell, "craft");
        assert!(recipe["requirements"].get("pattern_quest_level").is_none());
        assert_eq!(recipe["required_character_level"], 10);
    }
    assert_eq!(belt["required_character_level"], 1);
    assert_eq!(belt["ready"], false);
    assert_eq!(belt["cost"], 6);
    assert_eq!(belt["timing"]["assumed_cast"], false);
    assert_eq!(belt["timing"]["elapsed_seconds"], 8.0);
    assert_eq!(
        belt["timing"]["gold_per_hour"].as_f64().unwrap(),
        belt["profit"].as_f64().unwrap() / 10000.0 * 3600.0 / 8.0
    );
    assert!(belt["profit"].as_i64().unwrap() > 0);
    assert!(belt["advice"]
        .as_str()
        .unwrap()
        .contains("Blacksmithing 30"));
    assert!(r["catalog"]["recipes"].as_u64().unwrap() > 2000);
    assert_eq!(r["catalog"]["characters"], 0);
}

#[test]
fn character_level_combines_recipe_and_rank_and_keeps_unknowns_distinct() {
    let mut v = fixture();
    for (req, expected) in [
        (json!({"profession":"Engineering","skill":75}), Some(1)),
        (json!({"profession":"Engineering","skill":76}), Some(10)),
        (json!({"profession":"Engineering","skill":150}), Some(10)),
        (
            json!({"profession":"Engineering","skill":150,"pattern":"Pattern","pattern_character_level":49,"pattern_quest_level":40}),
            Some(49),
        ),
        (
            json!({"profession":"Engineering","skill":226,"pattern":"Pattern","pattern_character_level":1}),
            Some(35),
        ),
        (
            json!({"profession":"Engineering","skill":150,"pattern":"Pattern","pattern_character_level":null}),
            None,
        ),
        (
            json!({"profession":"Engineering","skill":150,"pattern":"Pattern"}),
            None,
        ),
        (json!({"profession":"Engineering","skill":151}), Some(20)),
        (json!({"profession":"Tailoring","skill":225}), Some(20)),
        (json!({"profession":"Tailoring","skill":226}), Some(35)),
        (json!({"profession":"Cooking","skill":175}), Some(10)),
        (json!({"profession":"First Aid","skill":175}), Some(1)),
        (
            json!({"profession":"Engineering","skill":125,"character_level":30}),
            Some(30),
        ),
        (
            json!({"profession":"Engineering","skill":300,"character_level":10}),
            Some(35),
        ),
        (
            json!({"profession":"Poisons","skill":1,"character_level":20}),
            Some(20),
        ),
        (json!({"profession":"Engineering"}), None),
        (json!({"profession":"Poisons","skill":100}), None),
    ] {
        v["snapshot"]["recipe_requirements"]["buckle"] = req;
        let r = report(&v, &Default::default(), 101);
        assert_eq!(
            recipe_route(&r, 2000, "buckle", "craft")["required_character_level"],
            json!(expected)
        );
    }
}
#[test]
fn craft_exit_costs_and_profession_assignments() {
    let mut v = fixture();
    let s = &mut v["snapshot"];
    s["recipes"][0]["quantity"] = 2.into();
    s["recipes"][0]["quantity_max"] = 5.into();
    s["recipe_requirements"] = json!({"buckle":{"profession":"Blacksmithing","skill":60}});
    s["items"]["2000"] = json!({"name":"Buckle","class":4,"level":10,"quality":2,"inventory_type":"INVTYPE_WAIST","vendor_sell":100,"binding":"Binds when equipped"});
    s["professions"] = json!({"Ada":{"Blacksmithing":80,"Mining":60},"Bea":{"Enchanting":50}});
    s["complete_rosters"] = json!(["Ada", "Bea"]);
    s["non_disenchantable"] = json!([]);
    s["estimate_prices"]["31"] = price(1, 1, 1, 99);
    s["estimate_prices"]["2000"] = price(300, 1, 1, 99);
    s["disenchant"] = json!([{"class":4,"quality":2,"min_level":1,"max_level":20,"mats":{"31":101.5},"skill":50}]);
    let r = report(&v, &Default::default(), 101);
    let de = recipe_route(&r, 2000, "buckle", "craft_disenchant");
    assert_eq!(de["cost"], 17);
    assert_eq!(de["proceeds"], 163);
    assert_eq!(de["quantity_max"], 5);
    assert_eq!(de["timing"]["end_de_seconds"], 3.0);
    assert_eq!(de["net_unit_value"], 101.5_f64 * 323.0 / 400.0);
    assert_eq!(de["required_character_level"], 1);
    assert_eq!(
        recipe_route(&r, 2000, "buckle", "craft")["net_unit_value"],
        100
    );
    assert_eq!(
        recipe_route(&r, 2000, "buckle", "craft_auction")["net_unit_value"],
        242.25
    );
    // One craft makes two pieces. Each takes its own disenchant cast.
    assert_eq!(de["timing"]["active_seconds"], 9.0);
    assert_eq!(de["outputs"][0]["quantity"], 203.0);
    assert_eq!(de["ready"], true);
    assert!(de["advice"].as_str().unwrap().contains("Bea"));
    assert_eq!(
        recipe_route(&r, 2000, "buckle", "craft_auction")["proceeds"],
        484
    );
    // Buying the reagents to craft the gear does not require buying that gear.
    v["targeted"][0]["listed_units"]["2000"] = 0.into();
    assert_eq!(
        recipe_route(
            &report(&v, &Default::default(), 101),
            2000,
            "buckle",
            "craft_disenchant"
        )["profit"],
        146
    );
    v["snapshot"]["items"]["2000"]["binding"] = "Binds when picked up".into();
    v["snapshot"]["professions"]["Bea"]["Tailoring"] = 100.into();
    let r = report(&v, &Default::default(), 101);
    let de = recipe_route(&r, 2000, "buckle", "craft_disenchant");
    assert_eq!(de["ready"], false);
    assert!(de["advice"].as_str().unwrap().contains("alt"));
    assert!(item(&r, 2000)["routes"]
        .as_array()
        .unwrap()
        .iter()
        .all(|x| x["kind"] != "craft_auction"));
    v["snapshot"]["recipes"][0]["characters"] = json!([]);
    v["snapshot"]["professions"] = json!({"Ada":{"Blacksmithing":30,"Mining":1},"Bea":{}});
    let r = report(&v, &Default::default(), 101);
    let route = recipe_route(&r, 2000, "buckle", "craft");
    assert!(route["advice"]
        .as_str()
        .unwrap()
        .contains("level Blacksmithing from 30 to 60"));
    assert_eq!(route["ready"], false);
    // One open slot on the only character cannot be assigned twice.
    v["snapshot"]["items"]["2000"]["binding"] = "Unbound".into();
    v["snapshot"]["professions"] = json!({"Ada":{"Mining":1}});
    v["snapshot"]["complete_rosters"] = json!(["Ada"]);
    let r = report(&v, &Default::default(), 101);
    assert!(
        recipe_route(&r, 2000, "buckle", "craft_disenchant")["advice"]
            .as_str()
            .unwrap()
            .contains("alt")
    );
    v["snapshot"]["complete_rosters"] = json!([]);
    let r = report(&v, &Default::default(), 101);
    assert!(recipe_route(&r, 2000, "buckle", "craft")["advice"]
        .as_str()
        .unwrap()
        .contains("open primary slots"));
}

#[test]
fn chains_craft_disenchant_reuse_drops_then_craft_and_vendor() {
    let mut v = fixture();
    let s = &mut v["snapshot"];
    s["items"] = json!({
        "10":{"name":"Ore","binding":"Unbound"}, "11":{"name":"Fitting","binding":"Unbound"},
        "12":{"name":"Ring","class":4,"quality":2,"level":12,"inventory_type":"INVTYPE_FINGER","binding":"Binds when equipped"},
        "13":{"name":"Dust","binding":"Unbound"},"14":{"name":"Shard","binding":"Unbound"},
        "15":{"name":"Bauble","vendor_sell":200,"binding":"Unbound"}
    });
    s["recipes"] = json!([
        {"id":"f","output":11,"name":"Fitting","quantity":3,"mats":[[10,2]],"characters":["Ada"]},
        {"id":"r","output":12,"name":"Ring","quantity":1,"mats":[[11,2]],"characters":["Ada"]},
        {"id":"b","output":15,"name":"Bauble","quantity":1,"mats":[[13,2],[14,1]],"characters":["Bea"]}
    ]);
    s["recipe_requirements"] = json!({"f":{"profession":"Blacksmithing","skill":175,"cast_seconds":2.5,"cooldown_seconds":30},"r":{"profession":"Blacksmithing","skill":70,"cast_seconds":4},"b":{"profession":"Tailoring","skill":80,"cast_seconds":5}});
    s["professions"] =
        json!({"Ada":{"Blacksmithing":200},"Bea":{"Enchanting":100,"Tailoring":100}});
    s["disenchant"] = json!([{"class":4,"quality":2,"min_level":1,"max_level":20,"skill":25,"mats":{"13":0.5,"14":0.25}}]);
    s["non_disenchantable"] = json!([]);
    s["estimate_prices"] = json!({"10":price(10,1,1,99),"11":price(100,1,1,99),"13":price(300,1,1,99),"14":price(300,1,1,99)});
    v["targeted"] = json!([{"captured_at":100,"prices":{"10":price(60,6,1,100)},"listed_units":{"10":6,"12":0}}]);
    let r = report(&v, &Default::default(), 101);
    let routes = item(&r, 15)["routes"].as_array().unwrap();
    assert_eq!(routes[0]["cost"], 900);
    let c = routes.iter().find(|x| x["stages"].is_array()).unwrap();
    assert_eq!(routes[0]["required_character_level"], 10);
    assert_eq!(c["required_character_level"], 20);
    assert_eq!(
        (c["cost"].as_u64(), c["profit"].as_u64()),
        (Some(60), Some(140))
    );
    assert_eq!(c["inputs"].as_array().unwrap().len(), 1);
    assert_eq!(c["inputs"][0]["quantity"], 6);
    assert_eq!(c["stages"].as_array().unwrap().len(), 3);
    assert_eq!(c["stages"][0]["runs"], 3);
    assert_eq!(c["stages"][1]["runs"], 4);
    assert_eq!(c["stages"][2]["action"], "disenchant");
    // 3 fittings casts, 4 ring casts, 4 disenchant casts and 1 final cast.
    assert_eq!(c["timing"]["active_seconds"], 40.5);
    assert_eq!(c["timing"]["elapsed_seconds"], 100.5);
    // Later operations cover the last fitting's cooldown.
    assert_eq!(c["timing"]["repeat_seconds"], 100.5);
    assert_eq!(c["timing"]["assumed_cast"], false);
    assert_eq!(c["stages"][2]["outputs"][0]["quantity"], 2.);
    assert_eq!(c["expected_inputs"], true);
    assert_eq!(c["ready"], true);
    assert_eq!(c["stock"], "estimated");
    let mut higher_de = v.clone();
    higher_de["snapshot"]["disenchant"][0]["skill"] = json!(226);
    let higher = report(&higher_de, &Default::default(), 101);
    assert_eq!(
        item(&higher, 15)["routes"][1]["required_character_level"],
        35
    );
    assert_eq!(
        recipe_route(&higher, 12, "r", "craft_disenchant")["required_character_level"],
        35
    );
    higher_de["snapshot"]["recipe_requirements"]["f"]["skill"] = Value::Null;
    let unknown = report(&higher_de, &Default::default(), 101);
    assert_eq!(
        item(&unknown, 15)["routes"][1]["required_character_level"],
        Value::Null
    );
    let mut gated = v.clone();
    let fitting = &mut gated["snapshot"]["recipe_requirements"]["f"];
    fitting["pattern"] = json!("Plans: Fitting");
    fitting["pattern_character_level"] = json!(48);
    gated["snapshot"]["recipes"][0]["characters"] = json!([]);
    gated["snapshot"]["character_levels"] = json!({"Ada":35,"Bea":35});
    let gated_report = report(&gated, &Default::default(), 101);
    let paths = &item(&gated_report, 15)["routes"];
    assert_eq!(paths[0]["required_character_level"], 10);
    assert_eq!(paths[1]["required_character_level"], 48);
    assert_eq!(paths[1]["ready"], false);
    assert!(paths[1]["stages"][0]["advice"]
        .as_str()
        .unwrap()
        .contains("reach character level 48"));
    assert!(r["scan_queue"].as_array().unwrap().contains(&json!(10)));
    v["snapshot"]["professions"]["Bea"]["Enchanting"] = 1.into();
    assert_eq!(
        item(&report(&v, &Default::default(), 101), 15)["routes"][1]["ready"],
        false
    );
    // Six ore are needed across the entire chain; a partial stack cannot finance it.
    v["targeted"][0]["prices"]["10"] = price(10, 1, 1, 100);
    v["targeted"][0]["listed_units"]["10"] = 1.into();
    for route in item(&report(&v, &Default::default(), 101), 15)["routes"]
        .as_array()
        .unwrap()
    {
        assert!(route["inputs"]
            .as_array()
            .unwrap()
            .iter()
            .all(|l| l["id"] != 10 || l["quantity"] == 1));
    }
}

#[test]
fn reversible_recipes_do_not_bootstrap_free_reagents() {
    let mut v = fixture();
    v["snapshot"]["recipes"] = json!([
        {"id":"a","name":"A","output":300,"quantity":2,"mats":[[301,1]]},
        {"id":"b","name":"B","output":301,"quantity":2,"mats":[[300,1]]},
        {"id":"end","name":"End","output":302,"quantity":1,"mats":[[300,1]]}
    ]);
    v["snapshot"]["items"]["302"] = json!({"vendor_sell":900});
    let r = report(&v, &Default::default(), 101);
    assert!(item(&r, 302)["routes"][0]["cost"].is_null());
    assert_eq!(item(&r, 302)["routes"].as_array().unwrap().len(), 1);
}

#[test]
fn bound_chain_cannot_require_three_primaries_on_one_character() {
    let mut v = fixture();
    v["snapshot"]["recipes"] = json!([
        {"id":"f","name":"Bound fitting","output":300,"quantity":1,"mats":[[1001,1]]},
        {"id":"g","name":"Bound gear","output":301,"quantity":1,"mats":[[300,1]]}
    ]);
    v["snapshot"]["items"]["300"] =
        json!({"name":"Bound fitting","binding":"Binds when picked up"});
    v["snapshot"]["items"]["301"] = json!({"name":"Bound gear","binding":"Binds when picked up","vendor_sell":100,"class":4,"quality":2,"level":12,"inventory_type":"INVTYPE_HEAD"});
    v["snapshot"]["recipe_requirements"] =
        json!({"f":{"profession":"Tailoring"},"g":{"profession":"Engineering"}});
    v["snapshot"]["disenchant"] =
        json!([{"class":4,"quality":2,"min_level":1,"max_level":20,"mats":{"30":1}}]);
    v["snapshot"]["estimate_prices"]["30"] = price(100, 1, 1, 99);
    v["snapshot"]["non_disenchantable"] = json!([]);
    let r = report(&v, &Default::default(), 101);
    let routes = item(&r, 301)["routes"].as_array().unwrap();
    assert!(routes
        .iter()
        .any(|r| r["kind"] == "craft" && r["stages"].is_array()));
    assert!(!routes
        .iter()
        .any(|r| r["kind"] == "craft_disenchant" && r["stages"].is_array()));
}

#[test]
fn repeat_rate_respects_cooldowns_and_handles_zero_time_and_unknown_prices() {
    let mut v = fixture();
    v["snapshot"]["recipe_requirements"] =
        json!({"buckle":{"cast_seconds":5,"cooldown_seconds":55}});
    let run = report(&v, &Default::default(), 101);
    let t = &item(&run, 2000)["routes"][0]["timing"];
    assert_eq!(t["active_seconds"], 5.0);
    assert_eq!(t["elapsed_seconds"], 5.0);
    assert_eq!(t["repeat_seconds"], 60.0);
    assert!((t["gold_per_hour"].as_f64().unwrap() - 0.498).abs() < 1e-10);

    v["snapshot"]["recipe_requirements"]["buckle"] = json!({"cast_seconds":0});
    let run = report(&v, &Default::default(), 101);
    assert!(item(&run, 2000)["routes"][0]["timing"]["gold_per_hour"].is_null());

    v["snapshot"]["recipe_requirements"]["buckle"] = json!({"cast_seconds":5});
    v["snapshot"]["recipes"][0]["mats"] = json!([[98765, 1]]);
    let run = report(&v, &Default::default(), 101);
    let t = &item(&run, 2000)["routes"][0]["timing"];
    assert_eq!(t["elapsed_seconds"], 5.0);
    assert!(t["gold_per_hour"].is_null());
}

#[test]
fn uploaded_recipe_bounds_override_the_catalog_and_older_exports_keep_it() {
    use wow_auction_monitor::catalog::FOREVER;
    let mut player = scan::Snapshot::default();
    let dynamite = FOREVER
        .snapshot
        .recipes
        .iter()
        .find(|r| r.id == "3946")
        .unwrap()
        .clone();
    let mut old = dynamite;
    old.quantity_min = None;
    old.quantity_max = None;
    player.recipes.push(old);
    let check = |player: &scan::Snapshot| {
        let s = FOREVER.for_player(player);
        let r = s.recipes.iter().find(|r| r.id == "3946").unwrap();
        (
            r.quantity,
            r.quantity_min.unwrap_or(r.quantity),
            r.quantity_max.unwrap_or(r.quantity),
        )
    };
    assert_eq!(check(&player), (3, 1, 5));
    player.recipes[0].quantity_max = Some(3);
    assert_eq!(check(&player), (3, 3, 3));
    let classic_id = "Engineering/Heavy Dynamite";
    player.recipes[0].id = classic_id.into();
    player.recipes[0].quantity = 1;
    player.recipes[0].quantity_max = Some(4);
    player
        .recipe_requirements
        .insert(classic_id.into(), json!({"profession":"Engineering"}));
    assert_eq!(check(&player), (1, 1, 4));
}
