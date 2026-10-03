using CUE4Parse.FileProvider;
using CUE4Parse.UE4.Assets.Exports.Texture;
using CUE4Parse_Conversion.Textures;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using SkiaSharp;

/// <summary>
/// Converts the game's raw DataTables into the compact game-data.json consumed by the web app,
/// and exports item/building icons as small PNGs.
/// </summary>
static class Exporter
{
    const string ItemsTable = "AlchemyFactory/Content/DataTables/DT_Enemies.uasset";
    const string RecipesTable = "AlchemyFactory/Content/DataTables/DT_EnemyCrafting.uasset";
    const string BuildingsTable = "AlchemyFactory/Content/DataTables/DT_Buildings.uasset";
    const string SeedsTable = "AlchemyFactory/Content/DataTables/DT_PlantSeedConfig.uasset";
    const string ImprovementsTable = "AlchemyFactory/Content/DataTables/DT_Improvements.uasset";
    const string UpgradePointsTable = "AlchemyFactory/Content/DataTables/DT_UpgradePoints.uasset";
    const string AttributesTable = "AlchemyFactory/Content/DataTables/DT_Attributes.uasset";
    const string SkillsTable = "AlchemyFactory/Content/DataTables/DT_SkillMerge.uasset";
    const string WorkbenchTable = "AlchemyFactory/Content/DataTables/DT_Workbench.uasset";
    const string LicensesTable = "AlchemyFactory/Content/DataTables/DT_License.uasset";
    const int ResearchTiers = 9;
    const int IconSize = 64;

    public static void Run(DefaultFileProvider provider, Localization strings, string paksDir, string webDir)
    {
        var dataPath = Path.Combine(webDir, "src", "data", "game-data.json");
        var iconDir = Path.Combine(webDir, "public", "icons");
        Directory.CreateDirectory(Path.GetDirectoryName(dataPath)!);
        Directory.CreateDirectory(iconDir);

        var items = new JArray();
        foreach (var (key, row) in Rows(provider, ItemsTable))
        {
            var icon = ExportIcon(provider, row["DisplayIcon"], iconDir, "item_" + key);
            items.Add(new JObject
            {
                ["key"] = key,
                ["id"] = row["ID"],
                ["name"] = strings.Resolve(row["DisplayName"]) ?? key,
                ["icon"] = icon,
                ["tags"] = new JArray(row["IngredientTags"]!.Select(t => t.ToString().Replace("Ingredient.Type.", ""))),
                ["hidden"] = row["bHideInGame"],
                ["liquid"] = row["IsLiquid"],
                ["maxStack"] = row["MaximumStack"],
                ["baseCost"] = row["BaseCost"],
                ["cauldronCost"] = row["CauldronCost"],
                ["cauldronTarget"] = row["CauldronTarget"],
                ["cauldronMulti"] = row["CauldronMulti"],
                ["heatValue"] = row["HeatValue"],
                ["nutrientValue"] = row["NutrientValue"],
                ["nutrientSpeed"] = row["NutrientSpeed"],
                ["buyPrice"] = PortalPrice(row),
                ["sellPrice"] = ShopPrice(row),
            });
        }

        var recipes = new JArray();
        foreach (var (key, row) in Rows(provider, RecipesTable))
        {
            recipes.Add(new JObject
            {
                ["key"] = key,
                ["id"] = row["ID"],
                ["craftType"] = Enum(row["CraftType"]),
                ["time"] = row["CraftingTime"],
                ["batch"] = row["FractionNum"],
                ["inputs"] = new JArray(row["IngredientList"]!.Select(Stack)),
                ["output"] = Stack(row["ProductInfo"]!),
                ["side"] = OptionalStack(row["SideProduct"]!),
                ["fail"] = new JArray(new[] { ("FailRate1", "FailProduct1"), ("FailRate2", "FailProduct2") }
                    .Where(f => row[f.Item1]!.Value<double>() > 0)
                    .Select(f => new JObject { ["rate"] = row[f.Item1], ["product"] = OptionalStack(row[f.Item2]!) })),
                ["catalystCost"] = row["CatalystCost"],
                ["productSequence"] = row["ProductSequence"],
                ["unstableSequence"] = row["UnstableSequence"],
                ["alternate"] = row["bAlternate"],
                ["hidden"] = row["bHideInGame"],
            });
        }

        var buildings = new JArray();
        foreach (var (key, row) in Rows(provider, BuildingsTable))
        {
            var tags = row["BuildingTags"]!.Select(t => t.ToString()).ToList();
            // The Miniature World Tree is tagged as a decoration but runs a real World Tree nursery
            // (IsMininature: pinned to stage 2, leaves only).
            if (!tags.Any(t => t.StartsWith("Building.Crafting") || t == "Building.Heating") && key != "MiniWorldTree") continue;

            var components = BlueprintComponents(provider, row["ScriptClass"]);
            buildings.Add(new JObject
            {
                ["key"] = key,
                ["id"] = row["ID"],
                ["name"] = strings.Resolve(row["DisplayName"]) ?? key,
                ["icon"] = ExportIcon(provider, row["DisplayIcon"], iconDir, "building_" + key),
                ["hidden"] = row["bHideInGame"],
                ["heatCost"] = row["HeatCost"],
                ["tags"] = new JArray(tags),
                ["ports"] = Ports(row["InOutList"]!),
                ["craftType"] = components.Select(c => Enum(c["FactoryCraftType"] ?? c["FactoryType"])).FirstOrDefault(t => t != null),
                ["components"] = new JArray(components),
            });
        }

        var seeds = new JArray();
        foreach (var (key, row) in Rows(provider, SeedsTable))
        {
            seeds.Add(new JObject
            {
                ["seed"] = key,
                ["plant"] = row["PlantName"]?.ToString() is null or "None" ? null : row["PlantName"],
                ["side"] = row["SideProductName"]?.ToString() is null or "None" ? null : row["SideProductName"],
                ["growthSeconds"] = row["GrowthSeconds"],
                ["nutrientCost"] = row["GrowthNutrientValue"],
                ["count"] = row["GrowthNum"],
                ["sideCount"] = row["SideGrowthNum"],
            });
        }

        var data = new JObject
        {
            ["gameVersion"] = GameVersion(paksDir),
            ["extractedAt"] = DateTime.UtcNow.ToString("u"),
            ["items"] = items,
            ["recipes"] = recipes,
            ["buildings"] = buildings,
            ["seeds"] = seeds,
            ["upgrades"] = Upgrades(provider, strings, iconDir),
            ["research"] = Research(provider, strings, iconDir),
            ["attributes"] = new JObject(Rows(provider, AttributesTable)
                .Select(r => new JProperty(r.Key, r.Row["BaseValue"]))),
        };
        File.WriteAllText(dataPath, data.ToString(Formatting.Indented));
        Console.WriteLine($"Wrote {items.Count} items, {recipes.Count} recipes, {buildings.Count} buildings to {dataPath}");
    }

    static readonly string[] Sides = ["Right", "Bottom", "Left", "Up"];

    /// <summary>
    /// Counts a building's connections: belt inputs/outputs, and pipe inputs/outputs (liquids).
    /// Belts connect per side, so a cell accepting belts from three sides (Arcane Processor) is three
    /// inputs; pipe cells are one connection each.
    /// </summary>
    static JObject Ports(JToken inOutList)
    {
        int beltIn = 0, beltOut = 0, pipeIn = 0, pipeOut = 0;
        foreach (var cell in inOutList)
        {
            var isIn = Sides.Any(d => cell[d]?["IsInput"]?.Value<bool>() == true);
            var isOut = Sides.Any(d => cell[d]?["IsOutput"]?.Value<bool>() == true);
            if (cell["IsPipeGrid"]?.Value<bool>() == true)
            {
                var mode = Enum(cell["PipeOverrideType"]);
                if (mode != "OnlyOutput" && isIn) pipeIn++;
                if (mode != "OnlyInput" && isOut) pipeOut++;
            }
            else
            {
                beltIn += Sides.Count(d => cell[d]?["IsInput"]?.Value<bool>() == true);
                beltOut += Sides.Count(d => cell[d]?["IsOutput"]?.Value<bool>() == true);
            }
        }
        return new JObject { ["beltIn"] = beltIn, ["beltOut"] = beltOut, ["pipeIn"] = pipeIn, ["pipeOut"] = pipeOut };
    }

    /// Improvement series (FactorySpeed1..13 etc.) grouped into per-level effect lists.
    /// An IsUnlimited last level (∞ in game) is bought as "stacks", each applying its effects; every purchase,
    /// the first included, is a stack. ABeltTDGameStateBase::AllocateSkills caps stacks at MaxUnlimitedLevel
    /// only when it's > 0, so 0 means uncapped.
    /// `column` is the series' SlotPosition.X in the skill tree, for listing upgrades in the game's order;
    /// `icon` is the first level's (levels 1–12 share it; the ∞ level has a "_2" variant).
    static JArray Upgrades(DefaultFileProvider provider, Localization strings, string iconDir)
    {
        var points = Rows(provider, UpgradePointsTable).ToDictionary(r => r.Key, r => r.Row);
        var unlimited = points
            .Where(p => p.Value["IsUnlimited"]!.Value<bool>())
            .ToDictionary(p => p.Key, p => p.Value["MaxUnlimitedLevel"]!.Value<int>());

        var series = new Dictionary<string, JObject>();
        foreach (var (key, row) in Rows(provider, ImprovementsTable))
        {
            if (row["Deprecated"]!.Value<bool>()) continue;
            var name = key.TrimEnd("0123456789".ToCharArray());
            if (!series.TryGetValue(name, out var s))
                series[name] = s = new JObject
                {
                    ["key"] = name,
                    ["name"] = strings.Resolve(row["DisplayName"]) ?? name,
                    ["column"] = points.TryGetValue(key, out var point) ? point["SlotPosition"]!["X"] : null,
                    ["icon"] = ExportIcon(provider, row["DisplayIcon"], iconDir, "upgrade_" + name),
                    ["levels"] = new JArray(),
                    ["unlimited"] = false,
                    ["unlimitedMax"] = 0,
                };
            ((JArray)s["levels"]!).Add(new JArray(row["Effects"]!.Select(e => new JObject
            {
                ["attribute"] = e["AttributeName"],
                ["op"] = Enum(e["ModificationType"]),
                ["value"] = e["ModValue"],
            })));
            if (unlimited.TryGetValue(key, out var max))
            {
                s["unlimited"] = true;
                s["unlimitedMax"] = max;
            }
        }
        return new JArray(series.Values);
    }

    /// <summary>
    /// What each research tier unlocks, numbered 1–9 as the game shows them (DT_SkillMerge's Tier + 1;
    /// its last tier holds only the final level node and is folded into 9). Machines come from
    /// research nodes and from workbench entries tied to one; recipes only when a node names them
    /// (the rest come with their machine); `items` can be bought from that tier (each level node's
    /// LevelUnlockItems). License-gated recipes (alternate ingots) are listed with the license
    /// that unlocks them, not given a tier.
    /// </summary>
    static JObject Research(DefaultFileProvider provider, Localization strings, string iconDir)
    {
        var skills = Rows(provider, SkillsTable).Where(r => !r.Row["Deprecated"]!.Value<bool>()).ToDictionary(r => r.Key, r => r.Row);
        int TierOf(JObject skill) => Math.Min(skill["Tier"]!.Value<int>() + 1, ResearchTiers);
        var machines = new Dictionary<string, int>();
        var recipes = new Dictionary<string, int>();
        var items = new Dictionary<string, int>();
        void Unlock(Dictionary<string, int> map, string key, int tier)
        {
            if (key == "None") return;
            map[key] = map.TryGetValue(key, out var t) ? Math.Min(t, tier) : tier;
        }

        foreach (var skill in skills.Values)
        {
            var tier = TierOf(skill);
            var unlock = skill["UnlockItem"]!;
            var name = unlock["ConfigName"]!.ToString();
            switch (Enum(unlock["ConfigType"]))
            {
                case "ConstructOptions": Unlock(machines, name, tier); break;
                case "CraftingRecipes": Unlock(recipes, name, tier); break;
            }
            foreach (var extra in skill["ExtraUnlockConstructions"]!) Unlock(machines, extra.ToString(), tier);
            foreach (var item in skill["LevelUnlockItems"]!) Unlock(items, item.ToString(), tier);
        }

        // Workbench buildings unlock with a research node, or after another workbench building.
        var bench = Rows(provider, WorkbenchTable).ToDictionary(r => r.Row["UnlockBuilding"]!.ToString(), r => r.Row);
        int? BenchTier(string building, int depth = 0)
        {
            if (depth > 20 || !bench.TryGetValue(building, out var row)) return null;
            if (skills.TryGetValue(row["UnlockSkillName"]!.ToString(), out var skill)) return TierOf(skill);
            return BenchTier(row["PrerequisiteBuilding"]!.ToString(), depth + 1);
        }
        foreach (var building in bench.Keys)
            if (BenchTier(building) is { } tier) Unlock(machines, building, tier);

        var licenses = new JObject();
        foreach (var (_, row) in Rows(provider, LicensesTable))
            foreach (var unlock in row["UnlockItems"]!.Where(u => Enum(u["ConfigType"]) == "CraftingRecipes"))
                licenses[unlock["ConfigName"]!.ToString()] = new JObject
                {
                    ["name"] = strings.Resolve(row["LicenseText"]) ?? row["LicenseText"]?["Key"]?.ToString(),
                    ["level"] = row["LicenseTier"],
                };

        JObject Sorted(Dictionary<string, int> map) => new(map.OrderBy(e => e.Key).Select(e => new JProperty(e.Key, e.Value)));
        return new JObject
        {
            ["tiers"] = new JArray(Enumerable.Range(1, ResearchTiers).Select(t => new JObject
            {
                ["tier"] = t,
                ["icon"] = ExportIcon(provider,
                    new JObject { ["ObjectPath"] = $"/Game/Arts/UI/Interaction/T_UI_LevelSkill_{t}.T_UI_LevelSkill_{t}" },
                    iconDir, $"tier_{t}"),
            })),
            ["machines"] = Sorted(machines),
            ["recipes"] = Sorted(recipes),
            ["items"] = Sorted(items),
            ["licenses"] = licenses,
        };
    }

    static IEnumerable<(string Key, JObject Row)> Rows(DefaultFileProvider provider, string path)
    {
        var table = JArray.FromObject(provider.LoadPackage(path).GetExports(), JsonSerializer.Create())[0];
        foreach (var prop in ((JObject)table["Rows"]!).Properties())
            yield return (prop.Name, (JObject)prop.Value);
    }

    /// Scalar settings (craft type, speeds, capacities) from the blueprint's component templates.
    static List<JObject> BlueprintComponents(DefaultFileProvider provider, JToken? scriptClass)
    {
        var result = new List<JObject>();
        var objectPath = scriptClass?["ObjectPath"]?.ToString();
        if (string.IsNullOrEmpty(objectPath)) return result;

        var packagePath = "AlchemyFactory/Content/" + objectPath.Replace("/Game/", "").Split('.')[0] + ".uasset";
        if (!provider.TryLoadPackage(packagePath, out var pkg)) return result;

        foreach (var export in JArray.FromObject(pkg.GetExports()))
        {
            var type = export["Type"]?.ToString() ?? "";
            if (!type.EndsWith("Component") || export["Properties"] is not JObject props) continue;
            var scalars = new JObject { ["type"] = type };
            foreach (var p in props.Properties().Where(p => p.Value.Type is JTokenType.Integer or JTokenType.Float or JTokenType.String or JTokenType.Boolean))
                scalars[p.Name] = p.Value;
            if (scalars.Count > 1) result.Add(scalars);
        }
        return result;
    }

    static string? ExportIcon(DefaultFileProvider provider, JToken? iconRef, string iconDir, string name)
    {
        var objectPath = iconRef?["ObjectPath"]?.ToString();
        if (string.IsNullOrEmpty(objectPath)) return null;
        var fileName = name + ".png";
        var target = Path.Combine(iconDir, fileName);
        if (File.Exists(target)) return fileName;

        try
        {
            var texture = provider.LoadPackageObject<UTexture2D>(objectPath.Split('.')[0]);
            using var bitmap = texture.Decode()?.ToSkBitmap();
            if (bitmap == null) return null;
            using var resized = bitmap.Resize(new SKImageInfo(IconSize, IconSize), SKFilterQuality.High);
            using var png = SKImage.FromBitmap(resized).Encode(SKEncodedImageFormat.Png, 100);
            File.WriteAllBytes(target, png.ToArray());
            return fileName;
        }
        catch (Exception e)
        {
            Console.WriteLine($"icon {name}: {e.Message}");
            return null;
        }
    }

    /// The game ships no readable version string, so identify the data by Steam build id and pak date.
    static JObject GameVersion(string paksDir)
    {
        var pak = new DirectoryInfo(paksDir).GetFiles("*.utoc").OrderByDescending(f => f.Length).FirstOrDefault();
        string? buildId = null;
        var steamApps = new DirectoryInfo(paksDir);
        while (steamApps != null && !steamApps.Name.Equals("steamapps", StringComparison.OrdinalIgnoreCase))
            steamApps = steamApps.Parent;
        var manifest = steamApps?.GetFiles("appmanifest_*.acf")
            .FirstOrDefault(f => File.ReadAllText(f.FullName).Contains("\"Alchemy Factory\""));
        if (manifest != null)
            buildId = System.Text.RegularExpressions.Regex.Match(File.ReadAllText(manifest.FullName), "\"buildid\"\\s+\"(\\d+)\"").Groups[1].Value;
        return new JObject
        {
            ["steamBuildId"] = buildId,
            ["pakDate"] = pak?.LastWriteTimeUtc.ToString("yyyy-MM-dd"),
        };
    }

    const double CopperPerSilver = 1000;
    const double CopperPerGold = 100 * CopperPerSilver;

    /// <summary>
    /// Copper per item when bought from a purchasing portal, or null if the portal doesn't sell it.
    /// StockCost is (gold, silver, copper) for one item. Bulk raw materials (negative MaximumStack)
    /// are bundles: one Iron Ore costs 1,200 copper and smelts into 100 ingots, which is why their
    /// BaseCost (12) is per bundle unit rather than per item.
    /// </summary>
    static JToken PortalPrice(JObject row)
    {
        if (!row["AllowPortalSupply"]!.Value<bool>()) return JValue.CreateNull();
        var stock = row["StockCost"]!;
        var copper = stock["X"]!.Value<double>() * CopperPerGold + stock["Y"]!.Value<double>() * CopperPerSilver + stock["Z"]!.Value<double>();
        return copper > 0 ? copper : JValue.CreateNull();
    }

    /// <summary>
    /// Copper one item sells for in the shop at base prices, or null if the shop won't buy it.
    /// CostValue is (gold, silver, copper) per item; the shop pays it × (StoreProfit + the sale
    /// type's profit attribute − 1), and Worthless items (raw materials, intermediates, fuels) have
    /// no sale type attribute, so they sell for nothing (native 0x144A4EED0, build 25321648).
    /// </summary>
    static JToken ShopPrice(JObject row)
    {
        if (Enum(row["SellType"]) is null or "Worthless" or "Vehicles") return JValue.CreateNull();
        var value = row["CostValue"]!;
        var copper = value["X"]!.Value<double>() * CopperPerGold + value["Y"]!.Value<double>() * CopperPerSilver + value["Z"]!.Value<double>();
        return copper > 0 ? copper : JValue.CreateNull();
    }

    static string? Enum(JToken? value) => value?.ToString().Split("::").Last();
    static JObject Stack(JToken s) => new() { ["item"] = s["IngredientName"], ["count"] = s["Count"] };
    static JToken OptionalStack(JToken s) => s["IngredientName"]?.ToString() is null or "None" ? JValue.CreateNull() : Stack(s);
}
