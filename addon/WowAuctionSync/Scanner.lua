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
    local title = full and "Full scan" or "Targeted scan"
    local done, total
    if full then
        done, total = job.row or 0, job.rows
    else
        done, total = job.index - 1, #job.ids
    end
    if total then
        title = title .. (" · %d/%d %s"):format(done, total, full and "listings" or "items")
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
local function add(items,id,qty,total)
    if not total or total<=0 then return end
    local r=items[id] or {quantity=0,totalBuyout=0,auctions=0}
    r.quantity=r.quantity+qty; r.totalBuyout=r.totalBuyout+total; r.auctions=r.auctions+1
    items[id]=r
end
local function stop(text, complete)
    local now = GetTime()
    lastStatus = showStatus(now, text, complete)
    job = nil
    hideStatusAt = now + REPORT_INTERVAL
    say(lastStatus)
end
local function commit()
    local db=WowAuctionSyncDB
    local rec={region=job.region,capturedAt=time(),items=job.items,complete=true}
    if job.mode=="full" then db.markets[job.market]=rec
    else rec.checked=job.checked; db.targeted[job.market]=rec end
    stop("Scan complete. Type /reload to save.", true)
end
local function advance()
    job.waitReason=nil
    job.index=job.index+1; job.phase="search";job.deadline=GetTime()+90
    if not job.ids[job.index] then commit() end
end
local function readFull()
    job.waitReason=nil
    local finish=math.min(job.row+250,job.rows)
    while job.row<finish do
        local name,_,qty,_,_,_,_,_,_,buy,_,_,_,_,_,_,id,ready=AH.GetReplicateItemInfo(job.row)
        if not id or ready==false or not qty or not name then
            job.waitReason="Waiting for listing data"
            return
        end
        if buy and buy>0 then
            local link=AH.GetReplicateItemLink(job.row)
            if not link then
                job.waitReason="Waiting for listing data"
                W.cache(id)
                return
            end
            if base(link) then add(job.items,id,qty,buy);W.cache(id) end
        end
        job.row=job.row+1;job.deadline=GetTime()+90
    end
    if job.row==job.rows then commit() end
end
local function sameKey(a,b)
    return a and b and a.itemID==b.itemID and (a.itemSuffix or 0)==(b.itemSuffix or 0)
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
                add(rows,id,row.quantity,row.unitPrice*row.quantity)
            elseif row.buyoutAmount and row.buyoutAmount>0 then
                if not row.itemLink then return end
                if base(row.itemLink) then add(rows,id,row.quantity,row.buyoutAmount) end
            end
        end
    end
    job.items[id]=rows[id];job.checked[id]=true;W.cache(id);advance()
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
        job.key=key;job.phase="waiting";AH.SendSearchQuery(key,{},false)
    elseif job.phase=="page" and AH.IsThrottledMessageSystemReady() then
        job.phase="waiting"
        if job.commodity then AH.RequestMoreCommoditySearchResults(job.ids[job.index])
        else AH.RequestMoreItemSearchResults(job.key) end
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
    if now>job.deadline then stop("Scan timed out. Previous observations retained.");return end
    stepScan()
    if job and (now >= job.nextRefresh or now >= job.nextReport) then
        local text = showStatus(now)
        job.nextRefresh = now + 1
        if now >= job.nextReport then
            say(text)
            job.nextReport = now + REPORT_INTERVAL
        end
    end
end)
frame:SetScript("OnEvent",function(_,event,arg)
    if event=="ADDON_LOADED" and arg==addonName then database()
    elseif event=="GET_ITEM_INFO_RECEIVED" and pendingInfo[arg] then W.cache(arg)
    elseif event=="AUCTION_HOUSE_SHOW" then opened=true
    elseif event=="AUCTION_HOUSE_CLOSED" then opened=false;if job then stop("Window closed. Scan discarded.") end
    elseif job and job.mode=="full" and event=="REPLICATE_ITEM_LIST_UPDATE" and job.phase=="replicate" then
        job.row=0;job.rows=AH.GetNumReplicateItems();job.phase="fullRows"
    elseif job and job.mode=="scan" and job.phase=="waiting" then
        if event=="COMMODITY_SEARCH_RESULTS_UPDATED" and arg==job.ids[job.index] then job.commodity=true;job.phase="results"
        elseif event=="ITEM_SEARCH_RESULTS_UPDATED" and sameKey(arg,job.key) then job.commodity=false;job.phase="results" end
    end
end)
for _,event in ipairs({"ADDON_LOADED","GET_ITEM_INFO_RECEIVED","AUCTION_HOUSE_SHOW","AUCTION_HOUSE_CLOSED","REPLICATE_ITEM_LIST_UPDATE","COMMODITY_SEARCH_RESULTS_UPDATED","ITEM_SEARCH_RESULTS_UPDATED"}) do frame:RegisterEvent(event) end
SLASH_WOWAUCTIONSYNC1="/wamsync"
if not (C_AddOns and C_AddOns.IsAddOnLoaded("WowAuctionMonitor")) then SLASH_WOWAUCTIONSYNC2="/wam" end
SlashCmdList.WOWAUCTIONSYNC=function(cmd)
    cmd=cmd:lower():match("^%s*(.-)%s*$")
    local profile,region,market,problem=W.profile()
    if problem and cmd~="cancel" then say(problem);return end
    if cmd=="status" then
        local state=job and showStatus(GetTime()) or (lastStatus and "Idle · Last scan · "..lastStatus or "Idle")
        say((region or "?").." / "..(market or "?").." · "..state);return
    end
    if cmd=="cancel" then
        if job then stop("Cancelled. Scan discarded.") else say("No scan is running.") end
        return
    end
    if cmd=="roster" then if profile then W.roster(profile,true) end;return end
    if cmd=="recipes" then if profile then W.recipes(profile) end;return end
    if cmd~="scan" and cmd~="full" then say("/wamsync full | scan | recipes | roster | status | cancel");return end
    if job or not profile or not opened or not capital() then say("Open your faction capital auction house and finish any running scan.");return end
    local queue=WowAuctionSyncQueue
    if cmd=="scan" and (not queue or queue.region~=region or queue.market~=market or queue.expiresAt<time() or #queue.items==0) then say("No current queue for this market.");return end
    local now=GetTime()
    job={region=region,market=market,mode=cmd,items={},checked={},deadline=now+90,
        started=now,nextRefresh=now+1,nextReport=now+REPORT_INTERVAL}
    hideStatusAt=nil
    if cmd=="full" then job.phase="replicate"
    else job.ids=queue.items;job.expires=queue.expiresAt;job.index=0;advance() end
    say(showStatus(now))
    if cmd=="full" then AH.ReplicateItems() end
end

