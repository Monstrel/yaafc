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
