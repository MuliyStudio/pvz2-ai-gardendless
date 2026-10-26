using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.WebSockets;
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
        static readonly string Version = "1.0.0";

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
            Console.WriteLine("  1. 游戏里按 F9 打开 GP-Next");
            Console.WriteLine("  2. 实验室 → JS Modding → 打开");
            Console.WriteLine("  3. 模组 → 保存并重载 → 勾选“AI 草坪指挥官”");
            Console.WriteLine("  4. 应用 / 重启，然后进入关卡");
            Console.WriteLine("  5. 右上角浮窗填 Key → 测试连接 → 开始操控");
            Console.WriteLine();
            Console.WriteLine("请保持此窗口打开（可以最小化），关闭后 CSP 修复可能失效。");
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
            return c;
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

        static void InstallMod(string baseDir)
        {
            string zip = Path.Combine(baseDir, "pvz-ai-agent.zip");
            if (!File.Exists(zip))
            {
                Console.WriteLine("未找到 pvz-ai-agent.zip，跳过自动安装。");
                return;
            }
            string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            string gpRoot = Path.Combine(appData, "com.pvzge.game", "gp-next");
            if (!Directory.Exists(Path.Combine(appData, "com.pvzge.game")))
            {
                try
                {
                    foreach (var d in Directory.GetDirectories(appData))
                    {
                        if (Directory.Exists(Path.Combine(d, "gp-next"))) { gpRoot = Path.Combine(d, "gp-next"); break; }
                    }
                }
                catch { }
            }
            string dest = Path.Combine(gpRoot, "packs", "pvzai.agent");
            Directory.CreateDirectory(dest);
            try
            {
                // 逐文件覆盖解压：游戏运行时也能更新大部分文件，不必先删整个目录。
                using (var archive = ZipFile.OpenRead(zip))
                {
                    foreach (var entry in archive.Entries)
                    {
                        string target = Path.Combine(dest, entry.FullName.Replace('/', Path.DirectorySeparatorChar));
                        if (string.IsNullOrEmpty(entry.Name))
                        {
                            Directory.CreateDirectory(target);
                            continue;
                        }
                        string dir = Path.GetDirectoryName(target);
                        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                        entry.ExtractToFile(target, true);
                    }
                }
            }
            catch (Exception ex)
            {
                try
                {
                    Directory.Delete(dest, true);
                    Directory.CreateDirectory(dest);
                    ZipFile.ExtractToDirectory(zip, dest);
                }
                catch
                {
                    throw new Exception("写入模组目录失败（请先关闭游戏再试）：" + ex.Message);
                }
            }
            if (!File.Exists(Path.Combine(dest, "pack.json")))
                throw new Exception("ZIP 里没有 pack.json，安装包可能不完整。");
            Console.WriteLine("模组已安装/更新到：" + dest);
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

        static void Pause()
        {
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
