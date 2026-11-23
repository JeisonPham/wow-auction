-- Exercise the catalog, quote model and panel with the same add-on entry points as WoW.
local W={}
local function loadAddon(name) assert(loadfile("addon/WowAuctionSync/"..name..".lua"))("WowAuctionSync",W) end
loadAddon("Catalog")
loadAddon("Opportunities")
assert(#W.catalog.recipes==2051 and W.catalog.items[118].name)
local clock,open=1000,true
function time() return clock end
GetTime=time
function UnitFactionGroup() return "Alliance" end
local cat={items={
    [1]={name="Ore",trade=true},[2]={name="Ring",sell=5,trade=true,band=1},
    [3]={name="Dust",trade=true},[4]={name="Charm",sell=100,trade=true},
    [5]={name="Thread",buy=2},[6]={name="Bar",trade=true},[7]={name="Trinket",sell=60,trade=true},
},bands={{[3]=2}},recipes={
    {id="r",name="Ring",output=2,quantity=1,mats={{6,1}},profession="Jeweler",cast=2},
    {id="c",name="Charm",output=4,quantity=1,mats={{3,2},{5,1}},profession="Smith",cast=4},
    {id="b",name="Bar",output=6,quantity=1,mats={{1,2}},profession="Smelting",cast=3},
    {id="h",name="Horde only",output=4,quantity=1,mats={{1,1}},profession="Smith",faction="Horde"}
}}
local function lot(size,price,n) return {lots={[size]={[price]=n}}} end
local market,region="Normal-Alliance","Forever-US"
local full={region=region,capturedAt=990,complete=true,items={
    [1]=lot(2,8,5),[2]=lot(1,35,10),[3]=lot(1,30,100),[4]=lot(1,160,10),[6]=lot(1,10,4),[7]=lot(3,12,2)
}}
local profile={itemInfo={},characters={Ada={recipes={Smith={foo={id="c",name="Charm",output=4,mats={{3,2},{5,1}}}}}}}}
WowAuctionSyncDB={markets={[market]=full},targeted={}}
local function evaluate(batch)
    return W.evaluateOpportunities(cat,profile,WowAuctionSyncDB,region,market,batch or 1,clock,function() end)
end
local function find(model,key)
    for _,r in ipairs(model.rows) do if r.key==key then return r end end
end
local model=evaluate()
assert(find(model,"r/c/Craft → vendor").profit==38)
assert(find(model,"r/c/Craft → auction").profit==67)
local chain=find(model,"chain/c/Craft → vendor")
assert(chain.cost==10 and chain.profit==90 and #chain.steps==3 and chain.learned[1]=="Ada")
assert(chain.seconds==12 and math.abs(chain.hourly-2.7)<0.000001)
assert(find(model,"r/r/Craft → disenchant").proceeds==48)
assert(find(model,"i/2/Buy → disenchant").profit==13)
assert(find(model,"i/7/Buy → vendor").profit==48)
assert(not find(model,"r/h/Craft → vendor"))
assert(find(evaluate(2),"chain/c/Craft → vendor").profit==180)
local checked={complete=true,region=region,capturedAt=999,checked={[1]=true,[3]=true},checkedAt={[1]=991,[3]=998},items={[1]=lot(2,20,1)}}
WowAuctionSyncDB.targeted[market]=checked
assert(not find(evaluate(),"r/c/Craft → vendor").profit) -- Fresh checked-empty beats the full scan.
assert(find(evaluate(),"chain/r/Craft → vendor")==nil)
clock=1895
assert(not find(evaluate(),"r/b/Craft → vendor").cost) -- Ore's own check is stale.
checked.region="Forever-EU";clock=1000
assert(find(evaluate(),"r/c/Craft → vendor").profit==38)
checked.region=region
WowAuctionSyncDB.targeted={}
-- An unpriced legacy quote needs a search. A newer confirmed sellout does not.
W.catalog=cat
local coverage={markets={[market]={complete=true,region=region,capturedAt=990,items={
    [1]={quantity=4,totalBuyout=16},[2]=lot(1,35,10),[6]=lot(1,10,4)
}}},targeted={[market]={complete=true,region=region,capturedAt=999,checkedAt={[3]=998,[4]=989},
    checked={[3]=true,[4]=true},items={}}}}
local needed={}
for _,id in ipairs(W.missingOpportunityItems(profile,coverage,region,market,clock)) do
    assert(not needed[id]);needed[id]=true
end
assert(needed[1] and needed[4] and needed[5] and not needed[2] and not needed[3] and not needed[6])
-- Minimal UI mock, including edit boxes, route buttons, full refresh and follow lifecycle.
local widgets={}
local function noop() end
local function widget(kind,name)
    local o={scripts={},kind=kind,name=name,text="",shown=true}
    local methods={SetScript=function(self,k,f)self.scripts[k]=f end,
        GetText=function(self)return self.text end,
        SetText=function(self,t)self.text=t;if self.scripts.OnTextChanged then self.scripts.OnTextChanged(self) end end,
        CreateTexture=function()return widget("Texture")end,CreateFontString=function()return widget("FontString")end,
        Show=function(self)self.shown=true end,Hide=function(self)self.shown=false;if self.scripts.OnHide then self.scripts.OnHide(self)end end,
        IsShown=function(self)return self.shown end}
    setmetatable(o,{__index=function(_,k)return methods[k] or noop end})
    widgets[#widgets+1]=o
    return o
end
CreateFrame=function(kind,name) return widget(kind,name) end
local function lookup(field,value)
    for _,w in ipairs(widgets) do if rawget(w,field)==value then return w end end
    error("missing widget "..value)
end
local scans={}
W.catalog=cat
W.profile=function() return profile,region,market end
W.scope=function()return region,market end
W.auctionOpen=function()return open end
W.scanBusy=function()return false end
W.startScan=function(mode,ids)scans[#scans+1]={mode=mode,ids=ids};return true end
W.say=noop
loadAddon("OpportunityPanel")
W.openOpportunities()
-- The fresh full scan has lots for every AH item except thread. Opening the
-- panel queues that missing input independently of its visible page or filter.
assert(#scans==1 and scans[1].mode=="routes" and #scans[1].ids==1 and scans[1].ids[1]==5)
scans={}
local panel=lookup("name","WowAuctionSyncOpportunities")
local function paint() for i=1,20 do panel.scripts.OnUpdate(panel) end end
paint()
local picked
for _,w in ipairs(widgets) do
    if rawget(w,"route") and w.route.key=="chain/c/Craft → vendor" then picked=w;break end
end
assert(picked,"chained opportunity visible")
picked.scripts.OnClick(picked)
local shopping
for _,w in ipairs(widgets) do if w.text:find("Ore/exact/") then shopping=w end end
assert(shopping and shopping.text:find("Ore/exact/48c/x2",1,true))
local refresh=lookup("text","Recheck route");refresh.scripts.OnClick(refresh)
assert(scans[1].mode=="scan" and scans[1].ids[1]==1 and scans[1].ids[2]==5)
local pageButton=lookup("text","Recheck page");pageButton.scripts.OnClick()
local unique={}
for _,id in ipairs(scans[2].ids) do assert(not unique[id]);unique[id]=true end
assert(unique[1] and unique[4] and unique[5])
local follow=lookup("text","Follow: off");follow.scripts.OnClick(follow)
clock=1060;paint();assert(#scans==4)
panel:Hide();clock=1160;assert(follow.text=="Follow: off")
WowAuctionSyncDB.markets={};W.openOpportunities();assert(scans[5].mode=="full")
print("In-game direct and chained opportunities, quote age, stock, TSM ceilings, route rechecks and follow mode passed.")
