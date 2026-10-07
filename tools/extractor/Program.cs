using System.Text.RegularExpressions;
using CUE4Parse.Compression;
using CUE4Parse.FileProvider;
using CUE4Parse.MappingsProvider.Usmap;
using CUE4Parse.UE4.Versions;
using Newtonsoft.Json;

// Usage:
//   Extractor list [regex]              list game files (optionally filtered)
//   Extractor dump <regex> <outDir>     export matching packages to JSON
//   Extractor strings [regex]           search the English text
//   Extractor schema [regex]            print native class/struct properties from the mappings
//   Extractor export [webDir]           write game-data.json + icons for the web app
var mode = args.Length > 0 ? args[0] : "list";
var paksDir = Environment.GetEnvironmentVariable("AF_PAKS")
    ?? @"C:\Program Files (x86)\Steam\steamapps\common\Alchemy Factory\AlchemyFactory\Content\Paks";

var oodlePath = Path.Combine(AppContext.BaseDirectory, OodleHelper.OodleFileName);
if (!File.Exists(oodlePath)) { string? p = oodlePath; OodleHelper.DownloadOodleDll(ref p); }
OodleHelper.Initialize(oodlePath);

var provider = new DefaultFileProvider(paksDir, SearchOption.TopDirectoryOnly,
    new VersionContainer(EGame.GAME_UE5_7), StringComparer.OrdinalIgnoreCase);
var mappingsPath = Environment.GetEnvironmentVariable("AF_MAPPINGS")
    ?? Path.Combine(FindProjectDir(), "mappings", "Mappings.usmap");
provider.MappingsContainer = new FileUsmapTypeMappingsProvider(mappingsPath);
provider.ReadScriptData = mode == "dump"; // Blueprint bytecode (e.g. formulas in UI widgets)
provider.Initialize();
provider.Mount();
var strings = new Localization(provider, "en");

if (mode == "strings")
{
    var filterText = new Regex(args.Length > 1 ? args[1] : ".", RegexOptions.IgnoreCase);
    foreach (var (ns, key, text) in strings.All().Where(e => filterText.IsMatch(e.Key) || filterText.IsMatch(e.Text)))
        Console.WriteLine($"{ns}/{key}: {text.ReplaceLineEndings(" ")}");
    return;
}

if (mode == "schema")
{
    // Property layout of native classes/structs (from the usmap), e.g. for C++-only components.
    var filterSchema = new Regex(args.Length > 1 ? args[1] : ".", RegexOptions.IgnoreCase);
    foreach (var (name, schema) in provider.MappingsForGame!.Types.Where(t => filterSchema.IsMatch(t.Key)).OrderBy(t => t.Key))
    {
        Console.WriteLine($"{name} : {schema.SuperType ?? "-"}");
        foreach (var prop in schema.Properties.Values.OrderBy(p => p.Index))
            Console.WriteLine($"  {prop.Name}: {prop.MappingType.Type}{(prop.MappingType.StructType is { } s ? $"<{s}>" : "")}{(prop.MappingType.InnerType is { } i ? $"<{i.Type}{(i.StructType is { } si ? $":{si}" : "")}>" : "")}");
    }
    // Enums too, with their values.
    foreach (var (name, values) in provider.MappingsForGame.Enums.Where(e => filterSchema.IsMatch(e.Key)).OrderBy(e => e.Key))
        Console.WriteLine($"enum {name}: {string.Join(", ", values.OrderBy(v => v.Key).Select(v => $"{v.Value}={v.Key}"))}");
    return;
}

if (mode == "export")
{
    Exporter.Run(provider, strings, paksDir, args.Length > 1 ? args[1]
        : Path.GetFullPath(Path.Combine(FindProjectDir(), "..", "..", "web")));
    return;
}

var filter = new Regex(args.Length > 1 ? args[1] : ".", RegexOptions.IgnoreCase);
var matches = provider.Files.Keys.Where(k => filter.IsMatch(k)).Order().ToList();

switch (mode)
{
    case "list":
        foreach (var path in matches) Console.WriteLine(path);
        break;

    case "dump":
        var outDir = args.Length > 2 ? args[2] : "dump";
        foreach (var path in matches.Where(m => m.EndsWith(".uasset")))
        {
            var target = Path.Combine(outDir, Path.ChangeExtension(path, ".json"));
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            try
            {
                var pkg = provider.LoadPackage(path);
                File.WriteAllText(target, JsonConvert.SerializeObject(pkg.GetExports(), Formatting.Indented));
                Console.WriteLine($"ok   {path}");
            }
            catch (Exception e)
            {
                Console.WriteLine($"FAIL {path}: {e.Message}");
            }
        }
        break;
}

// Walk up from the build output to the folder containing Extractor.csproj.
static string FindProjectDir()
{
    var dir = new DirectoryInfo(AppContext.BaseDirectory);
    while (dir != null && !File.Exists(Path.Combine(dir.FullName, "Extractor.csproj")))
        dir = dir.Parent;
    return dir?.FullName ?? Directory.GetCurrentDirectory();
}
