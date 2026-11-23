local addonName, W = ...
local AH = C_AuctionHouse
local frame = CreateFrame("Frame")
local job, opened
local pendingInfo={}
local function say(text) print("|cffe4bf77WoW Auction Sync|r " .. text) end
W.say = say

local REPORT_INTERVAL = 10
local hideStatusAt, lastStatus
local bar = CreateFrame("StatusBar", nil, UIParent)
bar:SetSize(360, 40)
bar:SetPoint("TOP", UIParent, "TOP", 0, -76)
bar:SetFrameStrata("DIALOG")
bar:SetStatusBarTexture("Interface\\TargetingFrame\\UI-StatusBar")
local background = bar:CreateTexture(nil, "BACKGROUND")
background:SetAllPoints(bar)
background:SetColorTexture(0.04, 0.05, 0.06, 0.94)
local heading = bar:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
heading:SetPoint("TOP", bar, "TOP", 0, -5)
local detail = bar:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
detail:SetPoint("BOTTOM", bar, "BOTTOM", 0, 5)
bar:Hide()

local phases = {
    replicate = "Waiting for the auction house to send listings",
    fullRows = "Reading auction listings",
    search = "Waiting to send search",
    waiting = "Waiting for auction results",
    results = "Reading search results",
    page = "Waiting to request more results",
}
local function showStatus(now, outcome, complete)
    local full = job.mode == "full"
    local title = full and "Full scan" or (job.mode=="routes" and "Checking route prices" or "Targeted scan")
    local done, total
    if full then
        done, total = job.row or 0, job.rows
    else
        done, total = job.index - 1, #job.ids
    end
    if total then
        title = title .. (" · %d/%d %s"):format(done, total, full and "listings" or "items")
        if job.skipped and job.skipped>0 then title=title..(" · %d skipped"):format(job.skipped) end
    end
    local elapsed = math.floor(now - job.started)
    title = title .. (" · %d:%02d"):format(math.floor(elapsed / 60), elapsed % 60)
    local message = outcome or job.waitReason or phases[job.phase]
    if not outcome and not full then
        message = message .. " · item #" .. job.ids[job.index]
    end
    local maximum = math.max(total or 0, 1)
    bar:SetMinMaxValues(0, maximum)
    bar:SetValue(complete and maximum or done)
    if complete then bar:SetStatusBarColor(0.12, 0.48, 0.24)
    elseif outcome then bar:SetStatusBarColor(0.55, 0.25, 0.09)
    else bar:SetStatusBarColor(0.12, 0.36, 0.48) end
    heading:SetText(title)
    detail:SetText(message)
    bar:Show()
    return title .. " · " .. message
end
local function rule(name)
    local id = Enum.GameRule and Enum.GameRule[name .. "Ruleset"]
    return id and C_GameRules and C_GameRules.IsGameRuleActive(id)
end
function W.scope()
    local region = (GetCurrentRegionName and GetCurrentRegionName()) or
        ({[1]="US",[2]="KR",[3]="EU",[4]="TW",[5]="CN"})[GetCurrentRegion()]
    local faction = UnitFactionGroup("player")
    if not region or (faction ~= "Alliance" and faction ~= "Horde") then return end
    local ruleset
    if C_GameRules and C_GameRules.IsGameRuleActive and Enum and Enum.GameRule and Enum.GameRule.PvPRuleset then
        if rule("Hardcore") then ruleset="Hardcore"
        elseif rule("RP") then ruleset=rule("PvP") and "Roleplay PvP" or "Roleplay"
        elseif rule("PvP") then ruleset="PvP" else ruleset="Normal" end
    else
        local name=GetRealmName()
        ruleset=({PvE="Normal",Normal="Normal",PvP="PvP",Roleplay="Roleplay",["Roleplay PvP"]="Roleplay PvP",Hardcore="Hardcore"})[name]
    end
    if ruleset then return "Forever-"..region:upper(), ruleset.."-"..faction end
end
local function database()
    if WowAuctionSyncDB == nil then WowAuctionSyncDB = {} end
    local db = WowAuctionSyncDB
    if type(db) ~= "table" then return end
    if not next(db) then db.version = 1 end
    if db.version ~= 1 then return end
    db.markets = db.markets or {}
    db.targeted = db.targeted or {}
    db.profiles = db.profiles or {}
    return db
end
function W.profile()
    local db = database()
    if not db then return nil, nil, nil, "Unrecognized WoW Auction Sync saved database version." end
    local region,market=W.scope()
    if not region then return nil, nil, nil, "Cannot identify this character's Forever region, ruleset or faction." end
    local key=region.."/"..market
    db.profiles[key]=db.profiles[key] or {characters={},itemInfo={}}
    return db.profiles[key],region,market
end
function W.cache(id)
    local profile=W.profile()
    if not profile then return end
    local get=(C_Item and C_Item.GetItemInfo) or GetItemInfo
    local name,_,quality,level,_,_,_,stack,equip,_,sell,class,_,bind=get(id)
    if name then pendingInfo[id]=nil;profile.itemInfo[id]={name=name,quality=quality,level=level,max_stack=stack,inventory_type=equip,vendor_sell=sell,class=class,
        binding=({[0]="Unbound","Binds when picked up","Binds when equipped","Binds when used","Quest item"})[bind]}
    elseif C_Item and C_Item.RequestLoadItemDataByID and not pendingInfo[id] then pendingInfo[id]=true;C_Item.RequestLoadItemDataByID(id) end
end
local cities={Alliance={[84]=true,[87]=true,[89]=true,[1453]=true,[1455]=true,[1457]=true},
    Horde={[85]=true,[88]=true,[90]=true,[1454]=true,[1456]=true,[1458]=true}}
local function capital()
    local ids=cities[UnitFactionGroup("player")]
    local id=C_Map.GetBestMapForUnit("player")
    while ids and id and id>0 do
        if ids[id] then return true end
        local info=C_Map.GetMapInfo(id)
        if not info or info.parentMapID==id then break end
        id=info.parentMapID
    end
end
local function base(link)
    local payload=link and link:match("item:([^|]+)")
    if not payload then return false end
    local fields={}
    for field in (payload..":"):gmatch("(.-):") do fields[#fields+1]=tonumber(field) or 0 end
    for _,n in ipairs({2,3,4,5,6,7,13}) do if (fields[n] or 0)~=0 then return false end end
    return true
end
local function add(items,id,qty,total,unitPrice)
    if not total or total<=0 then return end
    local r=items[id] or {quantity=0,totalBuyout=0,auctions=0,lots={}}
    r.quantity=r.quantity+qty; r.totalBuyout=r.totalBuyout+total; r.auctions=r.auctions+1
    -- Commodities can be bought individually. Classic stacks carry one total buyout.
    local size,price,count=qty,total,1
    if unitPrice then size,price,count=1,unitPrice,qty end
    local prices=r.lots[size] or {}
    prices[price]=(prices[price] or 0)+count
    r.lots[size]=prices
    items[id]=r
end
-- Apply only completed searches. Missing items in a completed search are real sellouts.
local function publishChecks()
    if not next(job.checkedAt) then return end
    local records = WowAuctionSyncDB.targeted
    local rec = records[job.market]
    if not rec or not rec.complete or rec.region~=job.region then
        rec={region=job.region,complete=true,capturedAt=job.scanTime,items={},checked={},checkedAt={}}
        records[job.market]=rec
    elseif not rec.checkedAt then
        rec.checkedAt={}
        for id in pairs(rec.checked) do rec.checkedAt[id]=rec.capturedAt end
    end
    for id,at in pairs(job.checkedAt) do
        if at >= (rec.checkedAt[id] or 0) then
            rec.items[id],rec.checked[id],rec.checkedAt[id]=job.items[id],true,at
            rec.capturedAt=math.max(rec.capturedAt,at)
        end
    end
    job.items,job.checkedAt={},{}
    if W.quotesChanged then W.quotesChanged() end
end
local function stop(text, complete)
    if job.mode=="routes" then publishChecks() end
    local now = GetTime()
    lastStatus = showStatus(now, text, complete)
    job = nil
    hideStatusAt = now + REPORT_INTERVAL
    say(lastStatus)
end
function W.auctionOpen() return opened and capital() end
function W.scanBusy() return job ~= nil end
local function commit()
    publishChecks()
    stop("Scan complete. Type /reload to save.", true)
end
local function finishSnapshot(complete)
    local db=WowAuctionSyncDB
    if complete then
        db.markets[job.market]={region=job.region,capturedAt=job.scanTime,items=job.items,complete=true}
        if W.quotesChanged then W.quotesChanged() end
    end
    local ids=W.missingOpportunityItems(job.profile,db,job.region,job.market,time())
    local message=complete and "Bulk listings read." or "Bulk snapshot timed out. Previous full scan retained."
    if #ids>0 then
        stop(message.." Starting individual route checks.",complete)
        W.startScan("routes",ids)
    else
        stop(message.." Scan complete. Type /reload to save.",complete)
    end
end
local function advance()
    job.waitReason=nil
    job.morePages=false
    job.index=job.index+1; job.phase="search";job.deadline=GetTime()+90
    if not job.ids[job.index] then commit() end
end
local function readFull()
    job.waitReason=nil
    local finish=math.min(job.row+250,job.rows)
    while job.row<finish do
        local _,_,qty,_,_,_,_,_,_,buy,_,_,_,_,_,_,id,ready=AH.GetReplicateItemInfo(job.row)
        if not id or not qty or qty<=0 or ((not buy or buy<=0) and ready==false) then
            job.waitReason="Waiting for listing data"
            if id then W.cache(id) end
            return
        end
        if buy and buy>0 then
            local link=AH.GetReplicateItemLink(job.row)
            if not link then
                job.waitReason="Waiting for listing data"
                W.cache(id)
                return
            end
            if base(link) then
                if not job.items[id] then W.cache(id) end
                add(job.items,id,qty,buy)
            end
        end
        job.row=job.row+1;job.deadline=GetTime()+90
    end
    if job.row==job.rows then finishSnapshot(true) end
end
local function sameKey(a,b)
    return type(a)=="table" and b and a.itemID==b.itemID and (a.itemSuffix or 0)==(b.itemSuffix or 0)
        and (a.itemLevel or 0)==(b.itemLevel or 0) and (a.battlePetSpeciesID or 0)==(b.battlePetSpeciesID or 0)
end
local function targetResults()
    local id=job.ids[job.index];local commodity=job.commodity
    local key=commodity and id or job.key
    local complete=commodity and AH.HasFullCommoditySearchResults or AH.HasFullItemSearchResults
    if not complete(key) then job.phase="page";return end
    local count=commodity and AH.GetNumCommoditySearchResults or AH.GetNumItemSearchResults
    local get=commodity and AH.GetCommoditySearchResultInfo or AH.GetItemSearchResultInfo
    local rows,seen={},{}
    for n=1,count(key) do
        local row=get(key,n)
        if not row or not row.quantity then return end
        if not row.auctionID or not seen[row.auctionID] then
            if row.auctionID then seen[row.auctionID]=true end
            if commodity then
                if row.itemID and row.itemID~=id then return end
                if not row.unitPrice then return end
                add(rows,id,row.quantity,row.unitPrice*row.quantity,row.unitPrice)
            elseif row.buyoutAmount and row.buyoutAmount>0 then
                if not row.itemLink then return end
                if base(row.itemLink) then add(rows,id,row.quantity,row.buyoutAmount) end
            end
        end
    end
    job.items[id]=rows[id];job.checkedAt[id]=job.queryAt;W.cache(id);advance()
end
local function stepScan()
    if job.phase=="fullRows" then readFull()
    elseif job.phase=="results" then targetResults()
    elseif job.phase=="search" and AH.IsThrottledMessageSystemReady() then
        local id=job.ids[job.index]
        local get=(C_Item and C_Item.GetItemInfo) or GetItemInfo
        local name,_,_,level,_,_,_,_,equip,_,_,class=get(id)
        if not name then
            job.waitReason="Loading item information"
            W.cache(id)
            return
        end
        job.waitReason=nil
        local gear=(class==2 or class==4) and equip and equip~=""
        local key=AH.MakeItemKey(id,gear and level or 0,0,0)
        job.key=key;job.queryAt=time();job.phase="waiting";AH.SendSearchQuery(key,{},false)
    elseif job.phase=="page" and AH.IsThrottledMessageSystemReady() then
        job.phase="waiting";job.morePages=true
        local complete
        if job.commodity then complete=AH.RequestMoreCommoditySearchResults(job.ids[job.index])
        else complete=AH.RequestMoreItemSearchResults(job.key) end
        if complete then job.phase="results" end
    end
end
frame:SetScript("OnUpdate",function()
    if not job then
        if hideStatusAt and GetTime() >= hideStatusAt then
            bar:Hide()
            hideStatusAt=nil
        end
        return
    end
    local now = GetTime()
    if job.expires and time()>job.expires then stop("Queue expired. Scan discarded.");return end
    if now>job.deadline then
        if job.mode=="full" then finishSnapshot(false)
        elseif job.mode=="routes" then
            job.skipped=job.skipped+1
            advance()
        else stop("Scan timed out. Previous observations retained.") end
        return
    end
    stepScan()
    if job and (now >= job.nextRefresh or now >= job.nextReport) then
        local text = showStatus(now)
        job.nextRefresh = now + 1
        if now >= job.nextReport then
            if job.mode=="routes" then publishChecks() end
            say(text)
            job.nextReport = now + REPORT_INTERVAL
        end
    end
end)
frame:SetScript("OnEvent",function(_,event,arg,success)
    if event=="ADDON_LOADED" and arg==addonName then database()
    elseif event=="GET_ITEM_INFO_RECEIVED" and pendingInfo[arg] then
        if success==false then
            pendingInfo[arg]=nil
            if job and job.mode=="routes" and job.phase=="search" and job.ids[job.index]==arg then
                job.skipped=job.skipped+1
                advance()
            end
        else W.cache(arg) end
    elseif event=="AUCTION_HOUSE_SHOW" then opened=true;if W.attachOpportunities then W.attachOpportunities() end
    elseif event=="AUCTION_HOUSE_CLOSED" then opened=false;if job then
        stop(job.mode=="routes" and "Window closed. Completed item checks kept." or "Window closed. Scan discarded.") end
        if W.stopFollowing then W.stopFollowing() end
    elseif job and job.mode=="full" and event=="REPLICATE_ITEM_LIST_UPDATE" and job.phase=="replicate" then
        job.row=0;job.rows=AH.GetNumReplicateItems();job.phase="fullRows";job.deadline=GetTime()+90
    elseif job and job.mode~="full" and job.phase=="waiting" then
        if (event=="COMMODITY_SEARCH_RESULTS_UPDATED" or (event=="COMMODITY_SEARCH_RESULTS_ADDED" and job.morePages))
            and arg==job.ids[job.index] then job.commodity=true;job.phase="results"
        elseif (event=="ITEM_SEARCH_RESULTS_UPDATED" and sameKey(arg,job.key)) or
            (event=="ITEM_SEARCH_RESULTS_ADDED" and job.morePages and not job.commodity and
            (sameKey(arg,job.key) or arg==job.ids[job.index])) then job.commodity=false;job.phase="results" end
    end
end)
for _,event in ipairs({"ADDON_LOADED","GET_ITEM_INFO_RECEIVED","AUCTION_HOUSE_SHOW","AUCTION_HOUSE_CLOSED",
    "REPLICATE_ITEM_LIST_UPDATE","COMMODITY_SEARCH_RESULTS_UPDATED","ITEM_SEARCH_RESULTS_UPDATED",
    "COMMODITY_SEARCH_RESULTS_ADDED","ITEM_SEARCH_RESULTS_ADDED"}) do frame:RegisterEvent(event) end
function W.startScan(mode, ids)
    local profile,region,market,problem=W.profile()
    if problem then say(problem);return false end
    if mode=="scan" and ids and #ids>0 and job and job.phase=="replicate" then
        stop("Switching from the pending full snapshot to the requested item checks.")
    end
    if mode=="scan" and ids and #ids>0 and job and job.mode=="routes" then
        local ordered,seen={},{}
        for i=1,job.index do ordered[i]=job.ids[i] end
        seen[job.ids[job.index]]=true
        local function queue(id)
            if not seen[id] then ordered[#ordered+1]=id;seen[id]=true end
        end
        for _,id in ipairs(ids) do queue(id) end
        for i=job.index+1,#job.ids do queue(job.ids[i]) end
        job.ids=ordered
        say("Prioritized those items in the running route checks.")
        return true
    end
    if job then say(showStatus(GetTime()));return false end
    if not profile or not W.auctionOpen() then
        say("Open your faction capital auction house to scan.");return false
    end
    local expires
    if mode=="scan" and not ids then
        local queue=WowAuctionSyncQueue
        if not queue or queue.region~=region or queue.market~=market or queue.expiresAt<time() or #queue.items==0 then
            say("No current queue for this market.");return false
        end
        ids,expires=queue.items,queue.expiresAt
    end
    if mode=="scan" and #ids==0 then say("This route has no auction items to recheck.");return false end
    local now=GetTime()
    job={region=region,market=market,profile=profile,mode=mode,items={},checkedAt={},deadline=now+90,
        skipped=mode=="routes" and 0 or nil,
        started=now,scanTime=time(),nextRefresh=now+1,nextReport=now+REPORT_INTERVAL}
    hideStatusAt=nil
    if mode=="full" then job.phase="replicate"
    else job.ids=ids;job.expires=expires;job.index=0;advance() end
    say(showStatus(now))
    if mode=="full" then AH.ReplicateItems() end
    return true
end
SLASH_WOWAUCTIONSYNC1="/wamsync"
if not (C_AddOns and C_AddOns.IsAddOnLoaded("WowAuctionMonitor")) then SLASH_WOWAUCTIONSYNC2="/wam" end
SlashCmdList.WOWAUCTIONSYNC=function(cmd)
    cmd=cmd:lower():match("^%s*(.-)%s*$")
    local profile,region,market,problem=W.profile()
    if problem and cmd~="cancel" then say(problem);return end
    if cmd=="opportunities" then W.openOpportunities();return end
    if cmd=="status" then
        local state=job and showStatus(GetTime()) or (lastStatus and "Idle · Last scan · "..lastStatus or "Idle")
        say((region or "?").." / "..(market or "?").." · "..state);return
    end
    if cmd=="cancel" then
        if W.stopFollowing then W.stopFollowing() end
        if job then stop(job.mode=="routes" and "Cancelled. Completed item checks kept." or "Cancelled. Scan discarded.")
        else say("No scan is running.") end
        return
    end
    if cmd=="roster" then if profile then W.roster(profile,true) end;return end
    if cmd=="recipes" then if profile then W.recipes(profile) end;return end
    if cmd~="scan" and cmd~="full" then say("/wamsync opportunities | full | scan | recipes | roster | status | cancel");return end
    W.startScan(cmd)
end

