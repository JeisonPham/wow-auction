local _, W = ...
local panel, hint, pageLabel, details, search, profitButton, followButton
local rowButtons, filtered = {}, {}
local batch, page, onlyProfit, minProfit = 1, 1, false, 1
local job, result, selectedKey, selected, following, nextCheck, lastTick
local PAGE = 8
local function copper(value)
    if not value then return "Unknown" end
    local n=math.floor(math.abs(value))
    return (value<0 and "-" or "")..(n>=10000 and math.floor(n/10000).."g " or "")..
        (n>=100 and math.floor(n/100)%100 .."s " or "")..(n%100).."c"
end
local function age(at)
    if not at or at==math.huge then return "vendor prices" end
    local seconds=math.max(0,time()-at)
    return math.floor(seconds/60).."m "..(seconds%60).."s old"
end
local function idsFor(row)
    local set,ids={},{}
    for id in pairs(row.raw) do
        if not result.meta(id).bound then set[id]=true end
    end
    for _,id in ipairs(row.saleIDs or {}) do set[id]=true end
    for id in pairs(set) do ids[#ids+1]=id end
    table.sort(ids)
    return ids
end
local function describe()
    if not selected then details:SetText("Select a route to see its purchases and production steps.");return end
    local r=selected
    local lines={r.name.."  ·  "..r.kind..(r.profession and "  ·  "..r.profession or ""),
        "Batch cost "..copper(r.cost).."   Proceeds "..copper(r.proceeds).."   Profit "..copper(r.profit)}
    if r.seconds then
        lines[#lines+1]=("Batch time %.1fs"):format(r.seconds)..(r.hourly and ("  ·  %.2f gold/hour on repeat"):format(r.hourly) or "")
    end
    if r.craft then
        lines[#lines+1]=(r.skill and ("Requires "..r.profession.." "..r.skill..". ") or "")..
            (r.learned and "Recipe recorded on "..table.concat(r.learned,", ") or "No learned copy recorded in this roster.")
    end
    local fixed,spent,orders=0,0,{}
    local ids={}
    for id in pairs(r.raw) do ids[#ids+1]=id end
    table.sort(ids)
    for _,id in ipairs(ids) do
        local n=r.raw[id]*batch
        local line=result.buy(id,n,r.craft)
        local name=result.meta(id).name
        if line and line.vendor then fixed=fixed+line.cost
        elseif line then
            spent=spent+line.cost
            orders[#orders+1]={name=name,line=line,id=id}
        end
        lines[#lines+1]=name.." × "..(line and line.qty or n).."  ·  "..(line and
            ((line.vendor and "Vendor " or "AH ")..copper(line.cost)) or "Fresh listings or sufficient stock needed")
    end
    for _,step in ipairs(r.steps) do lines[#lines+1]=step.runs*batch.." × "..step.name end
    if #r.steps>0 then lines[#lines+1]="Then "..r.kind..": "..r.name end
    if r.profit and spent>0 then
        local budget = r.proceeds-fixed-minProfit
        local caps, valid, totalUnits, needsFloor = {}, budget>0, 0, false
        for _,o in ipairs(orders) do
            totalUnits=totalUnits+o.line.qty
            if budget*(o.line.cost/spent)<o.line.qty then needsFloor=true end
        end
        local floor = needsFloor and totalUnits<=budget and 1 or 0
        local allocated=0
        for _,o in ipairs(orders) do
            local cap=floor+math.floor((budget-floor*totalUnits)*(o.line.cost/spent)/o.line.qty)
            local vendor=r.craft and result.meta(o.id).buy
            if vendor then cap=math.min(cap,vendor) end
            cap=math.min(cap,math.floor((budget-allocated)/o.line.qty))
            allocated=allocated+cap*o.line.qty
            if cap<1 then valid=false end
            caps[#caps+1]=o.name.." × "..o.line.qty.."  ·  max "..copper(cap).." each"
            if not o.name:find("[/;^\r\n]") then
                caps[#caps+1]=o.name.."/exact/"..copper(cap):gsub(" ","").."/x"..o.line.qty
            end
        end
        if valid then
            lines[#lines+1]="TSM Shopping · select and copy one search. Check the final stack quantity."
            for _,line in ipairs(caps) do lines[#lines+1]=line end
        else lines[#lines+1]="The batch cannot fund every buy ceiling at this target." end
    end
    lines[#lines+1]="Auction exits use the lowest ask less 5% cut and 15% reserve. Craft quantities and disenchant returns are projections."
    details:SetText(table.concat(lines,"\n"))
    details:SetCursorPosition(0)
end
local function repaint()
    if not result then return end
    filtered={}
    local query=search:GetText():lower()
    selected=nil
    for _,r in ipairs(result.rows) do
        local text=r.name.." "..r.item.." "..r.kind.." "..(r.profession or "")..(#r.steps>0 and " chained" or "")
        if following and r.key==selectedKey then selected=r end
        if (not onlyProfit or (r.profit and r.profit>0)) and text:lower():find(query,1,true) then
            filtered[#filtered+1]=r
            if r.key==selectedKey then selected=r end
        end
    end
    if not selected and not following then selectedKey=nil end
    local pages=math.max(1,math.ceil(#filtered/PAGE))
    page=math.max(1,math.min(page,pages))
    pageLabel:SetText(("%d / %d   ·   %d routes"):format(page,pages,#filtered))
    for n,button in ipairs(rowButtons) do
        local r=filtered[(page-1)*PAGE+n]
        button.route=r
        if r then
            button:SetText((r==selected and "> " or "")..r.name.."  ·  "..(#r.steps>0 and "Chained · " or "")..r.kind.."  ·  "..copper(r.profit))
            button:Show()
        else button:Hide() end
    end
    describe()
end
local function rebuild()
    if not panel or not panel:IsShown() then return end
    local profile,region,market=W.profile()
    if not profile then return end
    result,selected=nil,nil
    for _,b in ipairs(rowButtons) do b.route=nil;b:Hide() end
    details:SetText("");pageLabel:SetText("")
    hint:SetText("Pricing routes from your in-game scans…")
    job=coroutine.create(function()
        local count=0
        local function pulse()
            count=count+1
            if count%25==0 then coroutine.yield() end
        end
        return W.evaluateOpportunities(W.catalog,profile,WowAuctionSyncDB,region,market,batch,time(),pulse)
    end)
end
W.quotesChanged=rebuild
function W.stopFollowing()
    following=false
    if followButton then followButton:SetText("Follow: off") end
end
local function recheck()
    if not selected or not result then W.say("Select a route first.");return false end
    return W.startScan("scan",idsFor(selected))
end
local function tick()
    if job then
        local start=debugprofilestop and debugprofilestop()
        for n=1,8 do
            local ok,value=coroutine.resume(job)
            if not ok then job=nil;hint:SetText("Pricing failed: "..tostring(value));return end
            if coroutine.status(job)=="dead" then
                result,job=value,nil
                repaint()
                break
            end
            if start and debugprofilestop()-start>=4 then break end
        end
    end
    if not result or lastTick==time() then return end
    lastTick=time()
    if result and time()>=result.expiry then rebuild();return end
    if result then
        local text="Current listings · maximum age 15m"
        if result.fullAt then text="Full scan "..age(result.fullAt).."  ·  price limit 15m" end
        if W.scanBusy() then text="Scanning auctions…" end
        if selected then
            text=text..(selected.profit and "  ·  "..age(selected.at) or "  ·  Missing current price or stock")
        end
        hint:SetText(text)
    end
    if following and not W.scanBusy() and GetTime()>=nextCheck then
        nextCheck=GetTime()+60
        if not W.startScan("scan",following) then W.stopFollowing() end
    end
end
local function button(parent,text,x,y,width,onClick)
    local b=CreateFrame("Button",nil,parent,"UIPanelButtonTemplate")
    b:SetPoint("TOPLEFT",parent,"TOPLEFT",x,y);b:SetSize(width,22);b:SetText(text)
    b:SetScript("OnClick",onClick)
    return b
end
local function label(parent,text,x,y,font)
    local f=parent:CreateFontString(nil,"OVERLAY",font or "GameFontHighlightSmall")
    f:SetPoint("TOPLEFT",parent,"TOPLEFT",x,y);f:SetText(text)
    return f
end
local function edit(parent,x,y,width,initial,numeric)
    local e=CreateFrame("EditBox",nil,parent,"InputBoxTemplate")
    e:SetPoint("TOPLEFT",parent,"TOPLEFT",x,y);e:SetSize(width,22);e:SetAutoFocus(false)
    if numeric then e:SetNumeric(true) end
    e:SetText(initial);e:SetScript("OnEscapePressed",function(self) self:ClearFocus() end)
    return e
end
local function build()
    panel=CreateFrame("Frame","WowAuctionSyncOpportunities",UIParent)
    panel:SetSize(580,478);panel:SetPoint("CENTER");panel:SetFrameStrata("DIALOG")
    panel:EnableMouse(true);panel:SetMovable(true);panel:SetClampedToScreen(true)
    panel:RegisterForDrag("LeftButton");panel:SetScript("OnDragStart",panel.StartMoving)
    panel:SetScript("OnDragStop",panel.StopMovingOrSizing)
    local bg=panel:CreateTexture(nil,"BACKGROUND");bg:SetAllPoints();bg:SetColorTexture(.045,.065,.09,.97)
    label(panel,"Auction opportunities",14,-12,"GameFontNormalLarge")
    button(panel,"Close",510,-7,56,function() panel:Hide() end)
    hint=label(panel,"",14,-39)
    button(panel,"Scan all",14,-60,76,function() W.startScan("full") end)
    button(panel,"Recheck route",96,-60,106,recheck)
    followButton=button(panel,"Follow: off",210,-60,92,function()
        if following then W.stopFollowing()
        elseif recheck() then following=idsFor(selected);nextCheck=GetTime()+60;followButton:SetText("Follow: on") end
    end)
    label(panel,"Runs",312,-66)
    local runs=edit(panel,350,-60,50,"1",true)
    label(panel,"Min. profit (c)",410,-66)
    local target=edit(panel,503,-60,62,"1",true)
    runs:SetScript("OnEditFocusLost",function(self)
        local n=math.min(10000,math.max(1,tonumber(self:GetText()) or batch));self:SetText(tostring(n))
        if n~=batch then batch=n;rebuild() end
    end)
    target:SetScript("OnEditFocusLost",function(self)
        minProfit=math.max(1,math.min(9007199254740991,tonumber(self:GetText()) or minProfit))
        self:SetText(tostring(minProfit));if selected then describe() end
    end)
    runs:SetScript("OnEnterPressed",runs.ClearFocus);target:SetScript("OnEnterPressed",target.ClearFocus)
    label(panel,"Find",14,-94)
    search=edit(panel,49,-88,137,"")
    search:SetScript("OnTextChanged",function() page=1;repaint() end)
    search:SetScript("OnEnterPressed",search.ClearFocus)
    profitButton=button(panel,"All margins",197,-88,100,function()
        onlyProfit=not onlyProfit;page=1;profitButton:SetText(onlyProfit and "Profitable only" or "All margins");repaint()
    end)
    button(panel,"Recheck page",304,-88,107,function()
        if not result then return end
        local ids,seen={},{}
        for _,b in ipairs(rowButtons) do
            if b.route then
                for _,id in ipairs(idsFor(b.route)) do
                    if not seen[id] then seen[id]=true;ids[#ids+1]=id end
                end
            end
        end
        W.startScan("scan",ids)
    end)
    button(panel,"Prev",418,-88,62,function() page=page-1;repaint() end)
    button(panel,"Next",488,-88,65,function() page=page+1;repaint() end)
    for n=1,PAGE do
        rowButtons[n]=button(panel,"",14,-116-(n-1)*22,552,function(self)
            if self.route then
                if selectedKey~=self.route.key then W.stopFollowing() end
                selectedKey=self.route.key;repaint()
            end
        end)
    end
    pageLabel=label(panel,"",14,-298)
    local list=CreateFrame("ScrollFrame","WowAuctionSyncRouteDetails",panel,"UIPanelScrollFrameTemplate")
    list:SetPoint("TOPLEFT",14,-319);list:SetPoint("BOTTOMRIGHT",-34,14)
    details=CreateFrame("EditBox",nil,list)
    details:SetMultiLine(true);details:SetAutoFocus(false);details:SetWidth(525)
    details:SetFontObject(GameFontHighlightSmall);details:SetTextInsets(2,2,2,2)
    details:SetScript("OnEscapePressed",details.ClearFocus)
    list:SetScrollChild(details)
    panel:SetScript("OnHide",function() W.stopFollowing();job=nil;result=nil end)
    panel:SetScript("OnUpdate",function() tick() end)
    if UISpecialFrames then table.insert(UISpecialFrames,"WowAuctionSyncOpportunities") end
end
function W.openOpportunities()
    if not panel then build() end
    panel:Show();rebuild()
    local region,market=W.scope()
    local full=WowAuctionSyncDB and WowAuctionSyncDB.markets[market]
    if W.auctionOpen() and not W.scanBusy() and
        (not full or full.region~=region or not full.complete or time()-full.capturedAt>W.quoteAge) then
        W.startScan("full")
    end
end

function W.attachOpportunities()
    local parent=AuctionHouseFrame or AuctionFrame
    if parent and not parent.wamOpportunities then
        local b=CreateFrame("Button",nil,parent,"UIPanelButtonTemplate")
        b:SetSize(130,22);b:SetPoint("BOTTOMRIGHT",parent,"TOPRIGHT",0,1)
        b:SetText("Opportunities");b:SetScript("OnClick",W.openOpportunities)
        parent.wamOpportunities=b
    end
end
