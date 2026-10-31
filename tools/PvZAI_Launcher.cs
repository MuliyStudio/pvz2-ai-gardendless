using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace PvZAI
{
    class Program
    {
        const int CdpPort = 9222;
        internal static readonly JavaScriptSerializer Ser = new JavaScriptSerializer();
        static readonly string Version = "1.0.1";

        [STAThread]
        static void Main(string[] args)
        {
            try { Console.OutputEncoding = Encoding.UTF8; } catch { }
            Console.Title = "PvZ2 Gardendless - AI 启动器 v" + Version;
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            bool dry = HasArg(args, "--dry-run");
            bool installOnly = HasArg(args, "--install-only");

            Console.WriteLine("========================================");
            Console.WriteLine(" PvZ2 Gardendless - AI 启动器 v" + Version);
            Console.WriteLine("========================================");
            Console.WriteLine();

            string game = FindGame(args, baseDir);
            if (string.IsNullOrEmpty(game))
            {
                Console.WriteLine("❌ 没找到游戏 EXE（pvzge-*.exe）。");
                Console.WriteLine("   请把游戏 EXE 拖到本启动器上，或双击后在弹窗里选择。");
                Pause();
                return;
            }
            Console.WriteLine("游戏：" + game);
            SaveIni(baseDir, game);

            if (dry)
            {
                int pages = GetPages() == null ? 0 : GetPages().Length;
                Console.WriteLine("dry-run：游戏进程" + (GameRunning() ? "正在运行" : "未运行") + "，调试页面 " + pages + " 个。");
                return;
            }

            if (installOnly)
            {
                try { InstallMod(baseDir); } catch (Exception ex) { Console.WriteLine("❌ 自动安装失败：" + ex.Message); }
                Pause();
                return;
            }

            bool debug = GetPages() != null;
            if (!debug && GameRunning())
            {
                Console.WriteLine();
                Console.WriteLine("❌ 检测到游戏正在运行，但没有开启调试端口。");
                Console.WriteLine("   请先完全退出游戏，再重新双击本启动器。");
                Console.WriteLine("   （直接双击游戏 EXE 启动不会解除 CSP，必须用本启动器。）");
                Pause();
                return;
            }

            if (!debug)
            {
                try { InstallMod(baseDir); }
                catch (Exception ex)
                {
                    Console.WriteLine("⚠️ 自动安装模组失败：" + ex.Message);
                    Console.WriteLine("   请手动在 GP-Next 里导入 pvz-ai-agent.zip。");
                }

                Console.WriteLine("启动游戏（带调试端口）...");
                try { StartGame(game); }
                catch (Exception ex)
                {
                    Console.WriteLine("❌ 启动失败：" + ex.Message);
                    Console.WriteLine("   如果提示权限不足，请右键“以管理员身份运行”。");
                    Pause();
                    return;
                }
            }
            else
            {
                Console.WriteLine("检测到已有调试端口，复用当前游戏进程。");
            }

            Console.WriteLine("等待游戏 WebView2 启动（最多 90 秒）...");
            StartProxy();
            string pageId = null;
            Cdp cdp = null;
            for (int i = 0; i < 90; i++)
            {
                try { cdp = Ensure(cdp, ref pageId); }
                catch { cdp = null; }
                if (cdp != null) break;
                Thread.Sleep(1000);
            }
            if (cdp == null)
            {
                Console.WriteLine("❌ 没连上游戏页面。");
                Console.WriteLine("   请确认游戏已启动，且没有其它程序占用 9222 端口。");
                Pause();
                return;
            }

            Console.WriteLine("已连接游戏页面，解除 CSP ...");
            cdp.Send("Page.setBypassCSP", Dict("enabled", true));
            Console.WriteLine("重载页面（会回到主菜单）...");
            try { cdp.Send("Page.reload", Dict("ignoreCache", true)); } catch { }
            Thread.Sleep(6000);
            try { cdp.Dispose(); } catch { }
            cdp = null;

            for (int i = 0; i < 30; i++)
            {
                try { cdp = Ensure(null, ref pageId); } catch { cdp = null; }
                if (cdp != null) break;
                Thread.Sleep(1000);
            }
            if (cdp != null)
            {
                try { cdp.Send("Page.setBypassCSP", Dict("enabled", true)); } catch { }
            }

            Console.WriteLine();
            Console.WriteLine("✅ CSP 已绕过，AI 现在可以正常调用大模型接口了。");
            Console.WriteLine();
            Console.WriteLine("首次使用：");
            Console.WriteLine("  1. 游戏里按 F9 打开 GP-Next → 确认已启用「PvZ LLM Agent」");
            Console.WriteLine("  2. 右上角浮窗选服务商：DeepSeek 官方 / OpenCode Go（本地代理）");
            Console.WriteLine("  3. 填 API Key → 测试连接 → 开始 AI（F8）");
            Console.WriteLine("  4. OpenCode Go 需要到 opencode.ai/console 取 Key，并在 Privacy 里把 Regions 设为 Global");
            Console.WriteLine();
            Console.WriteLine("OpenCode Go 已由本启动器自动代理（127.0.0.1:8787），不用另开脚本。");
            Console.WriteLine("请保持此窗口打开（可以最小化），关闭后 CSP 和代理都会失效。");
            Console.WriteLine();

            int fail = 0;
            while (true)
            {
                Thread.Sleep(8000);
                try
                {
                    cdp = Ensure(cdp, ref pageId);
                    if (cdp != null)
                    {
                        cdp.Send("Page.setBypassCSP", Dict("enabled", true));
                        fail = 0;
                    }
                    else if (fail++ % 5 == 0)
                    {
                        Console.WriteLine("等待游戏页面...");
                    }
                }
                catch (Exception ex)
                {
                    if (fail++ % 5 == 0) Console.WriteLine("重新应用失败：" + ex.Message);
                    try { if (cdp != null) cdp.Dispose(); } catch { }
                    cdp = null;
                }
            }
        }

        static Dictionary<string, object> Dict(string key, object value)
        {
            var d = new Dictionary<string, object>();
            d[key] = value;
            return d;
        }

        static bool HasArg(string[] args, string name)
        {
            foreach (var a in args) if (a == name) return true;
            return false;
        }

        static string ArgValue(string[] args, string name)
        {
            for (int i = 0; i < args.Length - 1; i++) if (args[i] == name) return args[i + 1];
            return null;
        }

        static string S(Dictionary<string, object> d, string key)
        {
            object v;
            return d != null && d.TryGetValue(key, out v) && v != null ? Convert.ToString(v) : "";
        }

        static string HttpGet(string url)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(url);
                req.Timeout = 3000;
                req.ReadWriteTimeout = 3000;
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (var sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                    return sr.ReadToEnd();
            }
            catch { return null; }
        }

        static object[] GetPages()
        {
            string json = HttpGet("http://127.0.0.1:" + CdpPort + "/json");
            if (string.IsNullOrEmpty(json)) return null;
            try { return Ser.DeserializeObject(json) as object[]; }
            catch { return null; }
        }

        static Dictionary<string, object> PickPage(object[] pages)
        {
            if (pages == null) return null;
            Dictionary<string, object> fallback = null;
            foreach (var o in pages)
            {
                var p = o as Dictionary<string, object>;
                if (p == null || S(p, "type") != "page") continue;
                string title = S(p, "title");
                string url = S(p, "url");
                string s = (title + " " + url).ToLowerInvariant();
                if (s.Contains("cocos") || s.Contains("gardendless") || s.Contains("pvz")) return p;
                if (url == "http://tauri.localhost/" || url == "https://tauri.localhost/") return p;
                if (s.Contains("tauri.localhost") && !s.Contains("cloud.html") && fallback == null) fallback = p;
                if (fallback == null) fallback = p;
            }
            return fallback;
        }

        static Cdp Ensure(Cdp current, ref string pageId)
        {
            var page = PickPage(GetPages());
            if (page == null) return null;
            string id = S(page, "id");
            if (current != null && current.Alive && pageId == id) return current;
            if (current != null) { try { current.Dispose(); } catch { } }
            string wsUrl = S(page, "webSocketDebuggerUrl");
            if (string.IsNullOrEmpty(wsUrl)) return null;
            var c = new Cdp(wsUrl, id);
            pageId = id;
            c.Send("Page.enable", new Dictionary<string, object>());
            c.Send("Page.setBypassCSP", Dict("enabled", true));
            // 给页面留一个"由启动器启动"的标记：游戏内浮窗靠它判断要不要提示用启动器。
            // addScript 在下次导航前生效（下面会 Page.reload），Runtime.evaluate 覆盖当前页面。
            try { c.Send("Page.addScriptToEvaluateOnNewDocument", Dict("source", LauncherMark())); } catch { }
            try { c.Send("Runtime.evaluate", Dict("expression", LauncherMark())); } catch { }
            return c;
        }

        static string LauncherMark()
        {
            return "window.__PVZAI_LAUNCHER__='" + Version + "';";
        }

        static bool GameRunning()
        {
            foreach (var p in Process.GetProcesses())
            {
                try { if (p.ProcessName.ToLowerInvariant().Contains("pvzge")) return true; }
                catch { }
            }
            return false;
        }

        static string FindGame(string[] args, string baseDir)
        {
            string explicitPath = ArgValue(args, "--game");
            if (string.IsNullOrEmpty(explicitPath) && args.Length > 0 && args[0].ToLowerInvariant().EndsWith(".exe") && File.Exists(args[0]))
                explicitPath = args[0];
            if (!string.IsNullOrEmpty(explicitPath) && File.Exists(explicitPath)) return explicitPath;

            string ini = Path.Combine(baseDir, "launcher.ini");
            if (File.Exists(ini))
            {
                try
                {
                    foreach (var line in File.ReadAllLines(ini))
                    {
                        if (line.StartsWith("game="))
                        {
                            string p = line.Substring(5).Trim();
                            if (File.Exists(p)) return p;
                        }
                    }
                }
                catch { }
            }

            var dirs = new List<string>();
            dirs.Add(baseDir);
            dirs.Add(Environment.GetFolderPath(Environment.SpecialFolder.Desktop));
            dirs.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads"));
            dirs.Add("C:\\软件");
            foreach (var d in dirs)
            {
                if (string.IsNullOrEmpty(d) || !Directory.Exists(d)) continue;
                try
                {
                    foreach (var f in Directory.GetFiles(d, "pvzge*.exe", SearchOption.TopDirectoryOnly)) return f;
                    foreach (var sub in Directory.GetDirectories(d))
                    {
                        try
                        {
                            foreach (var f in Directory.GetFiles(sub, "pvzge*.exe", SearchOption.TopDirectoryOnly)) return f;
                        }
                        catch { }
                    }
                }
                catch { }
            }

            using (var dlg = new OpenFileDialog())
            {
                dlg.Title = "请选择 PvZ2 Gardendless 游戏 EXE（pvzge-*.exe）";
                dlg.Filter = "PvZ2 Gardendless (pvzge*.exe)|pvzge*.exe|EXE (*.exe)|*.exe";
                if (dlg.ShowDialog() == DialogResult.OK) return dlg.FileName;
            }
            return null;
        }

        static void SaveIni(string baseDir, string game)
        {
            try { File.WriteAllText(Path.Combine(baseDir, "launcher.ini"), "game=" + game + Environment.NewLine, Encoding.UTF8); }
            catch { }
        }

        static string FindGpNextRoot()
        {
            string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            string gpRoot = Path.Combine(appData, "com.pvzge.game", "gp-next");
            if (Directory.Exists(gpRoot)) return gpRoot;
            try
            {
                foreach (var d in Directory.GetDirectories(appData))
                {
                    if (Directory.Exists(Path.Combine(d, "gp-next"))) return Path.Combine(d, "gp-next");
                }
            }
            catch { }
            return null;
        }

        // GP-Next 的 pack 快照摘要：前缀 + 按文件名排序的 (名字长度, 内容长度, 名字, 内容)，SHA256。
        static string ComputePackDigest(string dir)
        {
            var files = new List<string>();
            var walk = (Action<string, string>)null;
            walk = (cur, rel) =>
            {
                foreach (var full in Directory.GetFiles(cur))
                {
                    var name = Path.GetFileName(full);
                    files.Add(string.IsNullOrEmpty(rel) ? name : rel + "/" + name);
                }
                foreach (var sub in Directory.GetDirectories(cur))
                {
                    var name = Path.GetFileName(sub);
                    walk(sub, string.IsNullOrEmpty(rel) ? name : rel + "/" + name);
                }
            };
            walk(dir, "");
            files.Sort(StringComparer.Ordinal);

            using (var sha = SHA256.Create())
            using (var ms = new MemoryStream())
            {
                byte[] prefix = Encoding.UTF8.GetBytes("gp-next-pack-snapshot-v1\0");
                ms.Write(prefix, 0, prefix.Length);
                foreach (var rel in files)
                {
                    byte[] nameBytes = Encoding.UTF8.GetBytes(rel);
                    byte[] content = File.ReadAllBytes(Path.Combine(dir, rel.Replace('/', Path.DirectorySeparatorChar)));
                    byte[] head = new byte[12];
                    head[0] = (byte)(nameBytes.Length >> 24);
                    head[1] = (byte)(nameBytes.Length >> 16);
                    head[2] = (byte)(nameBytes.Length >> 8);
                    head[3] = (byte)nameBytes.Length;
                    ulong len = (ulong)content.Length;
                    for (int i = 0; i < 8; i++) head[4 + i] = (byte)(len >> (8 * (7 - i)));
                    ms.Write(head, 0, head.Length);
                    ms.Write(nameBytes, 0, nameBytes.Length);
                    ms.Write(content, 0, content.Length);
                }
                return BitConverter.ToString(sha.ComputeHash(ms.ToArray())).Replace("-", "").ToLowerInvariant();
            }
        }

        static void CopyDirectory(string src, string dst)
        {
            Directory.CreateDirectory(dst);
            foreach (var f in Directory.GetFiles(src))
                File.Copy(f, Path.Combine(dst, Path.GetFileName(f)), true);
            foreach (var d in Directory.GetDirectories(src))
                CopyDirectory(d, Path.Combine(dst, Path.GetFileName(d)));
        }

        // 清掉上一次事务的 journal / recovery 绑定。安装新包后如果还指着旧 revision，
        // GP-Next 会在 beforeEngineImport 报 Invalid journal binding 并崩溃。
        static bool ClearTransientState(Dictionary<string, object> root)
        {
            bool changed = false;
            foreach (var key in new[] { "journal", "recovery", "failedEntityTargets" })
                if (root.Remove(key)) changed = true;
            return changed;
        }

        static void SaveConfig(string cfgPath, Dictionary<string, object> root)
        {
            string outgoing = Ser.Serialize(root);
            File.Copy(cfgPath, cfgPath + ".bak-before-launcher", true);
            string tmp = cfgPath + ".tmp";
            File.WriteAllText(tmp, outgoing, new UTF8Encoding(false));
            File.Delete(cfgPath);
            File.Move(tmp, cfgPath);
        }

        // 把包注册进 configuration-state.json，让 GP-Next 下次启动直接启用它。
        static bool RegisterPack(string gpRoot, string uuid, string version, string digest, string name)
        {
            string cfgPath = Path.Combine(gpRoot, "configuration-state.json");
            if (!File.Exists(cfgPath)) return false;
            try
            {
                var root = (Dictionary<string, object>)Ser.DeserializeObject(File.ReadAllText(cfgPath, Encoding.UTF8));
                var desired = root["desired"] as Dictionary<string, object>;
                var active = root["active"] as Dictionary<string, object>;
                if (desired == null || active == null) return false;
                bool transientCleared = ClearTransientState(root);

                // 已经是这个版本且启用，就不重复改写配置
                var current = desired["mods"] as object[];
                if (current != null)
                {
                    foreach (var m in current)
                    {
                        var mm = m as Dictionary<string, object>;
                        if (mm == null) continue;
                        if (Convert.ToString(mm["id"]) != uuid) continue;
                        if (Convert.ToString(mm["contentDigest"]) != digest) continue;
                        if (!Convert.ToBoolean(mm["enabled"])) continue;

                        bool inActive = false;
                        var pkgs = active["packages"] as object[];
                        if (pkgs != null)
                        {
                            foreach (var p in pkgs)
                            {
                                var pp = p as Dictionary<string, object>;
                                if (pp != null && Convert.ToString(pp["id"]) == uuid && Convert.ToString(pp["contentDigest"]) == digest) { inActive = true; break; }
                            }
                        }
                        var ordered = active["ordered"] as object[];
                        bool inOrdered = ordered != null && ordered.Length == 1 && Convert.ToString(ordered[0]) == uuid;
                        if (inActive && inOrdered)
                        {
                            if (transientCleared)
                            {
                                root["sequence"] = Convert.ToInt32(root["sequence"]) + 1;
                                SaveConfig(cfgPath, root);
                            }
                            return true;
                        }
                    }
                }

                desired["revision"] = Convert.ToInt32(desired["revision"]) + 1;

                var mods = new List<object>();
                bool replaced = false;
                var existing = desired["mods"] as object[];
                if (existing != null)
                {
                    foreach (var m in existing)
                    {
                        var mm = m as Dictionary<string, object>;
                        if (mm != null && Convert.ToString(mm["id"]) == uuid)
                        {
                            mm["version"] = version;
                            mm["contentDigest"] = digest;
                            mm["enabled"] = true;
                            mm["fallbackName"] = name;
                            mm["legacy"] = false;
                            mm["runtimeNamespace"] = uuid;
                            if (mm["settings"] == null) mm["settings"] = new Dictionary<string, object>();
                            replaced = true;
                        }
                        mods.Add(m);
                    }
                }
                if (!replaced)
                {
                    mods.Add(new Dictionary<string, object> {
                        { "id", uuid }, { "version", version }, { "contentDigest", digest },
                        { "fallbackName", name }, { "runtimeNamespace", uuid }, { "legacy", false },
                        { "enabled", true }, { "settings", new Dictionary<string, object>() },
                    });
                }
                desired["mods"] = mods.ToArray();

                active["configuration"] = desired;
                active["packages"] = new object[] {
                    new Dictionary<string, object> {
                        { "id", uuid }, { "version", version }, { "contentDigest", digest },
                        { "fallbackName", name }, { "runtimeNamespace", uuid }, { "legacy", false },
                        { "enabled", true }, { "settings", new Dictionary<string, object>() },
                        { "depends", new object[0] }, { "optionalDepends", new object[0] },
                    }
                };
                active["ordered"] = new object[] { uuid };
                active["generation"] = Convert.ToInt32(active["generation"]) + 1;
                root["sequence"] = Convert.ToInt32(root["sequence"]) + 1;

                SaveConfig(cfgPath, root);
                return true;
            }
            catch (Exception ex)
            {
                Console.WriteLine("⚠️ 更新 GP-Next 配置失败：" + ex.Message);
                return false;
            }
        }

        static void InstallMod(string baseDir)
        {
            string zip = Path.Combine(baseDir, "pvz-llm-agent.zip");
            if (!File.Exists(zip))
            {
                if (File.Exists(Path.Combine(baseDir, "pvz-ai-agent.zip")))
                    Console.WriteLine("⚠️ 目录里只有旧模组 pvz-ai-agent.zip；请换成 pvz-llm-agent.zip。");
                else
                    Console.WriteLine("未找到 pvz-llm-agent.zip，跳过自动安装。");
                return;
            }

            string gpRoot = FindGpNextRoot();
            if (gpRoot == null)
            {
                Console.WriteLine("没找到 GP-Next 目录，跳过自动安装；请在游戏里手动导入。");
                return;
            }

            string temp = Path.Combine(Path.GetTempPath(), "pvzllm-pack-" + Guid.NewGuid().ToString("N"));
            try
            {
                ZipFile.ExtractToDirectory(zip, temp);
                string packPath = Path.Combine(temp, "pack.json");
                if (!File.Exists(packPath))
                    throw new Exception("ZIP 里没有 pack.json，安装包可能不完整。");

                string digest = ComputePackDigest(temp);
                string dest = Path.Combine(gpRoot, "installed", digest);
                if (!Directory.Exists(dest))
                {
                    Directory.CreateDirectory(dest);
                    CopyDirectory(temp, dest);
                }

                var pack = (Dictionary<string, object>)Ser.DeserializeObject(File.ReadAllText(packPath, Encoding.UTF8));
                string uuid = pack.ContainsKey("uuid") ? Convert.ToString(pack["uuid"]) : "";
                string version = pack.ContainsKey("version") ? Convert.ToString(pack["version"]) : "";
                string name = pack.ContainsKey("name") ? Convert.ToString(pack["name"]) : uuid;
                if (string.IsNullOrEmpty(uuid)) throw new Exception("pack.json 缺少 uuid");

                bool ok = RegisterPack(gpRoot, uuid, version, digest, name);
                Console.WriteLine("模组已就位：" + uuid + " v" + version + "  (" + digest.Substring(0, 12) + "…)");
                Console.WriteLine(ok
                    ? "已在 GP-Next 配置中启用，重载页面后生效。"
                    : "⚠️ 未能写入 GP-Next 配置，请在游戏里手动导入一次 pvz-llm-agent.zip。");
            }
            finally
            {
                try { if (Directory.Exists(temp)) Directory.Delete(temp, true); } catch { }
            }
        }

        static void StartGame(string game)
        {
            var psi = new ProcessStartInfo();
            psi.FileName = game;
            psi.WorkingDirectory = Path.GetDirectoryName(game);
            psi.UseShellExecute = false;
            psi.EnvironmentVariables["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = "--remote-debugging-port=" + CdpPort + " --remote-allow-origins=*";
            Process.Start(psi);
        }

        // ── 本地 LLM 代理 ────────────────────────────────────────────────
        // OpenCode Go 的 chat 接口不返回 CORS 头，WebView2 里直连会报 Failed to fetch。
        // 启动器顺手起一个本机代理，玩家不用额外操作；API Key 只从请求头透传，不落盘。
        const int ProxyPort = 8787;
        const string ProxyUpstream = "https://opencode.ai/inference/go/openai/v1";
        static HttpListener proxyListener;

        static void StartProxy()
        {
            try
            {
                proxyListener = new HttpListener();
                proxyListener.Prefixes.Add("http://127.0.0.1:" + ProxyPort + "/");
                proxyListener.Prefixes.Add("http://localhost:" + ProxyPort + "/");
                proxyListener.Start();
            }
            catch (Exception ex)
            {
                Console.WriteLine("⚠️ 本地代理未启动（端口 " + ProxyPort + "）：" + ex.Message);
                Console.WriteLine("   如果只是用 DeepSeek 官方，可以忽略；要用 OpenCode Go 需要代理。");
                try { if (proxyListener != null) proxyListener.Close(); } catch { }
                proxyListener = null;
                return;
            }

            var thread = new Thread(() =>
            {
                while (proxyListener != null && proxyListener.IsListening)
                {
                    HttpListenerContext ctx;
                    try { ctx = proxyListener.GetContext(); }
                    catch { break; }
                    ThreadPool.QueueUserWorkItem(_ => { try { HandleProxy(ctx); } catch { } });
                }
            });
            thread.IsBackground = true;
            thread.Start();
            Console.WriteLine("本地代理已启动：http://127.0.0.1:" + ProxyPort + "/v1  ->  " + ProxyUpstream);
        }

        static void StopProxy()
        {
            try { if (proxyListener != null) { proxyListener.Stop(); proxyListener.Close(); } } catch { }
            proxyListener = null;
        }

        static void HandleProxy(HttpListenerContext ctx)
        {
            var req = ctx.Request;
            var res = ctx.Response;
            res.AddHeader("Access-Control-Allow-Origin", "*");
            res.AddHeader("Access-Control-Allow-Headers", "authorization,content-type,x-opencode-session");
            res.AddHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
            res.AddHeader("Access-Control-Max-Age", "86400");

            try
            {
                if (req.HttpMethod == "OPTIONS")
                {
                    res.StatusCode = 204;
                    res.Close();
                    return;
                }

                string path = req.Url.AbsolutePath;
                if (!path.StartsWith("/v1/"))
                {
                    res.StatusCode = 404;
                    WriteAscii(res, "{\"error\":{\"message\":\"代理只接受 /v1/* 路径\"}}");
                    res.Close();
                    return;
                }

                string target = ProxyUpstream + path.Substring(3) + req.Url.Query;
                var outReq = (HttpWebRequest)WebRequest.Create(target);
                outReq.Method = req.HttpMethod;
                outReq.ContentType = string.IsNullOrEmpty(req.ContentType) ? "application/json" : req.ContentType;
                outReq.AllowReadStreamBuffering = false;
                outReq.Timeout = 120000;
                outReq.ReadWriteTimeout = 300000;
                string auth = req.Headers["Authorization"];
                if (!string.IsNullOrEmpty(auth)) outReq.Headers["Authorization"] = auth;
                string session = req.Headers["x-opencode-session"];
                outReq.Headers["x-opencode-session"] = string.IsNullOrEmpty(session) ? "pvzllm-launcher" : session;

                if (req.HasEntityBody)
                {
                    using (var buffer = new MemoryStream())
                    {
                        req.InputStream.CopyTo(buffer);
                        byte[] body = buffer.ToArray();
                        outReq.ContentLength = body.Length;
                        using (var s = outReq.GetRequestStream()) s.Write(body, 0, body.Length);
                    }
                }

                HttpWebResponse outRes = null;
                try { outRes = (HttpWebResponse)outReq.GetResponse(); }
                catch (WebException we) { outRes = we.Response as HttpWebResponse; if (outRes == null) throw; }

                using (outRes)
                {
                    res.StatusCode = (int)outRes.StatusCode;
                    res.ContentType = string.IsNullOrEmpty(outRes.ContentType) ? "application/json" : outRes.ContentType;
                    using (var src = outRes.GetResponseStream())
                    {
                        var buf = new byte[8192];
                        int n;
                        while (src != null && (n = src.Read(buf, 0, buf.Length)) > 0)
                        {
                            res.OutputStream.Write(buf, 0, n);
                            res.OutputStream.Flush();   // SSE 需要逐块送达
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                try
                {
                    res.StatusCode = 502;
                    WriteAscii(res, "{\"error\":{\"message\":\"代理转发失败：" + EscapeJson(ex.Message) + "\"}}");
                }
                catch { }
            }
            finally
            {
                try { res.Close(); } catch { }
            }
        }

        static void WriteAscii(HttpListenerResponse res, string text)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(text);
            res.ContentType = "application/json; charset=utf-8";
            res.ContentLength64 = bytes.Length;
            res.OutputStream.Write(bytes, 0, bytes.Length);
        }

        static string EscapeJson(string s)
        {
            return (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "").Replace("\n", " ");
        }

        static void Pause()
        {
            StopProxy();
            Console.WriteLine();
            Console.WriteLine("按回车退出...");
            try { Console.ReadLine(); } catch { }
        }
    }

    class Cdp : IDisposable
    {
        ClientWebSocket ws;
        int seq = 1;
        public string PageId;

        public Cdp(string wsUrl, string pageId)
        {
            PageId = pageId;
            ws = new ClientWebSocket();
            ws.ConnectAsync(new Uri(wsUrl), CancellationToken.None).Wait(10000);
        }

        public bool Alive
        {
            get { return ws != null && ws.State == WebSocketState.Open; }
        }

        public Dictionary<string, object> Send(string method, Dictionary<string, object> parameters)
        {
            int id = seq++;
            var msg = new Dictionary<string, object>();
            msg["id"] = id;
            msg["method"] = method;
            msg["params"] = parameters ?? new Dictionary<string, object>();
            string json = Program.Ser.Serialize(msg);
            byte[] bytes = Encoding.UTF8.GetBytes(json);
            ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None).Wait(10000);

            while (true)
            {
                string text = Receive();
                Dictionary<string, object> resp = null;
                try { resp = Program.Ser.DeserializeObject(text) as Dictionary<string, object>; }
                catch { }
                if (resp == null) continue;
                object rid;
                if (!resp.TryGetValue("id", out rid) || Convert.ToInt32(rid) != id) continue;
                object err;
                if (resp.TryGetValue("error", out err) && err != null) throw new Exception(Program.Ser.Serialize(err));
                object result;
                return resp.TryGetValue("result", out result) ? result as Dictionary<string, object> : null;
            }
        }

        string Receive()
        {
            var sb = new StringBuilder();
            var buf = new byte[1024 * 1024];
            while (true)
            {
                var r = ws.ReceiveAsync(new ArraySegment<byte>(buf), CancellationToken.None).Result;
                if (r.MessageType == WebSocketMessageType.Close) throw new Exception("CDP 连接已关闭");
                sb.Append(Encoding.UTF8.GetString(buf, 0, r.Count));
                if (r.EndOfMessage) break;
            }
            return sb.ToString();
        }

        public void Dispose()
        {
            try { ws.Dispose(); } catch { }
        }
    }
}
