local _,W=...
local function itemID(link) return link and tonumber(link:match("item:(%d+)")) end
local function record(dst,id,name,output,quantity,mats,req,maximum)
    if not output or not quantity or quantity<1 or not next(mats) then return end
    W.cache(output)
    local lines={}
    for item,count in pairs(mats) do W.cache(item); lines[#lines+1]={item,count} end
    table.sort(lines,function(a,b)return a[1]<b[1] end)
    if type(maximum)~="number" or maximum<quantity then maximum=nil end
    dst[tostring(id)]={id=tostring(id),name=name,output=output,quantity=quantity,quantity_max=maximum,mats=lines,requirements=req}
end
local function modern()
    local api=C_TradeSkillUI
    if not api or not api.GetAllRecipeIDs or not api.GetRecipeSchematic then return end
    if (api.IsTradeSkillLinked and api.IsTradeSkillLinked()) or (api.IsTradeSkillGuild and api.IsTradeSkillGuild()) then return end
    local p=api.GetBaseProfessionInfo and api.GetBaseProfessionInfo()
    if (not p or not p.professionName) and api.GetTradeSkillLine then
        local _,name,rank=api.GetTradeSkillLine()
        p={professionName=name,skillLevel=rank}
    end
    if not p or not p.professionName then return end
    local recipes={}
    for _,id in ipairs(api.GetAllRecipeIDs()) do
        local info=api.GetRecipeInfo(id)
        if info and info.learned then
            local s=api.GetRecipeSchematic(id,false)
            if not s then return end
            local mats,valid={},true
            for _,slot in ipairs(s.reagentSlotSchematics or {}) do
                if slot.required then
                    local choice=slot.reagents
                    if not choice or #choice~=1 or not choice[1].itemID or not slot.quantityRequired or slot.quantityRequired<1 then valid=false;break end
                    local item=choice[1].itemID;mats[item]=(mats[item] or 0)+slot.quantityRequired
                end
            end
            if valid then record(recipes,id,info.name,s.outputItemID or itemID(api.GetRecipeItemLink(id)),s.quantityMin,mats,
                {profession=p.professionName,skill=info.requiredSkillRank,source=info.sourceText,station=s.craftingStation,tools=s.tools},s.quantityMax) end
        end
    end
    return p.professionName,p.skillLevel or 0,recipes
end
local function classic()
    if not GetTradeSkillLine or (IsTradeSkillLinked and IsTradeSkillLinked()) then return end
    local prof,rank=GetTradeSkillLine()
    if not prof or prof=="" or prof=="UNKNOWN" then return end
    local recipes={}
    for n=1,GetNumTradeSkills() do
        local name,kind=GetTradeSkillInfo(n)
        if kind~="header" and kind~="subheader" then
            local output=itemID(GetTradeSkillItemLink(n));local mats={}
            for j=1,GetTradeSkillNumReagents(n) do
                local _,_,qty=GetTradeSkillReagentInfo(n,j)
                local id=itemID(GetTradeSkillReagentItemLink(n,j))
                if not id or not qty then return end
                mats[id]=(mats[id] or 0)+qty
            end
            local link=GetTradeSkillRecipeLink and GetTradeSkillRecipeLink(n)
            local id=link and link:match("enchant:(%d+)") or (prof.."/"..name)
            local tools=GetTradeSkillTools and GetTradeSkillTools(n)
            local minimum,maximum=GetTradeSkillNumMade(n)
            record(recipes,id,name,output,minimum,mats,{profession=prof,tools=tools},maximum)
        end
    end
    return prof,rank,recipes
end
local professionNames={[171]="Alchemy",[164]="Blacksmithing",[333]="Enchanting",[202]="Engineering",
    [182]="Herbalism",[165]="Leatherworking",[186]="Mining",[393]="Skinning",[197]="Tailoring",
    [185]="Cooking",[129]="First Aid",[356]="Fishing"}
local byName={}
for _,name in pairs(professionNames) do byName[name]=true end
function W.roster(profile,manual)
    local who=UnitName("player")
    local c=profile.characters[who] or {professions={},recipes={}}
    c.level=UnitLevel("player")
    profile.characters[who]=c
    local known,complete={},false
    if GetProfessions and GetProfessionInfo then
        complete=true
        for _,index in pairs({GetProfessions()}) do
            local name,_,rank,_,_,_,id=GetProfessionInfo(index)
            if name and rank and rank>0 then known[professionNames[id] or name]=rank else complete=false end
        end
        if not manual and not next(known) then complete=false end
    end
    if not next(known) and GetNumSkillLines and GetSkillLineInfo then
        local count=GetNumSkillLines()
        complete=count>0 and (not GetLocale or GetLocale()=="enUS" or GetLocale()=="enGB")
        for i=1,count do
            local name,header,expanded,rank=GetSkillLineInfo(i)
            if header and not expanded then complete=false end
            if not header and byName[name] and rank and rank>0 then known[name]=rank end
        end
    end
    if complete then
        c.professions=known
        for name in pairs(c.recipes) do
            if byName[name] and not known[name] then c.recipes[name]=nil end
        end
    else
        for name,rank in pairs(known) do c.professions[name]=rank end
    end
    c.completeRoster=complete
    if manual then
        W.say(complete and ("Saved profession slots and ranks for "..who..". Type /reload to export.")
            or "Saved available ranks. Expand the Skills pane sections and try /wamsync roster again to confirm open slots.")
    end
    return c
end
function W.recipes(profile)
    if (C_TradeSkillUI and C_TradeSkillUI.IsTradeSkillLinked and C_TradeSkillUI.IsTradeSkillLinked())
        or (C_TradeSkillUI and C_TradeSkillUI.IsTradeSkillGuild and C_TradeSkillUI.IsTradeSkillGuild())
        or (IsTradeSkillLinked and IsTradeSkillLinked()) then
        W.say("Open your own learned profession.");return
    end
    local prof,rank,recipes=modern()
    if not prof then prof,rank,recipes=classic() end
    if not prof and GetCraftDisplaySkillLine and CraftFrame and CraftFrame:IsShown() then
        prof,rank=GetCraftDisplaySkillLine()
        recipes={}
        for n=1,GetNumCrafts() do
            local name,_,kind=GetCraftInfo(n)
            if kind~="header" then
                local output=itemID(GetCraftItemLink(n))
                if output then
                    local mats={}
                    for j=1,GetCraftNumReagents(n) do
                        local id=itemID(GetCraftReagentItemLink(n,j))
                        local _,_,qty=GetCraftReagentInfo(n,j)
                        if not id or not qty then W.say("Waiting for reagent information.");return end
                        mats[id]=(mats[id] or 0)+qty
                    end
                    record(recipes,prof.."/"..name,name,output,1,mats,{profession=prof})
                end
            end
        end
    end
    if not prof then W.say("Open your own learned profession and wait for recipe data.");return end
    local character=UnitName("player")
    local c=W.roster(profile,false)
    c.professions[prof]=rank
    c.recipes[prof]=recipes;profile.characters[character]=c
    W.say("Saved "..prof.." for "..character..". Type /reload to export.")
end

