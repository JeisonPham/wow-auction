local _, W = ...
W.quoteAge = 15 * 60
local INF = math.huge
local unpack = unpack or table.unpack
local function copy(t)
    local result = {}
    for k, v in pairs(t) do result[k] = v end
    return result
end
local function addCounts(to, from, times)
    for id, n in pairs(from) do to[id] = (to[id] or 0) + n * times end
end

-- Quote an actual basket of indivisible stacks. Commodity tiers are size-one lots.
local function basket(lots, need)
    local spent, units, best, bestUnits = 0, 0, INF, 0
    local same, work = true, 0
    for _, lot in ipairs(lots) do
        local size, price, count = unpack(lot)
        same = same and size == lots[1][1]
        local fill = math.ceil((need-units)/size)
        if fill <= count and spent + fill*price < best then
            best, bestUnits = spent + fill*price, units + fill*size
        end
        local take = math.min(count, math.floor((need-units)/size))
        spent, units = spent + take*price, units + take*size
        work = work + math.ceil(math.log(1+math.min(count, math.ceil(need/size)))/math.log(2))*need
    end
    if best == INF then return end
    if same or work > 250000 then return best, bestUnits end
    local costs, sizes = {[0]=0}, {[0]=0}
    for _, lot in ipairs(lots) do
        local size, price, count = unpack(lot)
        local left, group = math.min(count, math.ceil(need/size)), 1
        while left > 0 do
            local take = math.min(left, group)
            for n=need-1,0,-1 do
                if costs[n] then
                    local bought, cost = n + take*size, costs[n] + take*price
                    local nextN = math.min(need, bought)
                    if cost < (costs[nextN] or INF) or (cost == costs[nextN] and bought < sizes[nextN]) then
                        costs[nextN], sizes[nextN] = cost, bought
                    end
                end
            end
            left, group = left-take, group*2
        end
    end
    return costs[need], sizes[need]
end

-- Called in short coroutine slices by the panel. No server estimate is a price source here.
function W.evaluateOpportunities(cat, profile, db, region, market, batch, now, pulse)
    local full, target = db.markets[market], db.targeted[market]
    if not (full and full.complete and full.region == region) then full = nil end
    if not (target and target.complete and target.region == region) then target = nil end
    local book, metadata, earliestExpiry = {}, {}, INF
    local function meta(id)
        if not metadata[id] then
            local base, live = cat.items[id] or {}, profile.itemInfo[id] or {}
            local m = copy(base)
            m.name = live.name or m.name or ("Item "..id)
            m.sell = live.vendor_sell or m.sell
            if live.binding and live.binding ~= "" then
                m.bound = live.binding=="Binds when picked up" or live.binding=="Quest item"
                m.trade = live.binding=="Unbound" or live.binding=="Binds when equipped" or live.binding=="Binds when used"
            end
            metadata[id] = m
        end
        return metadata[id]
    end
    local function quote(id)
        if book[id] then return book[id] end
        local at = full and full.capturedAt or 0
        local rec = full and full.items[id]
        if target and target.checked[id] then
            local t = (target.checkedAt and target.checkedAt[id]) or target.capturedAt
            if t >= at then at, rec = t, target.items[id] end
        end
        local q = {lots={}, costs={}}
        if at > 0 and at <= now+300 and now-at <= W.quoteAge then
            q.at = at
            earliestExpiry = math.min(earliestExpiry, at+W.quoteAge+1)
            for size, levels in pairs(rec and rec.lots or {}) do
                for price, count in pairs(levels) do
                    table.insert(q.lots,{size,price,count})
                end
            end
            table.sort(q.lots,function(a,b)
                local x,y = a[2]/a[1], b[2]/b[1]
                return x < y or (x == y and a[1]<b[1])
            end)
            local first=q.lots[1]
            q.ask = first and first[2]/first[1]
        end
        book[id]=q
        return q
    end
    local function buy(id, count, useVendor)
        local q, m = quote(id), meta(id)
        if q.costs[count] == nil then
            local cost, qty = basket(q.lots, count)
            q.costs[count] = cost and {cost=cost,qty=qty,at=q.at} or false
        end
        local auction = not m.bound and q.costs[count]
        if useVendor and m.buy and (not auction or m.buy*count<=auction.cost) then
            return {cost=m.buy*count,qty=count,vendor=true}
        end
        return auction
    end
    local function costOf(raw, runs, useVendor)
        local cost, oldest = 0, INF
        for id,n in pairs(raw) do
            local line = buy(id,n*runs,useVendor)
            if not line then return nil end
            cost, oldest = cost+line.cost, math.min(oldest,line.at or INF)
        end
        return cost, oldest
    end
    local recipes, seen, direct, names, learned = {}, {}, {}, {}, {}
    local function addRecipe(r)
        if seen[r.id] or (r.faction and r.faction ~= UnitFactionGroup("player")) then return end
        seen[r.id]=r
        local key=(r.profession or "").."/"..r.name.."/"..r.output
        if names[key] == nil then names[key]=r else names[key]=false end
        local raw={}
        for _,mat in ipairs(r.mats) do raw[mat[1]]=(raw[mat[1]] or 0)+mat[2] end
        direct[r]={raw=raw,used={[r.id]=true},steps={}}
        recipes[#recipes+1]=r
    end
    for _,r in ipairs(cat.recipes) do addRecipe(copy(r));pulse() end
    for character,char in pairs(profile.characters) do
        for prof,group in pairs(char.recipes or {}) do
            for _,saved in pairs(group) do
                local r=seen[saved.id]
                if not r and not tonumber(saved.id) then
                    local match=names[prof.."/"..saved.name.."/"..saved.output]
                    if match and #match.mats==#saved.mats then
                        local same=true
                        for _,mat in ipairs(saved.mats) do
                            if direct[match].raw[mat[1]]~=mat[2] then same=false end
                        end
                        if same then r=match end
                    end
                end
                if not r then
                    r=copy(saved);r.profession=prof
                    addRecipe(r)
                elseif saved.quantity and saved.quantity>0 and saved.mats and #saved.mats>0 then
                    r.quantity,r.mats=saved.quantity,saved.mats
                    local raw={}
                    for _,mat in ipairs(r.mats) do raw[mat[1]]=(raw[mat[1]] or 0)+mat[2] end
                    direct[r].raw=raw
                end
                learned[r.id]=learned[r.id] or {}
                table.insert(learned[r.id],character)
            end
        end
    end
    -- Rank intermediate producers by checked cost per piece. Every complete path is
    -- priced again with aggregate raw quantities, whole casts and available stock.
    local best = {}
    for _,r in ipairs(recipes) do best[r]=direct[r] end
    for depth=1,3 do
        local sources = {}
        local function offer(id, yield, r, plan, cost, destroy)
            if not sources[id] or cost/yield < sources[id].unit then
                sources[id]={r=r,plan=plan,yield=yield,unit=cost/yield,destroy=destroy}
            end
        end
        for _,r in ipairs(recipes) do
            local plan = best[r]
            local cost = costOf(plan.raw,1,true)
            if cost then
                offer(r.output,r.quantity,r,plan,cost)
                for id,yield in pairs(cat.bands[meta(r.output).band] or {}) do
                    offer(id,yield*r.quantity,r,plan,cost,true)
                end
            end
            pulse()
        end
        local changed=false
        for _,r in ipairs(recipes) do
            local raw,steps,used={}, {}, {[r.id]=true}
            for _,mat in ipairs(r.mats) do
                local id,n=mat[1],mat[2]
                local src=sources[id]
                local runs=src and math.ceil(n/src.yield)
                local buyLine=buy(id,n*batch,true)
                local subCost=src and costOf(src.plan.raw,runs*batch,true)
                if subCost and not src.plan.used[r.id] and (not meta(id).bound or src.r.profession==r.profession)
                    and (not buyLine or subCost<buyLine.cost) then
                    addCounts(raw,src.plan.raw,runs)
                    for key in pairs(src.plan.used) do used[key]=true end
                    for _,step in ipairs(src.plan.steps) do
                        steps[#steps+1]={name=step.name,runs=step.runs*runs,recipe=step.recipe}
                    end
                    steps[#steps+1]={name=src.r.name.." ("..src.r.profession..")",runs=runs,recipe=src.r}
                    if src.destroy then steps[#steps+1]={name="Disenchant "..src.r.name,runs=runs*src.r.quantity} end
                else raw[id]=(raw[id] or 0)+n end
            end
            if #steps>0 then
                local cost=costOf(raw,batch,true)
                if cost and cost<(costOf(best[r].raw,batch,true) or INF) then
                    best[r]={raw=raw,steps=steps,used=used}
                    changed=true
                end
            end
            pulse()
        end
        if not changed then break end
    end

    local function timing(steps, recipe, destroys, quantity)
        if not recipe and not destroys then return end
        local elapsed,cd=0,{}
        local function cast(r,n)
            if not r then elapsed=elapsed+(cat.deSeconds or 3)*n;return end
            local cooldown=r.cooldown or 0
            if cooldown>0 then
                local slot=cd[r.id] or {first=elapsed,ready=elapsed}
                elapsed=math.max(slot.ready,elapsed)+(r.cast or 3)*n+cooldown*(n-1)
                slot.ready=elapsed+cooldown;cd[r.id]=slot
            else elapsed=elapsed+(r.cast or 3)*n end
        end
        for _,step in ipairs(steps) do cast(step.recipe,step.runs) end
        if recipe then cast(recipe,1) end
        if destroys then cast(nil,quantity) end
        local period=elapsed
        for _,slot in pairs(cd) do period=math.max(period,slot.ready-slot.first) end
        return elapsed+(batch-1)*period,period
    end
    local results={}
    local function exits(id,count,plan,r,prefix)
        local item=meta(id)
        local cost, oldest=costOf(plan.raw,batch,r~=nil)
        local function row(kind, unit, saleAt, saleIDs, destroys)
            local out=unit and math.floor(unit*count*batch)
            local profit=cost and out and out-cost
            -- Only buy flips need a listed item. Craft recipes stay browsable without a quote.
            if not r and not cost then return end
            local seconds,period=timing(plan.steps,r,destroys,count)
            results[#results+1]={seconds=seconds,hourly=profit and period and period>0 and profit*.36/(batch*period) or nil,
                learned=r and learned[r.id],skill=r and r.skill,key=prefix.."/"..kind, item=id,name=r and r.name or item.name,
                kind=kind, profession=r and r.profession, cost=cost, proceeds=out, profit=profit,
                at=math.min(oldest or INF,saleAt or INF), raw=plan.raw,steps=plan.steps,
                saleIDs=saleIDs,craft=r~=nil}
        end
        if r or (item.sell and item.sell>0) then row(r and "Craft → vendor" or "Buy → vendor",item.sell) end
        if r and item.trade then
            local q=quote(id)
            row("Craft → auction",q.ask and q.ask*323/400,q.at,{id})
        end
        local drops=cat.bands[item.band]
        if drops then
            local gross, saleAt, ids=0,INF,{}
            for mat,qty in pairs(drops) do
                local q=quote(mat)
                if gross and q.ask then gross=gross+qty*q.ask else gross=nil end
                saleAt=math.min(saleAt,q.at or INF)
                ids[#ids+1]=mat
            end
            row(r and "Craft → disenchant" or "Buy → disenchant",gross and gross*323/400,saleAt,ids,true)
        end
    end
    for _,r in ipairs(recipes) do
        exits(r.output,r.quantity,direct[r],r,"r/"..r.id)
        if best[r]~=direct[r] then exits(r.output,r.quantity,best[r],r,"chain/"..r.id) end
        pulse()
    end
    local listed={}
    for id in pairs(full and full.items or {}) do listed[id]=true end
    for id in pairs(target and target.items or {}) do listed[id]=true end
    for id in pairs(listed) do
        if not meta(id).bound then exits(id,1,{raw={[id]=1},steps={}},nil,"i/"..id) end
        pulse()
    end
    table.sort(results,function(a,b)
        local x,y=a.profit or -INF,b.profit or -INF
        if x~=y then return x>y end
        if a.name~=b.name then return a.name<b.name end
        return a.key<b.key
    end)
    return {rows=results,expiry=earliestExpiry,buy=buy,meta=meta,batch=batch,fullAt=full and full.capturedAt}
end
