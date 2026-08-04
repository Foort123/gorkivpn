// GORKIVPN loader — пранк-установщик «страшного вируса» (тёмный UI).
// Скачивает приложение с GitHub Releases, ставит в выбранную папку,
// создаёт ярлык на рабочем столе, запускает. Повторный запуск — мгновенный.
// Флаг --test-install <dir> ставит без окна (для проверки).
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Win32;

static class Loader {
    const string DEFAULT_URL =
        "https://github.com/Foort123/gorkivpn/releases/latest/download/GORKIVPN-win-x64.zip";

    const string SCARY =
        "GORKIVPN — самый опасный вирус в истории интернета.\r\n\r\n" +
        "В 2017 году он заразил более 3 000 000 компьютеров. Удалить его не смогли " +
        "ни антивирусы, ни спецслужбы.\r\n\r\n" +
        "Что делает GORKIVPN:\r\n" +
        "• читает каждое нажатие клавиш;\r\n" +
        "• крадёт пароли и переписку;\r\n" +
        "• включает веб-камеру без вашего ведома;\r\n" +
        "• маскируется под обычный VPN-клиент.\r\n\r\n" +
        "Вирус самовосстанавливается после любой попытки удаления. Единственный " +
        "способ избавиться — уничтожить компьютер.\r\n\r\n" +
        "Установка необратима.\r\n\r\n" +
        "Нажмите «Далее», чтобы продолжить.";

    const string BYE =
        "Нам очень жаль, что наш сервис не понравился вам, но ничего страшного — " +
        "спасибо за такие щедрые чаевые.\r\n\r\n" +
        "GORKIVPN удалён с этого компьютера.";

    const string FINAL =
        "Все ваши личные данные успешно скопированы и переданы злоумышленникам:\r\n" +
        "• пароли;\r\n" +
        "• фотографии;\r\n" +
        "• личные сообщения;\r\n" +
        "• история посещений.\r\n\r\n" +
        "Мы не несём ответственности за дальнейшее использование ваших данных.\r\n\r\n" +
        "Спасибо, что выбрали GORKIVPN!";

    static readonly string MarkerDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "GORKIVPN");
    static readonly string MarkerFile = Path.Combine(MarkerDir, "install_path.txt");
    static readonly string DefaultDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "GORKIVPN");

    [STAThread]
    static void Main(string[] args) {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        string url = ReadUrl();

        // uninstall.exe — та же программа, что и загрузчик, поэтому по двойному клику
        // она раньше показывала мастер установки. Режим удаления включаем и по флагу
        // из реестра, и просто по имени файла.
        bool uninstallMode = args.Length >= 1 && args[0] == "--uninstall";
        if (!uninstallMode) {
            try {
                uninstallMode = string.Equals(Path.GetFileName(Application.ExecutablePath),
                    "uninstall.exe", StringComparison.OrdinalIgnoreCase);
            } catch { }
        }
        if (uninstallMode) {
            Application.Run(new UninstallForm());
            Environment.Exit(0);
        }

        // Безоконная установка для проверки: GORKIVPN-loader.exe --test-install <папка>
        if (args.Length >= 2 && args[0] == "--test-install") {
            try {
                InstallTo(url, AppFolder(args[1]), null);
                Environment.Exit(0);
            } catch (Exception ex) {
                try { File.WriteAllText(args[1] + ".test.log", ex.ToString()); } catch { }
                Environment.Exit(1);
            }
        }

        // Загрузчик всегда показывает мастер, даже если GORKIVPN уже стоит:
        // раньше повторный запуск молча стартовал сам VPN, и переустановить
        // или сменить папку было нечем. Уже установленный путь просто подставляем.
        Application.Run(new LoaderForm(url, ReadInstalled()));
    }

    static string ReadUrl() {
        string cfg = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "config.txt");
        try {
            if (File.Exists(cfg)) {
                string line = File.ReadAllText(cfg).Trim();
                if (line.Length > 0) return line;
            }
        } catch { }
        return DEFAULT_URL;
    }

    static string ReadInstalled() {
        try {
            if (File.Exists(MarkerFile)) {
                string p = File.ReadAllText(MarkerFile).Trim();
                if (p.Length > 0 && Directory.Exists(p)) return p;
            }
        } catch { }
        return null;
    }

    // Умещает статичный текст в карточку без ползунка: уменьшает шрифт, пока текст не влезает
    static void FitText(RoundedBox box, string text) {
        float fs = box.FontSize;
        var area = new Size(box.Width - 34, box.Height - 26);
        while (fs > 7f) {
            var sz = TextRenderer.MeasureText(text, UiFont(fs, FontStyle.Regular), area,
                TextFormatFlags.WordBreak);
            if (sz.Height <= area.Height) break;
            fs -= 0.5f;
        }
        box.FontSize = fs;
    }

    // В диалоге выбирают родительскую папку (Рабочий стол, диск D:) — распаковывать
    // 78 файлов прямо в неё нельзя, поэтому приложение всегда кладём в подпапку GORKIVPN.
    static string AppFolder(string parent) {
        parent = (parent ?? "").TrimEnd('\\', '/');
        if (parent.Length == 0) return DefaultDir;
        if (string.Equals(Path.GetFileName(parent), "GORKIVPN", StringComparison.OrdinalIgnoreCase))
            return parent;
        return Path.Combine(parent, "GORKIVPN");
    }

    static void Launch(string exe) {
        try {
            Process.Start(new ProcessStartInfo(exe) { WorkingDirectory = Path.GetDirectoryName(exe) });
        } catch (Exception ex) {
            MessageBox.Show("Не удалось запустить GORKIVPN:\n" + ex.Message,
                "GORKIVPN", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    static int DirSizeKb(string dir) {
        try {
            long bytes = 0;
            foreach (var f in Directory.GetFiles(dir, "*", SearchOption.AllDirectories)) {
                try { bytes += new FileInfo(f).Length; } catch { }
            }
            return (int)Math.Min(bytes / 1024, int.MaxValue);
        } catch { return 0; }
    }

    // Реестр, ярлыки и маркер. Папку приложения не трогаем: в ней лежит сам
    // uninstall.exe, и пока открыто окно мастера, снести её нельзя.
    static void UninstallCleanup() {
        try {
            foreach (var p in Process.GetProcessesByName("GORKIVPN")) {
                try { p.Kill(); p.WaitForExit(2000); } catch { }
            }
        } catch { }

        try {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall", true)) {
                if (key != null) key.DeleteSubKeyTree("GORKIVPN", false);
            }
        } catch { }

        try {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\App Paths", true)) {
                if (key != null) key.DeleteSubKeyTree("GORKIVPN.exe", false);
            }
        } catch { }

        foreach (string dir in new[] {
            Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Desktop"),
            Environment.GetFolderPath(Environment.SpecialFolder.Programs),
            Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms)
        }) {
            try { if (!string.IsNullOrEmpty(dir)) File.Delete(Path.Combine(dir, "GORKIVPN.lnk")); } catch { }
        }

        // Настройки и профили самого VPN (Electron держит их в %APPDATA%\gorkivpn)
        foreach (string dir in new[] {
            MarkerDir,
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "gorkivpn")
        }) {
            try { if (Directory.Exists(dir)) Directory.Delete(dir, true); } catch { }
        }
    }

    // Папка сносится отдельным процессом уже после нашего выхода — иначе
    // rmdir спотыкается о запущенный uninstall.exe внутри неё.
    static void ScheduleFolderDelete() {
        try {
            string appDir = Path.GetDirectoryName(Application.ExecutablePath);
            Process.Start(new ProcessStartInfo {
                FileName = "cmd.exe",
                Arguments = string.Format("/c ping 127.0.0.1 -n 3 > nul & rmdir /s /q \"{0}\"", appDir),
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            });
        } catch { }
    }

    // Скачивание + распаковка + ярлык + маркер. progress(null) — без UI.
    static void InstallTo(string url, string dest, Action<string, long, long> progress) {
        string zipTmp = Path.Combine(Path.GetTempPath(), "gorkivpn_" + Guid.NewGuid().ToString("N") + ".zip");
        try {
            using (var wc = new WebClient()) {
                ServicePointManager.Expect100Continue = true;
                ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; // Tls12
                wc.Headers.Add("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
                wc.DownloadProgressChanged += (s, e) => {
                    if (progress != null && e.TotalBytesToReceive > 0)
                        progress("download", e.BytesReceived, e.TotalBytesToReceive);
                };
                if (progress != null) progress("download", 0, 0);
                wc.DownloadFileTaskAsync(url, zipTmp).GetAwaiter().GetResult();
            }
            if (progress != null) progress("install", 0, 0);

            // Переустановка поверх старой копии — только если там точно наше приложение
            if (Directory.Exists(dest) && File.Exists(Path.Combine(dest, "GORKIVPN.exe"))) {
                try {
                    Directory.Delete(dest, true);
                } catch (IOException) {
                    // файлы держит запущенная копия — системное "отказано в доступе" тут не помогает
                    throw new IOException("Закройте GORKIVPN (в том числе значок в трее) и повторите установку.");
                } catch (UnauthorizedAccessException) {
                    throw new IOException("Закройте GORKIVPN (в том числе значок в трее) и повторите установку.");
                }
            }
            Directory.CreateDirectory(dest);
            ZipFile.ExtractToDirectory(zipTmp, dest);

            Directory.CreateDirectory(MarkerDir);
            File.WriteAllText(MarkerFile, dest);
            
            string uninstaller = Path.Combine(dest, "uninstall.exe");
            try { File.Copy(Application.ExecutablePath, uninstaller, true); } catch { }

            string appExe = Path.Combine(dest, "GORKIVPN.exe");

            try {
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\GORKIVPN")) {
                    key.SetValue("DisplayName", "GORKIVPN");
                    key.SetValue("DisplayIcon", appExe);
                    key.SetValue("UninstallString", string.Format("\"{0}\" --uninstall", uninstaller));
                    key.SetValue("InstallLocation", dest);
                    key.SetValue("Publisher", "GORKIVPN");
                    // Без DisplayVersion «Установленные приложения» показывают пустую строку
                    // вместо версии, а без NoModify/NoRepair рисуют неработающие кнопки.
                    key.SetValue("DisplayVersion", "1.0.0");
                    key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                    key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                    key.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
                    key.SetValue("EstimatedSize", DirSizeKb(dest), RegistryValueKind.DWord);
                }
            } catch { }

            // Чтобы «gorkivpn» находился в поиске и в «Выполнить» даже без ярлыка
            try {
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(
                        @"Software\Microsoft\Windows\CurrentVersion\App Paths\GORKIVPN.exe")) {
                    key.SetValue("", appExe);
                    key.SetValue("Path", dest);
                }
            } catch { }

            CreateShortcut(Path.Combine(dest, "GORKIVPN.exe"));
        } finally {
            try { File.Delete(zipTmp); } catch { }
        }
    }

    // Ярлык в «Пуске» — единственное, по чему поиск Windows находит приложение,
    // поэтому он делается отдельно от ярлыка на рабочем столе. Раньше оба лежали
    // под общим try/catch: рабочий стол в OneDrive иногда отдаёт путь, на котором
    // CreateShortcut падает с E_INVALIDARG, и вместе с ним пропадал ярлык в «Пуске».
    static void CreateShortcut(string exe) {
        var errors = new System.Text.StringBuilder();

        string startMenu = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
        if (!MakeLnk(exe, startMenu, errors)) {
            // резерв: общий для всех пользователей «Пуск», если пользовательский недоступен
            MakeLnk(exe, Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms), errors);
        }

        string desk = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        if (!MakeLnk(exe, desk, errors)) {
            // резерв мимо OneDrive: %USERPROFILE%\Desktop
            MakeLnk(exe, Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Desktop"), errors);
        }

        // молча пропавший ярлык нечем объяснить — пишем причину
        try {
            string log = Path.Combine(MarkerDir, "shortcut_error.txt");
            if (errors.Length > 0) File.WriteAllText(log, errors.ToString());
            else if (File.Exists(log)) File.Delete(log);
        } catch { }
    }

    static bool MakeLnk(string exe, string dir, System.Text.StringBuilder errors) {
        try {
            if (string.IsNullOrEmpty(dir)) { errors.AppendLine("пустой путь для ярлыка"); return false; }
            Directory.CreateDirectory(dir);

            Type t = Type.GetTypeFromProgID("WScript.Shell");
            if (t == null) { errors.AppendLine("WScript.Shell недоступен"); return false; }
            dynamic shell = Activator.CreateInstance(t);

            dynamic sc = shell.CreateShortcut(Path.Combine(dir, "GORKIVPN.lnk"));
            sc.TargetPath = exe;
            sc.WorkingDirectory = Path.GetDirectoryName(exe);
            sc.IconLocation = exe + ",0";
            sc.Description = "GORKIVPN — VPN-клиент";
            sc.Save();
            return true;
        } catch (Exception ex) {
            errors.AppendLine(dir + " -> " + ex.Message);
            return false;
        }
    }

    // ---------- Тёмная тема ----------
    static class C {
        public static readonly Color Bg = Color.FromArgb(0x10, 0x12, 0x16);
        public static readonly Color Surface = Color.FromArgb(0x1a, 0x1d, 0x24);
        public static readonly Color Border = Color.FromArgb(0x2a, 0x2e, 0x37);
        public static readonly Color Text = Color.FromArgb(0xe8, 0xea, 0xed);
        public static readonly Color Sub = Color.FromArgb(0x9a, 0xa0, 0xa6);
        public static readonly Color Accent = Color.FromArgb(0xff, 0x7a, 0x18);
        public static readonly Color AccentHover = Color.FromArgb(0xff, 0x8f, 0x3d);
        public static readonly Color Danger = Color.FromArgb(0xff, 0x4d, 0x4f);
    }

    static GraphicsPath Rounded(RectangleF r, float rad) {
        var p = new GraphicsPath();
        float d = rad * 2;
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    static Font UiFont(float size, FontStyle style) {
        try { return new Font("Segoe UI Variable Text", size, style); }
        catch { return new Font("Segoe UI", size, style); }
    }

    // Скруглённое поле (внутри — бесрамный TextBox)
    class RoundedBox : Panel {
        TextBox _inner;
        public override string Text { get { return _inner.Text; } set { _inner.Text = value; } }
        public bool ReadOnly { get { return _inner.ReadOnly; } set { _inner.ReadOnly = value; _inner.BackColor = C.Surface; } }
        // Ползунков не показываем вовсе; текст умещается подгонкой шрифта (FitText)
        public float FontSize {
            get { return _inner.Font.Size; }
            set { _inner.Font = UiFont(value, _inner.Font.Style); }
        }

        public RoundedBox(bool multiline) {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
            BackColor = C.Surface;
            Padding = new Padding(14, 9, 14, 9);
            _inner = new TextBox {
                BorderStyle = BorderStyle.None,
                BackColor = C.Surface,
                ForeColor = C.Text,
                Font = UiFont(9.5f, FontStyle.Regular),
                Multiline = multiline,
                ScrollBars = ScrollBars.None,
                Dock = DockStyle.Fill
            };
            Controls.Add(_inner);
        }

        protected override void OnPaintBackground(PaintEventArgs e) {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using (var path = Rounded(new RectangleF(1, 1, Width - 3, Height - 3), 10)) {
                using (var b = new SolidBrush(C.Surface)) g.FillPath(b, path);
                using (var pen = new Pen(C.Border)) g.DrawPath(pen, path);
            }
        }
    }

    enum Btn { Primary, Ghost, Danger }

    class ModernButton : Button {
        bool _hover, _down;
        Btn _variant = Btn.Primary;
        public Btn Variant { get { return _variant; } set { _variant = value; Invalidate(); } }

        public ModernButton() {
            FlatStyle = FlatStyle.Flat;
            FlatAppearance.BorderSize = 0;
            BackColor = Color.Transparent;
            ForeColor = Color.White;
            Font = UiFont(9.5f, FontStyle.Bold);
            Cursor = Cursors.Hand;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                     ControlStyles.OptimizedDoubleBuffer | ControlStyles.SupportsTransparentBackColor, true);
            MouseEnter += (s, e) => { _hover = true; Invalidate(); };
            MouseLeave += (s, e) => { _hover = false; _down = false; Invalidate(); };
            MouseDown += (s, e) => { _down = true; Invalidate(); };
            MouseUp += (s, e) => { _down = false; Invalidate(); };
        }

        Color FillColor() {
            if (!Enabled) return C.Surface;
            if (_down && (Variant == Btn.Primary || Variant == Btn.Danger)) return _hover ? C.Accent : C.AccentHover;
            if (Variant == Btn.Danger) return _hover ? Color.FromArgb(0xff, 0x5f, 0x61) : C.Danger;
            if (Variant == Btn.Ghost) return _hover ? C.Surface : Color.Transparent;
            return _hover ? C.AccentHover : C.Accent;
        }

        protected override void OnPaintBackground(PaintEventArgs e) { }

        protected override void OnPaint(PaintEventArgs e) {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            // Стираем всё, иначе прозрачные (Ghost) кнопки рисуют текст поверх старого
            g.Clear(Parent != null ? Parent.BackColor : C.Bg);
            var rect = new Rectangle(1, 1, Width - 3, Height - 3);
            using (var path = Rounded(rect, 8)) {
                using (var b = new SolidBrush(FillColor())) g.FillPath(b, path);
                if ((Variant == Btn.Ghost && (_hover || !Enabled)) || !Enabled)
                    using (var pen = new Pen(!Enabled ? C.Border : C.Sub)) g.DrawPath(pen, path);
            }
            Color fg = !Enabled ? C.Sub
                : (Variant == Btn.Ghost && !_hover) ? C.Sub : Color.White;
            TextRenderer.DrawText(g, Text, Font, rect, fg,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
        }
    }

    class ModernCheckBox : CheckBox {
        bool _hover;

        public ModernCheckBox() {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                     ControlStyles.OptimizedDoubleBuffer | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
            ForeColor = C.Text;
            Font = UiFont(9.5f, FontStyle.Regular);
            Cursor = Cursors.Hand;
            MouseEnter += (s, e) => { _hover = true; Invalidate(); };
            MouseLeave += (s, e) => { _hover = false; Invalidate(); };
        }

        protected override void OnPaint(PaintEventArgs e) {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Parent != null ? Parent.BackColor : C.Bg);

            const int box = 18;
            var r = new Rectangle(0, (Height - box) / 2, box, box);
            using (var path = Rounded(r, 4)) {
                if (Checked) {
                    using (var b = new SolidBrush(C.Accent)) g.FillPath(b, path);
                } else {
                    using (var b = new SolidBrush(C.Surface)) g.FillPath(b, path);
                    using (var pen = new Pen(_hover ? C.Sub : C.Border)) g.DrawPath(pen, path);
                }
            }
            if (Checked)
                using (var pen = new Pen(Color.White, 2f) { StartCap = LineCap.Round, EndCap = LineCap.Round })
                    g.DrawLines(pen, new[] {
                        new Point(r.X + 3, r.Y + r.Height / 2),
                        new Point(r.X + r.Width / 2, r.Y + r.Height - 5),
                        new Point(r.X + r.Width - 2, r.Y + 4)
                    });

            TextRenderer.DrawText(g, Text, Font, new Rectangle(box + 12, 0, Width - box - 12, Height),
                ForeColor, TextFormatFlags.WordBreak | TextFormatFlags.VerticalCenter);
        }
    }

    class ModernProgressBar : ProgressBar {
        public ModernProgressBar() {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                     ControlStyles.OptimizedDoubleBuffer, true);
        }

        protected override void OnPaint(PaintEventArgs e) {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            var track = new RectangleF(0, 0, Width - 1, Height - 1);
            using (var path = Rounded(track, Height / 2f)) {
                using (var b = new SolidBrush(C.Surface)) g.FillPath(b, path);
                if (Maximum > 0 && Value > 0) {
                    float frac = Math.Min(1f, (float)Value / Maximum);
                    var clip = new RectangleF(0, 0, Width * frac, Height);
                    using (var region = new Region(path)) {
                        g.SetClip(region, CombineMode.Replace);
                        using (var b2 = new LinearGradientBrush(track, C.Accent, C.AccentHover, 0f))
                            g.FillRectangle(b2, clip);
                        g.ResetClip();
                    }
                }
            }
        }
    }

    // ---------- Окно ----------
    [DllImport("dwmapi.dll", PreserveSig = true)]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
    const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;

    class LoaderForm : Form {
        const int FORM_W = 460, BOTTOM_H = 64;
        readonly string _url;
        readonly string _installedDir;
        string _installedExe;
        int _step;
        Panel _content;
        Panel _infoPage, _folderPage, _installPage, _finalPage;
        ModernButton _btnBack, _btnNext, _btnCancel, _btnOpen, _btnClose;
        RoundedBox _folderBox, _finalBox;
        ModernCheckBox _agree;
        ModernProgressBar _bar;
        Label _status;

        public LoaderForm(string url, string installedDir) {
            _url = url;
            _installedDir = installedDir;
            Text = "Установка GORKIVPN";
            ClientSize = new Size(FORM_W, 400);
            FormBorderStyle = FormBorderStyle.FixedSingle;
            // WinForms не подхватывает иконку из /win32icon автоматически —
            // забираем её из самого exe, чтобы логотип был и в заголовке, и в панели задач
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = C.Bg;
            Font = UiFont(9.5f, FontStyle.Regular);

            var bottom = new Panel { Dock = DockStyle.Bottom, Height = BOTTOM_H, BackColor = C.Bg };
            _content = new Panel { Dock = DockStyle.Fill, BackColor = C.Bg };
            Controls.Add(_content);
            Controls.Add(bottom);

            BuildPages();
            BuildButtons(bottom);

            ShowStep(1);
        }

        protected override void OnHandleCreated(EventArgs e) {
            base.OnHandleCreated(e);
            try { int v = 1; DwmSetWindowAttribute(Handle, DWMWA_USE_IMMERSIVE_DARK_MODE, ref v, 4); } catch { }
        }

        protected override void OnShown(EventArgs e) {
            base.OnShown(e);
            // Плавное появление
            Opacity = 0;
            var t = new Timer { Interval = 12 };
            t.Tick += (s, _) => {
                Opacity += 0.08;
                if (Opacity >= 1) { t.Stop(); t.Dispose(); }
            };
            t.Start();
        }

        Panel NewPage() {
            var p = new Panel { Dock = DockStyle.Fill, BackColor = C.Bg };
            _content.Controls.Add(p);
            return p;
        }

        Label Title(string text, Color color, float size) {
            var l = new Label {
                Text = text, ForeColor = color, BackColor = Color.Transparent,
                Font = UiFont(size, FontStyle.Bold), AutoSize = true, Left = 24, Top = 20
            };
            return l;
        }

        void BuildPages() {
            // 1. Инфо про вирус — карточка на всю страницу, без заголовка и скроллбара
            _infoPage = NewPage();
            var story = new RoundedBox(true) {
                Left = 24, Top = 20, Width = _content.ClientSize.Width - 48,
                Height = _content.ClientSize.Height - 28
            };
            story.ReadOnly = true;
            story.Text = SCARY;
            FitText(story, SCARY);
            _infoPage.Controls.Add(story);

            // 2. Папка + галочка согласия
            _folderPage = NewPage();
            _folderPage.Controls.Add(Title("Выберите папку установки вируса", C.Text, 14f));

            _folderBox = new RoundedBox(false) {
                Left = 24, Top = 56, Width = _content.ClientSize.Width - 48 - 104,
                Height = 38
            };
            _folderBox.Text = _installedDir ?? DefaultDir;

            var browse = new ModernButton { Text = "Обзор", Variant = Btn.Ghost, Left = _folderBox.Right + 8, Top = 57, Width = 96, Height = 36 };
            browse.Click += (s, e) => {
                using (var d = new FolderBrowserDialog()) {
                    try { d.SelectedPath = _folderBox.Text.Trim(); } catch { }
                    if (d.ShowDialog(this) == DialogResult.OK) _folderBox.Text = AppFolder(d.SelectedPath);
                }
            };

            _agree = new ModernCheckBox {
                Text = "Вы согласны с тем, что все ваши личные данные будут украдены и использованы в личных целях?",
                Left = 24, Top = _content.ClientSize.Height - 92, Width = _content.ClientSize.Width - 48, Height = 72
            };
            _agree.CheckedChanged += (s, e) => _btnNext.Enabled = _agree.Checked;

            _folderPage.Controls.Add(_folderBox);
            _folderPage.Controls.Add(browse);
            _folderPage.Controls.Add(_agree);

            // 3. Установка
            _installPage = NewPage();
            _status = new Label {
                Text = "Готовимся...", ForeColor = C.Sub, BackColor = Color.Transparent,
                Font = UiFont(9.5f, FontStyle.Regular), AutoSize = true, Left = 24, Top = 62
            };
            _bar = new ModernProgressBar {
                Left = 24, Top = 96, Width = _content.ClientSize.Width - 48, Height = 8
            };
            _installPage.Controls.Add(Title("Установка", C.Text, 14f));
            _installPage.Controls.Add(_status);
            _installPage.Controls.Add(_bar);

            // 4. Финал
            _finalPage = NewPage();
            _finalBox = new RoundedBox(true) {
                Left = 24, Top = 60, Width = _content.ClientSize.Width - 48,
                Height = _content.ClientSize.Height - 80
            };
            _finalBox.ReadOnly = true;
            _finalBox.Text = FINAL;
            _finalPage.Controls.Add(Title("ВСЁ УКРАДЕНО!", C.Danger, 18f));
            _finalPage.Controls.Add(_finalBox);
        }

        void BuildButtons(Panel bottom) {
            int h = 36, top = 14;
            _btnCancel = new ModernButton { Text = "Отмена", Variant = Btn.Ghost, Left = 24, Top = top, Width = 90, Height = h };
            _btnBack = new ModernButton { Text = "Назад", Variant = Btn.Ghost, Left = FORM_W - 24 - 110 - 8 - 90, Top = top, Width = 90, Height = h };
            _btnNext = new ModernButton { Text = "Далее", Variant = Btn.Primary, Left = FORM_W - 24 - 110, Top = top, Width = 110, Height = h };
            _btnClose = new ModernButton { Text = "Закрыть", Variant = Btn.Ghost, Left = FORM_W - 24 - 150 - 8 - 90, Top = top, Width = 90, Height = h };
            _btnOpen = new ModernButton { Text = "Открыть приложение", Variant = Btn.Primary, Left = FORM_W - 24 - 150, Top = top, Width = 150, Height = h };

            _btnBack.Click += (s, e) => ShowStep(_step - 1);
            _btnNext.Click += (s, e) => {
                if (_step == 1) ShowStep(2);
                else if (_step == 2) StartInstall();
            };
            _btnCancel.Click += (s, e) => Close();
            _btnOpen.Click += (s, e) => { Launch(_installedExe); Close(); };
            _btnClose.Click += (s, e) => Close();

            bottom.Controls.Add(_btnBack);
            bottom.Controls.Add(_btnCancel);
            bottom.Controls.Add(_btnNext);
            bottom.Controls.Add(_btnClose);
            bottom.Controls.Add(_btnOpen);
        }

        void ShowStep(int s) {
            _step = s;
            _infoPage.Visible = s == 1;
            _folderPage.Visible = s == 2;
            _installPage.Visible = s == 3;
            _finalPage.Visible = s == 4;
            _btnBack.Visible = s == 2;
            _btnNext.Visible = s <= 2;
            _btnCancel.Visible = s <= 2;
            _btnOpen.Visible = s == 4;
            _btnClose.Visible = s == 4;
            _btnNext.Enabled = s != 2 || _agree.Checked;
        }

        async void StartInstall() {
            // путь могли и вписать руками — подпапку GORKIVPN дорисовываем и здесь
            string dest = AppFolder(_folderBox.Text.Trim());
            if (dest.Length == 0) {
                MessageBox.Show("Выберите папку установки.", "GORKIVPN", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            _btnBack.Enabled = false;
            _btnCancel.Enabled = false;
            _btnNext.Enabled = false;
            ShowStep(3);
            try {
                // Прогресс приходит из фонового потока — перебрасываем в UI через SynchronizationContext
                var ui = System.Threading.SynchronizationContext.Current;
                await System.Threading.Tasks.Task.Run(() =>
                    InstallTo(_url, dest, (kind, rec, total) =>
                        ui.Post(delegate {
                            if (IsDisposed) return;
                            if (kind == "download") {
                                _status.Text = total > 0
                                    ? string.Format("Скачиваем вирус... {0} / {1} КБ", rec / 1024, total / 1024)
                                    : "Скачиваем вирус...";
                                if (total > 0) { _bar.Maximum = (int)Math.Min(total, int.MaxValue); _bar.Value = (int)Math.Min(rec, _bar.Maximum); }
                            } else {
                                _status.Text = "Внедряемся в систему...";
                            }
                        }, null)));
                _installedExe = Path.Combine(dest, "GORKIVPN.exe");
                _status.Text = "Готово.";
                _bar.Value = _bar.Maximum;
                // куда именно легло приложение — иначе после установки его ищут по всему диску
                string done = FINAL + "\r\n\r\nПапка приложения:\r\n" + dest;
                _finalBox.Text = done;
                FitText(_finalBox, done);
                ShowStep(4);
            } catch (Exception ex) {
                if (IsDisposed) return;
                MessageBox.Show("Не удалось установить GORKIVPN:\n" + ex.Message,
                    "GORKIVPN", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
            }
        }
    }

    // Мастер удаления. Тот же exe, что и загрузчик, но по флагу --uninstall или по
    // имени uninstall.exe открывается это окно, а не установка.
    class UninstallForm : Form {
        const int FORM_W = 460, BOTTOM_H = 64;
        Panel _content, _askPage, _byePage;
        ModernButton _btnNext, _btnCancel, _btnClose;
        ModernCheckBox _agree;
        bool _removed;

        public UninstallForm() {
            Text = "Удаление GORKIVPN";
            ClientSize = new Size(FORM_W, 300);
            FormBorderStyle = FormBorderStyle.FixedSingle;
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = C.Bg;
            Font = UiFont(9.5f, FontStyle.Regular);

            var bottom = new Panel { Dock = DockStyle.Bottom, Height = BOTTOM_H, BackColor = C.Bg };
            _content = new Panel { Dock = DockStyle.Fill, BackColor = C.Bg };
            Controls.Add(_content);
            Controls.Add(bottom);

            // 1. Подтверждение
            _askPage = new Panel { Dock = DockStyle.Fill, BackColor = C.Bg };
            _askPage.Controls.Add(new Label {
                Text = "Вы уверены, что хотите удалить GORKIVPN?",
                ForeColor = C.Text, BackColor = Color.Transparent,
                Font = UiFont(14f, FontStyle.Bold),
                Left = 24, Top = 24, Width = FORM_W - 48, Height = 56
            });
            _askPage.Controls.Add(new Label {
                Text = "Будут удалены само приложение, его ярлыки, профили и запись в списке "
                     + "установленных программ.",
                ForeColor = C.Sub, BackColor = Color.Transparent,
                Font = UiFont(9.5f, FontStyle.Regular),
                Left = 24, Top = 78, Width = FORM_W - 48, Height = 48
            });
            _agree = new ModernCheckBox {
                Text = "Вы согласны переписать всё своё имущество на разработчика этого впна?",
                Left = 24, Top = 140, Width = FORM_W - 48, Height = 64
            };
            _agree.CheckedChanged += (s, e) => _btnNext.Enabled = _agree.Checked;
            _askPage.Controls.Add(_agree);
            _content.Controls.Add(_askPage);

            // 2. Прощание
            _byePage = new Panel { Dock = DockStyle.Fill, BackColor = C.Bg };
            var byeBox = new RoundedBox(true) {
                Left = 24, Top = 24, Width = FORM_W - 48, Height = _content.ClientSize.Height - 48
            };
            byeBox.ReadOnly = true;
            byeBox.Text = BYE;
            FitText(byeBox, BYE);
            _byePage.Controls.Add(byeBox);
            _content.Controls.Add(_byePage);

            int h = 36, top = 14;
            _btnCancel = new ModernButton { Text = "Отмена", Variant = Btn.Ghost, Left = 24, Top = top, Width = 90, Height = h };
            _btnNext = new ModernButton { Text = "Далее", Variant = Btn.Danger, Left = FORM_W - 24 - 110, Top = top, Width = 110, Height = h, Enabled = false };
            _btnClose = new ModernButton { Text = "Закрыть", Variant = Btn.Primary, Left = FORM_W - 24 - 110, Top = top, Width = 110, Height = h };
            _btnCancel.Click += (s, e) => Close();
            _btnClose.Click += (s, e) => Close();
            _btnNext.Click += (s, e) => DoRemove();
            bottom.Controls.Add(_btnCancel);
            bottom.Controls.Add(_btnNext);
            bottom.Controls.Add(_btnClose);

            ShowAsk();
        }

        protected override void OnHandleCreated(EventArgs e) {
            base.OnHandleCreated(e);
            try { int v = 1; DwmSetWindowAttribute(Handle, DWMWA_USE_IMMERSIVE_DARK_MODE, ref v, 4); } catch { }
        }

        void ShowAsk() {
            _askPage.Visible = true; _byePage.Visible = false;
            _btnCancel.Visible = true; _btnNext.Visible = true; _btnClose.Visible = false;
        }

        void DoRemove() {
            _btnNext.Enabled = false;
            Cursor = Cursors.WaitCursor;
            try { UninstallCleanup(); } catch { }
            _removed = true;
            Cursor = Cursors.Default;
            _askPage.Visible = false; _byePage.Visible = true;
            _btnCancel.Visible = false; _btnNext.Visible = false; _btnClose.Visible = true;
        }

        protected override void OnFormClosed(FormClosedEventArgs e) {
            base.OnFormClosed(e);
            // Папку сносим последней: пока окно живо, uninstall.exe внутри неё занят
            if (_removed) ScheduleFolderDelete();
        }
    }
}
