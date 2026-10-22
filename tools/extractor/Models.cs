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
///   each mesh's file; for a notice board, where it shows its words (see TextFaces); for a nursery,
///   where it grows its plant (see PlantSlot), and the plant each seed grows (DT_PlantSeedConfig).
/// - meshes/*.mesh: one per mesh, in Unreal's own space and units, as the game places them; the
///   page turns the whole scene into three.js's space once. They're written plainly (MeshFile,
///   below) and compressed by web/scripts/compressMeshes.mjs, which needs Node and web/'s packages.
/// - textures/*.webp: base colour, normals and roughness (the green of the game's ORM textures,
///   as grayscale), and where a tintable building takes its tint (its Mask), scaled down from the
///   game's 2048² (see TextureSizes).
/// - WinkySans-Regular.ttf: the font notice boards write in.
///
/// A building's meshes are its row's InstanceMesh, or the static meshes of the Blueprint its
/// ScriptClass names, placed by its construction script's component tree.
/// </summary>
static class ModelExporter
{
    const string BuildingsTable = "AlchemyFactory/Content/DataTables/DT_Buildings.uasset";
    const string SeedsTable = "AlchemyFactory/Content/DataTables/DT_PlantSeedConfig.uasset";
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
    static readonly Dictionary<string, int> TextureSizes = new() { ["color"] = 384, ["normal"] = 192, ["orm"] = 128, ["mask"] = 256 };
    const int WebpQuality = 75;
    const string SignFont = "AlchemyFactory/Content/UI/Fonts/WinkySans/WinkySans-Regular.ufont";

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
            // A building the player can tint (MaskColorChange, from its CustomColor) takes the tint
            // where its Mask is white: a box's panels, not its metal.
            if (parameters.TryGetLinearColor(out _, "MaskColorChange") && parameters.TryGetTexture2d(out var mask, "Mask") && Texture(mask, "mask") is { } maskFile)
                entry["mask"] = maskFile;
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
                    // Masks are gray already (stored as colour); written as gray, they're smaller.
                    if (kind == "mask") GreenToGray(resized);
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
            JArray? text = null;
            JArray? plant = null;
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
                text = TextFaces(provider, scriptClass);
                plant = PlantSlot(provider, scriptClass);
            }
            if (parts.Count == 0) Console.WriteLine($"building {key}: no meshes");
            var entry = new JObject
            {
                ["name"] = strings.Resolve(row["DisplayName"]) ?? key,
                ["parts"] = parts,
            };
            var secondary = row["SecondaryType"]?.ToString().Split("::").Last();
            if (secondary != null && ShapeTables.ContainsKey(secondary)) entry["shapes"] = secondary;
            if (text is { Count: > 0 }) entry["text"] = text;
            if (plant != null) entry["plant"] = plant;
            // Its height in whole layers, as the game builds with it: its top, to the nearest layer
            // (a cauldron's rim pokes 1 unit over its two; an athanor stands 2.84 high).
            var top = Top(parts, meshBounds);
            entry["layers"] = Math.Max(1, (int)Math.Round(top / 25));
            // Where items go through a ramp, drawbridge, tunnel or lift, or each section of a retractable
            // conveyor passage: for the X-ray's arrows.
            if ((secondary is "BeltSlope" or "ConveyerLift" || key.StartsWith("ExpandableConveyorTunnel"))
                && Ports(row["InOutList"]) is { Count: > 0 } ports)
            {
                entry["ports"] = ports;
                entry["top"] = Math.Round(top, 1);
            }
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

        // The plant each seed grows in a nursery, grown. (The table's TreeStage rows are the World
        // Tree Nursery's, which goes through them by itself: a blueprint doesn't save one.)
        var seeds = new JObject();
        foreach (var (key, row) in Rows(provider, SeedsTable))
            if (!key.StartsWith("TreeStage") && ObjectPath(row["PlantMesh"]) is { } plantMesh && Mesh(plantMesh) is { } mesh)
                seeds[key] = mesh;

        var manifest = new JObject
        {
            ["buildings"] = buildings,
            ["shapes"] = shapes,
            ["seeds"] = seeds,
            ["meshes"] = meshes,
            ["materials"] = materials,
        };
        File.WriteAllText(Path.Combine(outDir, "manifest.json"), manifest.ToString(Formatting.None));

        // The face of the font notice boards write in: the game's "NotoSans" font, whose Regular is
        // Winky Sans. A .ufont is the font file (a TrueType) as an array: its length (int32), then it.
        if (!provider.TrySaveAsset(SignFont, out var font)) throw new InvalidOperationException($"Couldn't read {SignFont}");
        File.WriteAllBytes(Path.Combine(outDir, "WinkySans-Regular.ttf"), font[4..(4 + BitConverter.ToInt32(font, 0))]);

        CompressMeshes(webDir, plainDir, meshDir);
        Directory.Delete(plainDir, true);

        long Size(string dir) => new DirectoryInfo(dir).GetFiles().Sum(f => f.Length);
        Console.WriteLine($"Wrote {buildings.Count} buildings, {shapes.Properties().Sum(t => ((JObject)t.Value).Count)} belt and pipe shapes, {meshes.Count} meshes " +
            $"({Size(meshDir) / 1024} KB), {textures.Count(t => t.Value != null)} textures ({Size(textureDir) / 1024} KB) to {outDir}");
    }

    /// <summary>
    /// A building's belt ports: the cell (from its origin, before its turn) items come in at, the
    /// sides of it they come in by (`in`) and go out by (`out`: r(ight, +x), b(ottom, +y), l(eft),
    /// u(p)), and the cell they go out from, `offset` from it (a ramp's one along and one up).
    /// </summary>
    static JArray Ports(JToken? inOutList)
    {
        var ports = new JArray();
        foreach (var p in inOutList ?? new JArray())
        {
            string Sides(string way) => string.Concat(new[] { ("Right", "r"), ("Bottom", "b"), ("Left", "l"), ("Up", "u") }
                .Where(s => p[s.Item1]?[way]?.Value<bool>() == true).Select(s => s.Item2));
            var (ins, outs) = (Sides("IsInput"), Sides("IsOutput"));
            if (ins.Length + outs.Length == 0) continue;
            JArray Cell(JToken? c) => new(c?["X"] ?? 0, c?["Y"] ?? 0, c?["Z"] ?? 0);
            ports.Add(new JObject { ["at"] = Cell(p["position"]), ["in"] = ins, ["out"] = outs, ["offset"] = Cell(p["OffsetOutput"]) });
        }
        return ports;
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
        if (!m.IsIdentity) part["matrix"] = MatrixJson(m);
        if (materials?.Any(x => x != null) == true) part["materials"] = new JArray(materials);
        return part;
    }

    /// Row-major, for Unreal's row vectors: read column-major, it's three.js's matrix for column vectors.
    static JArray MatrixJson(Matrix4x4 m) =>
        new(new[] { m.M11, m.M12, m.M13, m.M14, m.M21, m.M22, m.M23, m.M24, m.M31, m.M32, m.M33, m.M34, m.M41, m.M42, m.M43, m.M44 }
            .Select(v => Math.Round(v, 4)));

    /// <summary>
    /// The static meshes a building Blueprint's construction script adds, with their transforms from
    /// the actor and their override materials (null: the mesh's own).
    /// </summary>
    static List<(string Mesh, Matrix4x4 Transform, List<string?> Materials)> BlueprintMeshes(DefaultFileProvider provider, string classPath)
    {
        var result = new List<(string, Matrix4x4, List<string?>)>();
        foreach (var (props, transform) in BlueprintComponents(provider, classPath))
        {
            if (ObjectPath(props["StaticMesh"]) is not { } meshPath) continue;
            if (props["bVisible"]?.Value<bool>() == false || props["bHiddenInGame"]?.Value<bool>() == true) continue;
            // A catapult's landing area, which the game shows only while placing one.
            if (ObjectName(meshPath).Contains("AreaIndicator")) continue;
            var overrides = (props["OverrideMaterials"] ?? new JArray()).Select(ObjectPath).ToList();
            result.Add((meshPath, transform, overrides));
        }
        return result;
    }

    /// <summary>
    /// Where a notice board shows the words written on it: a face for each of its widgets of
    /// WBP_NoticeBoardText, with its transform from the actor and its size in the widget's pixels.
    /// The widget faces its +x, its width running along −y and its height down z, round its middle.
    /// </summary>
    static JArray TextFaces(DefaultFileProvider provider, string classPath)
    {
        var faces = new JArray();
        foreach (var (props, transform) in BlueprintComponents(provider, classPath))
        {
            if (props["WidgetClass"]?["ObjectName"]?.ToString().Contains("WBP_NoticeBoardText") != true) continue;
            var size = props["DrawSize"];
            faces.Add(new JObject
            {
                ["matrix"] = MatrixJson(transform),
                ["size"] = new JArray(size?["X"]?.Value<float>() ?? 500, size?["Y"]?.Value<float>() ?? 500),
            });
        }
        return faces;
    }

    /// <summary>
    /// Where a nursery grows its plant: the transform from the actor of its empty mesh component
    /// tagged PlantMesh, which the game fills with the planted seed's PlantMesh (null: it has none).
    /// </summary>
    static JArray? PlantSlot(DefaultFileProvider provider, string classPath)
    {
        foreach (var (props, transform) in BlueprintComponents(provider, classPath))
            if (props["ComponentTags"]?.Any(t => t.ToString() == "PlantMesh") == true)
                return MatrixJson(transform);
        return null;
    }

    /// <summary>
    /// The components a building Blueprint's construction script adds: each one's properties, and its
    /// transform from the actor. A node's transform is relative to its parent node; a root node can
    /// hang off a component named by ParentComponentOrVariableName.
    ///
    /// A child Blueprint (a Blueprint whose Super is one) has its parent's components, with the
    /// properties it changes on them (its InheritableComponentHandler's templates, which hold only
    /// those), and any of its own.
    /// </summary>
    static List<(JObject Props, Matrix4x4 Transform)> BlueprintComponents(DefaultFileProvider provider, string classPath)
    {
        var nodes = ConstructionNodes(provider, classPath, 0);
        var byVariable = nodes.ToDictionary(n => n.Variable);
        Matrix4x4 World(Node node, int depth = 0) =>
            depth <= 32 && node.Parent is { } parent && byVariable.TryGetValue(parent, out var up)
                ? Relative(node.Props) * World(up, depth + 1)
                : Relative(node.Props);
        return nodes.Select(n => (n.Props, World(n))).ToList();
    }

    record Node(string Variable, string? Parent, JObject Props);

    static List<Node> ConstructionNodes(DefaultFileProvider provider, string classPath, int depth)
    {
        var nodes = new List<Node>();
        if (depth > 8 || !provider.TryLoadPackage(PackagePath(classPath) + ".uasset", out var pkg)) return nodes;
        var exports = JArray.FromObject(pkg.GetExports(), JsonSerializer.Create());
        var byName = exports.Where(e => e["Name"] != null).GroupBy(e => e["Name"]!.ToString()).ToDictionary(g => g.Key, g => (JObject)g.First());
        static string RefName(JToken? r) => r?["ObjectName"]?.ToString().Split(':', '.').Last().TrimEnd('\'') ?? "";
        JObject Template(JToken? reference) =>
            byName.TryGetValue(RefName(reference), out var template) && template["Properties"] is JObject props ? props : new JObject();

        var generated = exports.FirstOrDefault(e => e["Type"]?.ToString() == "BlueprintGeneratedClass");
        if (ObjectPath(generated?["Super"]) is { } super && super.StartsWith("/Game/"))
        {
            nodes = ConstructionNodes(provider, super, depth + 1);
            foreach (var record in exports.Where(e => e["Type"]?.ToString() == "InheritableComponentHandler").SelectMany(e => e["Properties"]?["Records"] ?? new JArray()))
            {
                var at = nodes.FindIndex(n => n.Variable == record["ComponentKey"]?["SCSVariableName"]?.ToString());
                if (at < 0) continue;
                var merged = (JObject)nodes[at].Props.DeepClone();
                merged.Merge(Template(record["ComponentTemplate"]), new JsonMergeSettings { MergeArrayHandling = MergeArrayHandling.Replace });
                nodes[at] = nodes[at] with { Props = merged };
            }
        }

        var scsNodes = exports.Where(e => e["Type"]?.ToString() == "SCS_Node").Cast<JObject>().ToList();
        string Variable(JObject node) => node["Properties"]?["InternalVariableName"]?.ToString() ?? node["Name"]!.ToString();
        var parentOf = new Dictionary<string, string>();
        foreach (var node in scsNodes)
            foreach (var child in node["Properties"]?["ChildNodes"] ?? new JArray())
                if (byName.TryGetValue(RefName(child), out var childNode))
                    parentOf[Variable(childNode)] = Variable(node);
        foreach (var node in scsNodes)
        {
            var variable = Variable(node);
            // A child's own root, where its parent has one already.
            if (nodes.Any(n => n.Variable == variable)) continue;
            var parent = parentOf.GetValueOrDefault(variable) ?? node["Properties"]?["ParentComponentOrVariableName"]?.ToString();
            nodes.Add(new Node(variable, parent, Template(node["Properties"]?["ComponentTemplate"])));
        }
        return nodes;
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
