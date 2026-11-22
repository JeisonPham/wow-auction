-- Run from the source root with Lua 5.4 or pandoc-lua.
local W,scripts={},{}
local clock,ready,throttle,fullPage=100,false,true,false
local chat,bar,rows={},nil,3
local output=print
function print(text) chat[#chat+1]=text end
function time() return clock end
GetTime=time
function GetCurrentRegion() return 1 end
function GetRealmName() return "Normal" end
function UnitFactionGroup() return "Alliance" end
function UnitName() return "Ada" end
function UnitLevel() return 30 end
local function noop() end
function CreateFrame(kind)
    if kind=="Frame" then return {SetScript=function(_,k,f)scripts[k]=f end,RegisterEvent=noop} end
    assert(kind=="StatusBar")
    bar={labels={},SetSize=noop,SetPoint=noop,SetFrameStrata=noop,SetStatusBarTexture=noop,SetStatusBarColor=noop,
        CreateTexture=function() return {SetColorTexture=noop,SetAllPoints=noop} end,
        CreateFontString=function(self)
            local label={SetPoint=noop,SetText=function(s,text)s.text=text end}
            table.insert(self.labels,label)
            return label
        end,
        SetMinMaxValues=function(self,lo,hi)self.maximum=hi;assert(lo==0 and hi>0)end,
        SetValue=function(self,value)self.value=value;assert(value>=0 and value<=self.maximum)end,
        Show=function(self)self.shown=true end,Hide=function(self)self.shown=false end}
    return bar
end
Enum={GameRule={}}
C_Map={GetBestMapForUnit=function()return 84 end}
C_Item={GetItemInfo=function(id)return "Item "..id,nil,2,10,nil,nil,nil,20,"",nil,50,7 end}
SlashCmdList={}
local query,pages
C_AuctionHouse={
    GetNumReplicateItems=function()return rows end,ReplicateItems=function()end,
    GetReplicateItemInfo=function(n)
        return "Ore",nil,2,nil,nil,nil,nil,nil,nil,n==1 and 0 or 11,nil,nil,nil,nil,nil,nil,1001,ready
    end,
    GetReplicateItemLink=function(n)return n==2 and "item:1001:0:0:0:0:0:12" or "item:1001" end,
    MakeItemKey=function(id,level)return {itemID=id,itemLevel=level} end,
    IsThrottledMessageSystemReady=function()return throttle end,
    SendSearchQuery=function(key)query=key end,
    HasFullCommoditySearchResults=function()return fullPage end,
    RequestMoreCommoditySearchResults=function()pages=(pages or 0)+1 end,
    GetNumCommoditySearchResults=function(id)return id==1002 and 0 or 3 end,
    GetCommoditySearchResultInfo=function(_,n)return {auctionID=n==3 and 1 or n,quantity=2,unitPrice=5} end,
    HasFullItemSearchResults=function()return true end,
    GetNumItemSearchResults=function()return 1 end,
    GetItemSearchResultInfo=function()return {auctionID=9,quantity=2,buyoutAmount=15,itemLink="item:1003"} end,
}
assert(loadfile("addon/WowAuctionSync/Scanner.lua"))("WowAuctionSync",W)
assert(loadfile("addon/WowAuctionSync/Recipes.lua"))("WowAuctionSync",W)
local cmd=SlashCmdList.WOWAUCTIONSYNC
local function event(e,arg)scripts.OnEvent(nil,e,arg)end
local function tick()scripts.OnUpdate()end
local function elapse(seconds)clock=clock+seconds;tick()end
local function lastSays(text)assert(chat[#chat]:find(text,1,true),chat[#chat])end
local market="Normal-Alliance"
event("ADDON_LOADED","Unrelated");assert(not WowAuctionSyncDB)
event("ADDON_LOADED","WowAuctionSync")
assert(WowAuctionSyncDB.version==1 and WowAuctionSyncDB.profiles and WowAuctionSyncDB.targeted and not bar.shown)
local faction=UnitFactionGroup
UnitFactionGroup=function()return nil end
cmd("roster");lastSays("Cannot identify")
UnitFactionGroup=faction
local db=WowAuctionSyncDB
event("AUCTION_HOUSE_SHOW");cmd("full")
assert(bar.shown and bar.value==0 and not bar.labels[1].text:find("/"))
lastSays("Waiting for the auction house")
local messages=#chat
elapse(9);tick();assert(#chat==messages)
elapse(1);tick();assert(#chat==messages+1);lastSays("Full scan · 0:10")
event("REPLICATE_ITEM_LIST_UPDATE");elapse(10)
assert(#chat==messages+2);lastSays("0/3 listings · 0:20");lastSays("Waiting for listing data")
cmd("status");lastSays("Normal-Alliance");lastSays("0/3 listings")
assert(not WowAuctionSyncDB.markets[market]);ready=true;tick()
assert(bar.value==3 and bar.maximum==3);lastSays("Scan complete. Type /reload")
assert(WowAuctionSyncDB.markets[market].items[1001].totalBuyout==11)
event("ADDON_LOADED","WowAuctionSync");assert(WowAuctionSyncDB==db and db.markets[market])
messages=#chat;elapse(10);assert(not bar.shown and #chat==messages)
WowAuctionSyncQueue={region="Forever-US",market=market,expiresAt=200,items={1001,1002,1003}}
cmd("scan");throttle=false;elapse(10);assert(not query);lastSays("0/3 items · 0:10");lastSays("item #1001")
throttle=true;tick()
assert(query.itemID==1001);event("COMMODITY_SEARCH_RESULTS_UPDATED",9999);tick()
assert(not pages);event("COMMODITY_SEARCH_RESULTS_UPDATED",1001);tick();tick()
assert(pages==1);fullPage=true;event("COMMODITY_SEARCH_RESULTS_UPDATED",1001);tick();tick()
assert(query.itemID==1002);elapse(10);lastSays("1/3 items · 0:20");lastSays("Waiting for auction results · item #1002")
event("COMMODITY_SEARCH_RESULTS_UPDATED",1002);tick();tick()
event("ITEM_SEARCH_RESULTS_UPDATED",query);tick()
local record=WowAuctionSyncDB.targeted[market]
assert(record.checked[1002] and not record.items[1002])
assert(record.items[1001].quantity==4 and record.items[1001].totalBuyout==20)
assert(record.items[1003].totalBuyout==15)
lastSays("3/3 items");assert(bar.value==3 and bar.maximum==3)
cmd("scan");tick();event("AUCTION_HOUSE_CLOSED");assert(WowAuctionSyncDB.targeted[market]==record)
lastSays("Window closed")
event("AUCTION_HOUSE_SHOW");cmd("scan");tick();clock=250;tick()
assert(WowAuctionSyncDB.targeted[market]==record)
lastSays("Queue expired")
cmd("full");elapse(91);lastSays("Scan timed out")
local previous=db.markets[market]
rows=501;cmd("full");event("REPLICATE_ITEM_LIST_UPDATE");elapse(10)
lastSays("250/501 listings");assert(bar.value==250 and bar.maximum==501)
cmd("cancel");lastSays("Cancelled.");assert(db.markets[market]==previous)
messages=#chat;elapse(22);assert(#chat==messages and not bar.shown)
cmd("status");lastSays("Idle");lastSays("Cancelled.")
rows=0;cmd("full");event("REPLICATE_ITEM_LIST_UPDATE");elapse(10)
lastSays("0/0 listings");lastSays("Scan complete");assert(bar.value==bar.maximum)
C_TradeSkillUI={
 GetBaseProfessionInfo=function()return {professionName="Blacksmithing",skillLevel=80}end,
 GetAllRecipeIDs=function()return {7,8}end,
 GetRecipeInfo=function()return {learned=true,name="Buckle"}end,
 GetRecipeSchematic=function(id)return {outputItemID=2000,quantityMin=1,quantityMax=5,reagentSlotSchematics={
 {required=true,quantityRequired=1,reagents={{itemID=1001}}},
 {required=true,quantityRequired=2,reagents=id==7 and {{itemID=1001}} or {{itemID=1},{itemID=2}}},
 {required=false,quantityRequired=1,reagents={{itemID=1003}}}}}end
}
cmd("recipes")
local char=WowAuctionSyncDB.profiles["Forever-US/"..market].characters.Ada
assert(char.professions.Blacksmithing==80 and char.recipes.Blacksmithing["7"].mats[1][2]==3)
assert(char.recipes.Blacksmithing["7"].quantity_max==5)
assert(not char.recipes.Blacksmithing["8"])

GetProfessions=function()return 1,nil,nil,nil,3 end
GetProfessionInfo=function(n)
    if n==1 then return "Blacksmithing",nil,90,nil,nil,nil,164 end
    return "Cooking",nil,20,nil,nil,nil,185
end
cmd("roster");assert(char.completeRoster and char.professions.Blacksmithing==90 and char.professions.Cooking==20)
GetProfessions=function()end
cmd("roster");assert(char.completeRoster and not next(char.professions) and not char.recipes.Blacksmithing)
GetProfessions=nil
GetNumSkillLines=function()return 2 end
GetSkillLineInfo=function(n)if n==1 then return "Professions",1,1 end return "Mining",nil,nil,88 end
cmd("roster");assert(char.completeRoster and char.professions.Mining==88)
GetSkillLineInfo=function()return "Professions",1,nil end
cmd("roster");assert(not char.completeRoster and char.professions.Mining==88)
output("SavedVariables initialization, scan status, 10-second reporting, pagination, expiry, cancellation and learned recipe checks passed.")
