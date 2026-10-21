using System.Numerics;
using CUE4Parse.FileProvider;
using CUE4Parse.UE4.Assets.Exports.Material;
using CUE4Parse.UE4.Assets.Exports.StaticMesh;
using CUE4Parse.UE4.Assets.Exports.Texture;
using CUE4Parse.UE4.Objects.Core.Math;
using CUE4Parse_Conversion.Dto;
using CUE4Parse_Conversion.Meshes;
using CUE4Parse_Conversion.Options;
using CUE4Parse_Conversion.Textures;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using SkiaSharp;

/// <summary>
/// The buildings' 3D models for the Blueprint X-ray, into web/public/models:
///
/// - manifest.json: each building (DT_Buildings row) as the meshes it's made of, each with its
///   transform from the building's origin and its materials, and its height in layers; the shapes a belt or pipe takes as
///   it joins its neighbours (DT_BeltMeshBuildings, DT_PipeMeshConfig2); each material's textures;
///   each mesh's file.
/// - meshes/*.mesh: one per mesh, in Unreal's own space and units, as the game places them; the
///   page turns the whole scene into three.js's space once. They're written plainly (MeshFile,
///   below) and compressed by web/scripts/compressMeshes.mjs, which needs Node and web/'s packages.
/// - textures/*.webp: base colour, normals and roughness (the green of the game's ORM textures,
///   as grayscale), scaled down from the game's 2048² (see TextureSizes).
///
/// A building's meshes are its row's InstanceMesh, or the static meshes of the Blueprint its
/// ScriptClass names, placed by its construction script's component tree.
/// </summary>
static class ModelExporter
{
    const string BuildingsTable = "AlchemyFactory/Content/DataTables/DT_Buildings.uasset";
    /// The tables of shapes a building of a SecondaryType takes, by the sides it joins (a placed
    /// one's BaseActiveIndex).
    static readonly Dictionary<string, string> ShapeTables = new()
    {
        ["Belt"] = "AlchemyFactory/Content/DataTables/DT_BeltMeshBuildings.uasset",
        ["Pipeline"] = "AlchemyFactory/Content/DataTables/DT_PipeMeshConfig2.uasset",
    };

    // Longest side of each kind of texture: colour carries the look, the rest only shading. Against
    // 512/256/256 at quality 82, these are 58% smaller, and look the same short of a close-up of one
    // machine, where the normal maps' finest dents soften.
    static readonly Dictionary<string, int> TextureSizes = new() { ["color"] = 384, ["normal"] = 192, ["orm"] = 128 };
    const int WebpQuality = 75;

    public static void Run(DefaultFileProvider provider, Localization strings, string webDir)
    {
        var outDir = Path.Combine(webDir, "public", "models");
        var meshDir = Path.Combine(outDir, "meshes");
        // The plain meshes, for compressMeshes.mjs to compress into meshDir.
        var plainDir = Path.Combine(Path.GetTempPath(), "yaafc-meshes");
        if (Directory.Exists(plainDir)) Directory.Delete(plainDir, true);
        Directory.CreateDirectory(plainDir);
        var textureDir = Path.Combine(outDir, "textures");
        // Start clean, so meshes and textures nothing uses any more don't linger.
        if (Directory.Exists(outDir)) Directory.Delete(outDir, true);
        Directory.CreateDirectory(meshDir);
        Directory.CreateDirectory(textureDir);

        var meshes = new JObject();
        // Each mesh's bounds, in its own space, for buildings' heights.
        var meshBounds = new Dictionary<string, (Vector3 Min, Vector3 Max)>();
        var materials = new JObject();
        var textures = new Dictionary<string, string?>();

        string? Mesh(string objectPath)
        {
            var name = ObjectName(objectPath);
            if (meshes.ContainsKey(name)) return name;
            try
            {
                var mesh = provider.LoadPackageObject<UStaticMesh>(PackagePath(objectPath) + "." + name);
                if (!MeshConverter.TryConvert(mesh, out StaticMeshDto dto, EMeshQuality.Highest, ENaniteMeshFormat.NoNanite, null) || dto.LODs.Count == 0)
                {
                    Console.WriteLine($"mesh {name}: no geometry");
                    return null;
                }
                File.WriteAllBytes(Path.Combine(plainDir, name + ".bin"), MeshFile(dto.LODs[0]));
                var points = dto.LODs[0].Vertices.Select(v => new Vector3((float)v.Position.X, (float)v.Position.Y, (float)v.Position.Z)).ToList();
                meshBounds[name] = (points.Aggregate(Vector3.Min), points.Aggregate(Vector3.Max));
                meshes[name] = new JObject
                {
                    ["materials"] = new JArray(mesh.StaticMaterials!.Select(m => Material(m.MaterialInterface?.ResolvedObject?.Load<UMaterialInterface>()))),
                };
                return name;
            }
            catch (Exception e)
            {
                Console.WriteLine($"mesh {name}: {e.Message}");
                return null;
            }
        }

        string? Material(UMaterialInterface? material)
        {
            if (material == null) return null;
            if (materials.ContainsKey(material.Name)) return material.Name;
            var parameters = new CMaterialParams2();
            material.GetParams(parameters, EMaterialDepth.TopLayerOnly);
            var entry = new JObject();
            foreach (var (kind, key) in new[] { ("color", CMaterialParams2.FallbackDiffuse), ("normal", CMaterialParams2.FallbackNormals), ("orm", CMaterialParams2.FallbackSpecularMasks) })
                if (parameters.TryGetTexture2d(out var texture, key) && Texture(texture, kind) is { } file)
                    entry[kind] = file;
            if (!entry.ContainsKey("color") && parameters.TryGetLinearColor(out var color, CMaterialParams2.DiffuseColors[0]))
                entry["tint"] = new JArray(Math.Round(color.R, 3), Math.Round(color.G, 3), Math.Round(color.B, 3));
            if (parameters.BlendMode is EBlendMode.BLEND_Masked) entry["masked"] = true;
            if (parameters.IsTranslucent) entry["translucent"] = true;
            materials[material.Name] = entry;
            return material.Name;
        }

        string? Texture(UTexture texture, string kind)
        {
            if (textures.TryGetValue(texture.Name, out var known)) return known;
            string? file = null;
            try
            {
                var size = TextureSizes[kind];
                // Mips halve: start from the smallest at least `size` (512 for 384), and scale that down.
                var mip = 1 << (int)Math.Ceiling(Math.Log2(size));
                using var decoded = TextureDecoder.Decode(texture, mip, ETexturePlatform.DesktopMobile)?.ToSkBitmap();
                if (decoded != null)
                {
                    var scale = Math.Min(1.0, size / (double)Math.Max(decoded.Width, decoded.Height));
                    using var resized = scale < 1
                        ? decoded.Resize(new SKImageInfo((int)(decoded.Width * scale), (int)(decoded.Height * scale)), SKFilterQuality.High)
                        : decoded.Copy();
                    if (kind == "normal") RebuildNormalZ(resized);
                    // The page reads only roughness (green) from these: as grayscale, they're half the size.
                    if (kind == "orm") GreenToGray(resized);
                    using var webp = SKImage.FromBitmap(resized).Encode(SKEncodedImageFormat.Webp, WebpQuality);
                    file = texture.Name + ".webp";
                    File.WriteAllBytes(Path.Combine(textureDir, file), webp.ToArray());
                }
            }
            catch (Exception e)
            {
                Console.WriteLine($"texture {texture.Name}: {e.Message}");
            }
            textures[texture.Name] = file;
            return file;
        }

        var buildings = new JObject();
        foreach (var (key, row) in Rows(provider, BuildingsTable))
        {
            var parts = new JArray();
            if (ObjectPath(row["InstanceMesh"]) is { } instanceMesh)
            {
                // A building drawn as one instanced mesh, as it stands. (A ramp's BeltRotation is its
                // incline, -31.3° or -45°, which its mesh is already built at: not a turn.)
                if (Mesh(instanceMesh) is { } mesh)
                    parts.Add(Part(mesh, Matrix4x4.Identity, null));
            }
            else if (ObjectPath(row["ScriptClass"]) is { } scriptClass)
            {
                foreach (var (meshPath, transform, overrides) in BlueprintMeshes(provider, scriptClass))
                    if (Mesh(meshPath) is { } mesh)
                        parts.Add(Part(mesh, transform, overrides.Select(o => o is null ? null : Material(LoadMaterial(provider, o))).ToList()));
            }
            if (parts.Count == 0) Console.WriteLine($"building {key}: no meshes");
            var entry = new JObject
            {
                ["name"] = strings.Resolve(row["DisplayName"]) ?? key,
                ["parts"] = parts,
            };
            var secondary = row["SecondaryType"]?.ToString().Split("::").Last();
            if (secondary != null && ShapeTables.ContainsKey(secondary)) entry["shapes"] = secondary;
            // Its height in whole layers, as the game builds with it: its top, to the nearest layer
            // (a cauldron's rim pokes 1 unit over its two; an athanor stands 2.84 high).
            entry["layers"] = Math.Max(1, (int)Math.Round(Top(parts, meshBounds) / 25));
            buildings[key] = entry;
        }

        // For each shape: the mesh, turned as the row's Rotation turns it. A belt's Desc names its
        // sides (left, right, up, bottom), each run of them followed by i(n) or o(ut).
        var shapes = new JObject();
        foreach (var (type, table) in ShapeTables)
        {
            var rows = new JObject();
            foreach (var (key, row) in Rows(provider, table))
                if (ObjectPath(row["mesh"]) is { } shapeMesh && Mesh(shapeMesh) is { } mesh)
                {
                    var turn = Relative(new JObject { ["RelativeRotation"] = row["Rotation"] });
                    // Pipe meshes are made round the middle of their cell, and a building's origin is
                    // at the bottom of its layer: up half a cell, once turned.
                    if (type == "Pipeline") turn *= Matrix4x4.CreateTranslation(0, 0, 12.5f);
                    var shape = Part(mesh, turn, null);
                    if (type == "Belt") shape["sides"] = row["Desc"];
                    rows[key] = shape;
                }
            shapes[type] = rows;
        }

        var manifest = new JObject
        {
            ["buildings"] = buildings,
            ["shapes"] = shapes,
            ["meshes"] = meshes,
            ["materials"] = materials,
        };
        File.WriteAllText(Path.Combine(outDir, "manifest.json"), manifest.ToString(Formatting.None));

        CompressMeshes(webDir, plainDir, meshDir);
        Directory.Delete(plainDir, true);

        long Size(string dir) => new DirectoryInfo(dir).GetFiles().Sum(f => f.Length);
        Console.WriteLine($"Wrote {buildings.Count} buildings, {shapes.Properties().Sum(t => ((JObject)t.Value).Count)} belt and pipe shapes, {meshes.Count} meshes " +
            $"({Size(meshDir) / 1024} KB), {textures.Count(t => t.Value != null)} textures ({Size(textureDir) / 1024} KB) to {outDir}");
    }

    /// The highest point of a building's parts, placed, in the game's units above its origin.
    static float Top(JArray parts, Dictionary<string, (Vector3 Min, Vector3 Max)> bounds)
    {
        var top = 0f;
        foreach (var part in parts)
        {
            if (!bounds.TryGetValue(part["mesh"]!.ToString(), out var b)) continue;
            var m = part["matrix"] is JArray a ? new Matrix4x4(
                a[0].Value<float>(), a[1].Value<float>(), a[2].Value<float>(), a[3].Value<float>(),
                a[4].Value<float>(), a[5].Value<float>(), a[6].Value<float>(), a[7].Value<float>(),
                a[8].Value<float>(), a[9].Value<float>(), a[10].Value<float>(), a[11].Value<float>(),
                a[12].Value<float>(), a[13].Value<float>(), a[14].Value<float>(), a[15].Value<float>()) : Matrix4x4.Identity;
            foreach (var x in new[] { b.Min.X, b.Max.X })
                foreach (var y in new[] { b.Min.Y, b.Max.Y })
                    foreach (var z in new[] { b.Min.Z, b.Max.Z })
                        top = Math.Max(top, Vector3.Transform(new Vector3(x, y, z), m).Z);
        }
        return top;
    }

    static void CompressMeshes(string webDir, string plainDir, string meshDir)
    {
        var node = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("node",
            [Path.Combine(webDir, "scripts", "compressMeshes.mjs"), plainDir, meshDir]) { WorkingDirectory = webDir })
            ?? throw new InvalidOperationException("Couldn't start node to compress the meshes");
        node.WaitForExit();
        if (node.ExitCode != 0)
            throw new InvalidOperationException("Compressing the meshes failed: is Node installed, and `npm install` run in web/?");
    }

    static JObject Part(string mesh, Matrix4x4 m, List<string?>? materials)
    {
        var part = new JObject { ["mesh"] = mesh };
        if (!m.IsIdentity)
            // Row-major, for Unreal's row vectors: read column-major, it's three.js's matrix for column vectors.
            part["matrix"] = new JArray(new[] { m.M11, m.M12, m.M13, m.M14, m.M21, m.M22, m.M23, m.M24, m.M31, m.M32, m.M33, m.M34, m.M41, m.M42, m.M43, m.M44 }
                .Select(v => Math.Round(v, 4)));
        if (materials?.Any(x => x != null) == true) part["materials"] = new JArray(materials);
        return part;
    }

    /// <summary>
    /// The static meshes a building Blueprint's construction script adds, with their transforms from
    /// the actor and their override materials (null: the mesh's own). A node's transform is relative
    /// to its parent node; a root node can hang off a component named by ParentComponentOrVariableName.
    /// </summary>
    static List<(string Mesh, Matrix4x4 Transform, List<string?> Materials)> BlueprintMeshes(DefaultFileProvider provider, string classPath)
    {
        var result = new List<(string, Matrix4x4, List<string?>)>();
        if (!provider.TryLoadPackage(PackagePath(classPath) + ".uasset", out var pkg)) return result;
        var exports = JArray.FromObject(pkg.GetExports(), JsonSerializer.Create());
        var byName = exports.Where(e => e["Name"] != null).GroupBy(e => e["Name"]!.ToString()).ToDictionary(g => g.Key, g => (JObject)g.First());
        static string RefName(JToken? r) => r?["ObjectName"]?.ToString().Split(':', '.').Last().TrimEnd('\'') ?? "";

        var nodes = exports.Where(e => e["Type"]?.ToString() == "SCS_Node").Cast<JObject>().ToList();
        var parentOf = new Dictionary<string, string>();
        foreach (var node in nodes)
            foreach (var child in node["Properties"]?["ChildNodes"] ?? new JArray())
                parentOf[RefName(child)] = node["Name"]!.ToString();
        var byVariable = nodes.Where(n => n["Properties"]?["InternalVariableName"] != null)
            .ToDictionary(n => n["Properties"]!["InternalVariableName"]!.ToString(), n => n["Name"]!.ToString());

        Matrix4x4 World(string nodeName, int depth = 0)
        {
            if (depth > 32 || !byName.TryGetValue(nodeName, out var node)) return Matrix4x4.Identity;
            var props = node["Properties"]!;
            var local = byName.TryGetValue(RefName(props["ComponentTemplate"]), out var template)
                ? Relative(template["Properties"]) : Matrix4x4.Identity;
            if (parentOf.TryGetValue(nodeName, out var parent)) return local * World(parent, depth + 1);
            if (props["ParentComponentOrVariableName"]?.ToString() is { } attached && byVariable.TryGetValue(attached, out var attachedNode))
                return local * World(attachedNode, depth + 1);
            return local;
        }

        foreach (var node in nodes)
        {
            if (!byName.TryGetValue(RefName(node["Properties"]?["ComponentTemplate"]), out var template)) continue;
            var props = template["Properties"];
            if (ObjectPath(props?["StaticMesh"]) is not { } meshPath) continue;
                    if (props["bVisible"]?.Value<bool>() == false || props["bHiddenInGame"]?.Value<bool>() == true) continue;
            // A catapult's landing area, which the game shows only while placing one.
            if (ObjectName(meshPath).Contains("AreaIndicator")) continue;
            var overrides = (props["OverrideMaterials"] ?? new JArray()).Select(ObjectPath).ToList();
            result.Add((meshPath, World(node["Name"]!.ToString()), overrides));
        }
        return result;
    }

    /// A component's transform from its parent: scale, then rotation, then translation (row vectors).
    static Matrix4x4 Relative(JToken? props)
    {
        var loc = props?["RelativeLocation"];
        var rot = props?["RelativeRotation"];
        var scale = props?["RelativeScale3D"];
        float F(JToken? t, string k, float fallback) => t?[k]?.Value<float>() ?? fallback;
        var q = new FRotator(F(rot, "Pitch", 0), F(rot, "Yaw", 0), F(rot, "Roll", 0)).Quaternion();
        return Matrix4x4.CreateScale(F(scale, "X", 1), F(scale, "Y", 1), F(scale, "Z", 1))
            * Matrix4x4.CreateFromQuaternion(new Quaternion((float)q.X, (float)q.Y, (float)q.Z, (float)q.W))
            * Matrix4x4.CreateTranslation(F(loc, "X", 0), F(loc, "Y", 0), F(loc, "Z", 0));
    }

    /// <summary>
    /// A mesh, plainly, for compressMeshes.mjs (AFM1), little-endian:
    ///
    ///   "AFM1" · vertices (u32) · indices (u32) · sections (u32) · bounds min, max (f32 × 3 each)
    ///   sections: first index, index count, material slot (u32 each)
    ///   positions: u16 × 3 per vertex, across the bounds (padded to 4 bytes)
    ///   normals: i8 × 4 per vertex (x, y, z, 0)
    ///   UVs: f32 × 2 per vertex
    ///   indices: u16, or u32 past 65,535 vertices
    /// </summary>
    static byte[] MeshFile(MeshLodDto<MeshVertex> lod)
    {
        var verts = lod.Vertices;
        var min = new Vector3(float.MaxValue);
        var max = new Vector3(float.MinValue);
        foreach (var v in verts)
        {
            var p = new Vector3((float)v.Position.X, (float)v.Position.Y, (float)v.Position.Z);
            min = Vector3.Min(min, p);
            max = Vector3.Max(max, p);
        }
        var span = Vector3.Max(max - min, new Vector3(1e-6f));
        var sections = lod.Sections.Where(s => s.NumFaces > 0).ToList();

        using var stream = new MemoryStream();
        using var w = new BinaryWriter(stream);
        w.Write("AFM1"u8);
        w.Write((uint)verts.Length);
        w.Write((uint)lod.Indices.Length);
        w.Write((uint)sections.Count);
        foreach (var f in new[] { min.X, min.Y, min.Z, max.X, max.Y, max.Z }) w.Write(f);
        foreach (var s in sections)
        {
            w.Write((uint)s.FirstIndex);
            w.Write((uint)(s.NumFaces * 3));
            w.Write((uint)s.MaterialIndex);
        }
        foreach (var v in verts)
        {
            var p = (new Vector3((float)v.Position.X, (float)v.Position.Y, (float)v.Position.Z) - min) / span;
            w.Write((ushort)Math.Round(p.X * 65535));
            w.Write((ushort)Math.Round(p.Y * 65535));
            w.Write((ushort)Math.Round(p.Z * 65535));
        }
        while (stream.Position % 4 != 0) w.Write((byte)0);
        foreach (var v in verts)
        {
            var n = Vector3.Normalize(new Vector3((float)v.Normal.X, (float)v.Normal.Y, (float)v.Normal.Z));
            w.Write((sbyte)Math.Round(n.X * 127));
            w.Write((sbyte)Math.Round(n.Y * 127));
            w.Write((sbyte)Math.Round(n.Z * 127));
            w.Write((sbyte)0);
        }
        foreach (var v in verts)
        {
            w.Write(v.Uv.U);
            w.Write(v.Uv.V);
        }
        var wide = verts.Length > 65535;
        foreach (var i in lod.Indices)
            if (wide) w.Write(i);
            else w.Write((ushort)i);
        return stream.ToArray();
    }

    /// Normal maps are stored two-channel (BC5): put back z, so the picture is a full normal map.
    static void RebuildNormalZ(SKBitmap bitmap)
    {
        for (var y = 0; y < bitmap.Height; y++)
            for (var x = 0; x < bitmap.Width; x++)
            {
                var c = bitmap.GetPixel(x, y);
                var nx = c.Red / 127.5 - 1;
                var ny = c.Green / 127.5 - 1;
                var nz = Math.Sqrt(Math.Max(0, 1 - nx * nx - ny * ny));
                bitmap.SetPixel(x, y, new SKColor(c.Red, c.Green, (byte)Math.Round((nz + 1) * 127.5), 255));
            }
    }

    /// An object reference's path, or null for an empty one (which the JSON writes as null).
    static string? ObjectPath(JToken? reference) =>
        reference is JObject o && o["ObjectPath"]?.ToString() is { Length: > 0 } path ? path : null;

    static void GreenToGray(SKBitmap bitmap)
    {
        for (var y = 0; y < bitmap.Height; y++)
            for (var x = 0; x < bitmap.Width; x++)
            {
                var g = bitmap.GetPixel(x, y).Green;
                bitmap.SetPixel(x, y, new SKColor(g, g, g, 255));
            }
    }

    static UMaterialInterface? LoadMaterial(DefaultFileProvider provider, string objectPath)
    {
        try { return provider.LoadPackageObject<UMaterialInterface>(PackagePath(objectPath) + "." + ObjectName(objectPath)); }
        catch { return null; }
    }

    /// "/Game/Arts/Mesh/SM_X.SM_X" (or ".2", an export index) → "AlchemyFactory/Content/Arts/Mesh/SM_X";
    /// the engine's own ("/Engine/BasicShapes/Cube") are under Engine/Content.
    static string PackagePath(string objectPath)
    {
        var path = objectPath.Split('.')[0];
        return path.StartsWith("/Engine/") ? "Engine/Content/" + path["/Engine/".Length..] : "AlchemyFactory/Content/" + path.Replace("/Game/", "");
    }
    static string ObjectName(string objectPath) => objectPath.Split('.')[0].Split('/').Last();

    static IEnumerable<(string Key, JObject Row)> Rows(DefaultFileProvider provider, string path)
    {
        var table = JArray.FromObject(provider.LoadPackage(path).GetExports(), JsonSerializer.Create())[0];
        foreach (var prop in ((JObject)table["Rows"]!).Properties())
            yield return (prop.Name, (JObject)prop.Value);
    }
}
