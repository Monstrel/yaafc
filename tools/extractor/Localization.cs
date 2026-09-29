using CUE4Parse.FileProvider;
using CUE4Parse.UE4.Localization;
using CUE4Parse.UE4.Readers;
using Newtonsoft.Json.Linq;

/// Resolves serialized FText values to one culture using Game.locres and the game's string tables.
class Localization
{
    readonly DefaultFileProvider _provider;
    readonly Dictionary<string, Dictionary<string, string>> _entries = new();   // namespace -> key -> text
    readonly Dictionary<string, string?> _tableNamespaces = new();                // string table path -> namespace

    public Localization(DefaultFileProvider provider, string culture)
    {
        _provider = provider;
        var path = $"AlchemyFactory/Content/Localization/Game/{culture}/Game.locres";
        if (!provider.TrySaveAsset(path, out var bytes))
        {
            Console.WriteLine($"No localization found at {path}; names will fall back to source strings.");
            return;
        }

        var locres = new FTextLocalizationResource(new FByteArchive(path, bytes));
        foreach (var ns in JObject.FromObject(locres).Properties())
            _entries[ns.Name] = ((JObject)ns.Value).Properties().ToDictionary(p => p.Name, p => p.Value.ToString());
    }

    /** Every entry as (namespace, key, text), for searching. */
    public IEnumerable<(string Namespace, string Key, string Text)> All() =>
        _entries.SelectMany(ns => ns.Value.Select(e => (ns.Key, e.Key, e.Value)));

    public string? Resolve(JToken? text)
    {
        if (text == null) return null;
        var key = text["Key"]?.ToString();
        var ns = text["TableId"]?.ToString() is { } tableId ? TableNamespace(tableId) : text["Namespace"]?.ToString();
        if (key != null && _entries.TryGetValue(ns ?? "", out var table) && table.TryGetValue(key, out var value))
            return value;
        return text["LocalizedString"]?.ToString() ?? text["SourceString"]?.ToString();
    }

    string? TableNamespace(string tableId)
    {
        if (_tableNamespaces.TryGetValue(tableId, out var cached)) return cached;
        string? ns = null;
        var packagePath = "AlchemyFactory/Content/" + tableId.Replace("/Game/", "").Split('.')[0] + ".uasset";
        if (_provider.TryLoadPackage(packagePath, out var pkg))
            ns = JArray.FromObject(pkg.GetExports())[0]["StringTable"]?["TableNamespace"]?.ToString();
        return _tableNamespaces[tableId] = ns;
    }
}
