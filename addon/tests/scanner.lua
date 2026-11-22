-- Run from the source root with Lua 5.4 or pandoc-lua.
local W,scripts={},{}
local clock,ready,throttle,fullPage=100,false,true,false
function time() return clock end
GetTime=time
function GetCurrentRegion() return 1 end
function GetRealmName() return "Normal" end
function UnitFactionGroup() return "Alliance" end
function UnitName() return "Ada" end
function UnitLevel() return 30 end
function CreateFrame()
    return {SetScript=function(_,k,f)scripts[k]=f end,RegisterEvent=function()end}
end
Enum={GameRule={}}
C_Map={GetBestMapForUnit=function()return 84 end}
C_Item={GetItemInfo=function(id)return "Item "..id,nil,2,10,nil,nil,nil,20,"",nil,50,7 end}
SlashCmdList={}
local query,pages
C_AuctionHouse={
    GetNumReplicateItems=function()return 3 end,ReplicateItems=function()end,
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
local market="Normal-Alliance"
event("AUCTION_HOUSE_SHOW");cmd("full");event("REPLICATE_ITEM_LIST_UPDATE");tick()
assert(not WowAuctionSyncDB.markets[market]);ready=true;tick()
assert(WowAuctionSyncDB.markets[market].items[1001].totalBuyout==11)
WowAuctionSyncQueue={region="Forever-US",market=market,expiresAt=200,items={1001,1002,1003}}
cmd("scan");throttle=false;tick();assert(not query);throttle=true;tick()
assert(query.itemID==1001);event("COMMODITY_SEARCH_RESULTS_UPDATED",9999);tick()
assert(not pages);event("COMMODITY_SEARCH_RESULTS_UPDATED",1001);tick();tick()
assert(pages==1);fullPage=true;event("COMMODITY_SEARCH_RESULTS_UPDATED",1001);tick();tick()
assert(query.itemID==1002);event("COMMODITY_SEARCH_RESULTS_UPDATED",1002);tick();tick()
event("ITEM_SEARCH_RESULTS_UPDATED",query);tick()
local record=WowAuctionSyncDB.targeted[market]
assert(record.checked[1002] and not record.items[1002])
assert(record.items[1001].quantity==4 and record.items[1001].totalBuyout==20)
assert(record.items[1003].totalBuyout==15)
cmd("scan");tick();event("AUCTION_HOUSE_CLOSED");assert(WowAuctionSyncDB.targeted[market]==record)
event("AUCTION_HOUSE_SHOW");cmd("scan");tick();clock=250;tick()
assert(WowAuctionSyncDB.targeted[market]==record)
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
print("Scanner, pagination, expiry, cancellation and learned recipe checks passed.")

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
