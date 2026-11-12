//! 本机 NAS 服务：随应用一起启动 / 退出的 Node 后端子进程（`nas-backend/server.mjs`）。
//!
//! 配置存在应用数据目录的 `nas.json`；启用后应用启动时自动拉起后端，并把接入地址指向
//! `http://127.0.0.1:<port>/`。状态（启动中 / 就绪 / 出错）通过 `nas-status` 事件推给前端，
//! 前端据此显示启动页与设置里的状态面板。

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

pub const DEFAULT_PORT: u16 = 17680;
const CONFIG_FILE: &str = "nas.json";
const LOG_LINES: usize = 60;
/// 首次扫描网络盘可能要十几秒，留足余量
const READY_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_RESTARTS: u32 = 3;
const UNSUPPORTED: &str = "此平台不支持内置 NAS 服务（仅桌面端可用）";

fn default_port() -> u16 {
    DEFAULT_PORT
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NasConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub media_dir: String,
    #[serde(default = "default_port")]
    pub port: u16,
}

impl Default for NasConfig {
    fn default() -> Self {
        Self { enabled: false, media_dir: String::new(), port: DEFAULT_PORT }
    }
}

struct Inner {
    cfg: NasConfig,
    data_dir: Option<PathBuf>,
    state: &'static str, // off | starting | ready | error
    message: String,
    videos: Option<u32>,
    categories: Option<u32>,
    child: Option<Child>,
    log: VecDeque<String>,
    /// 每次（重）启动加一：旧的监控线程发现代数变了就退出
    generation: u64,
    restarts: u32,
}

static NAS: Lazy<Mutex<Inner>> = Lazy::new(|| {
    Mutex::new(Inner {
        cfg: NasConfig::default(),
        data_dir: None,
        state: "off",
        message: String::new(),
        videos: None,
        categories: None,
        child: None,
        log: VecDeque::new(),
        generation: 0,
        restarts: 0,
    })
});

/// 给前端的状态快照
#[derive(Clone, Debug, Serialize)]
pub struct NasStatus {
    pub enabled: bool,
    pub state: &'static str,
    pub message: String,
    pub port: u16,
    pub media_dir: String,
    /// 接入地址（本机回环）
    pub base: String,
    pub videos: Option<u32>,
    pub categories: Option<u32>,
    pub log: Vec<String>,
}

fn local_base(port: u16) -> String {
    format!("http://127.0.0.1:{port}/")
}

fn snapshot(g: &Inner) -> NasStatus {
    NasStatus {
        enabled: g.cfg.enabled,
        state: g.state,
        message: g.message.clone(),
        port: g.cfg.port,
        media_dir: g.cfg.media_dir.clone(),
        base: local_base(g.cfg.port),
        videos: g.videos,
        categories: g.categories,
        log: g.log.iter().cloned().collect(),
    }
}

pub fn status() -> NasStatus {
    snapshot(&NAS.lock().unwrap())
}

fn emit(app: &AppHandle) {
    let _ = app.emit("nas-status", status());
}

/// 只在代数没变时改状态（旧线程的迟到更新直接丢弃）
fn set_state(app: &AppHandle, gen: u64, state: &'static str, message: impl Into<String>) {
    let message = message.into();
    let dir = {
        let mut g = NAS.lock().unwrap();
        if g.generation != gen {
            return;
        }
        g.state = state;
        g.message = message.clone();
        g.data_dir.clone()
    };
    // 状态变化落到 debug.log，用户反馈“起不来”时能直接看到每一步
    if let Some(dir) = dir {
        let _ = crate::logging::append_debug(&dir, &format!("[nas] {state}: {message}"));
    }
    emit(app);
}

fn push_log(app: &AppHandle, gen: u64, line: String) {
    let notify = {
        let mut g = NAS.lock().unwrap();
        if g.generation != gen {
            return;
        }
        // "[scan] 1418 个视频 / 25 个分类 @ …"
        if let Some(rest) = line.strip_prefix("[scan] ") {
            let mut nums = rest.split_whitespace().filter_map(|w| w.parse::<u32>().ok());
            g.videos = nums.next();
            g.categories = nums.next();
            if g.state == "starting" {
                g.message = format!("媒体库已扫描：{} 个视频 / {} 个分类", g.videos.unwrap_or(0), g.categories.unwrap_or(0));
            }
        } else if g.state == "starting" && line.starts_with("[http]") {
            g.message = "服务已监听端口，等待就绪…".into();
        }
        g.log.push_back(line);
        while g.log.len() > LOG_LINES {
            g.log.pop_front();
        }
        // 启动阶段与出错时才推事件，避免播放期间每行 [hls] 日志都刷前端
        g.state == "starting" || g.state == "error"
    };
    if notify {
        emit(app);
    }
}

/* ───────────── 环境探测 ───────────── */

const TOOL_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin", "/usr/bin", "/bin"];

fn child_path() -> String {
    let mut parts: Vec<String> = TOOL_DIRS.iter().map(|s| s.to_string()).collect();
    if let Ok(p) = std::env::var("PATH") {
        parts.push(p);
    }
    parts.join(":")
}

fn find_tool(name: &str) -> Option<PathBuf> {
    let dirs = child_path();
    dirs.split(':').map(|d| Path::new(d).join(name)).find(|p| p.is_file())
}

fn find_node() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("HGHUBX_NODE") {
        if Path::new(&p).is_file() {
            return Some(PathBuf::from(p));
        }
    }
    if let Some(p) = find_tool("node") {
        return Some(p);
    }
    // nvm：~/.nvm/versions/node/<版本>/bin/node，取最新
    if let Some(home) = std::env::var_os("HOME") {
        let root = Path::new(&home).join(".nvm/versions/node");
        if let Ok(rd) = std::fs::read_dir(root) {
            let mut versions: Vec<PathBuf> = rd.filter_map(|e| e.ok()).map(|e| e.path().join("bin/node")).filter(|p| p.is_file()).collect();
            versions.sort();
            if let Some(p) = versions.pop() {
                return Some(p);
            }
        }
    }
    // 最后用登录 shell 查一次（fnm / volta / asdf 等都靠 shell 配置）
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let out = Command::new(shell).args(["-lc", "command -v node"]).output().ok()?;
    let line = String::from_utf8_lossy(&out.stdout).lines().last()?.trim().to_string();
    (!line.is_empty() && Path::new(&line).is_file()).then(|| PathBuf::from(line))
}

fn find_script(app: &AppHandle) -> Option<PathBuf> {
    let bundled = app.path().resource_dir().ok().map(|d| d.join("nas-backend/server.mjs"));
    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("../nas-backend/server.mjs");
    bundled.into_iter().chain(std::iter::once(dev)).find(|p| p.is_file())
}

/// 向本机服务发 `GET /health`，成功返回 (视频数, 分类数)
fn health(port: u16) -> Option<(u32, u32)> {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(300)).ok()?;
    s.set_read_timeout(Some(Duration::from_millis(800))).ok()?;
    s.set_write_timeout(Some(Duration::from_millis(800))).ok()?;
    s.write_all(b"GET /health HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n").ok()?;
    let mut text = String::new();
    s.read_to_string(&mut text).ok()?;
    if !text.starts_with("HTTP/1.1 200") && !text.starts_with("HTTP/1.0 200") {
        return None;
    }
    // "HGhubX NAS backend: 1418 videos, 25 categories"
    let tail = text.rsplit("backend:").next()?;
    let mut nums = tail.split(|c: char| !c.is_ascii_digit()).filter_map(|w| w.parse::<u32>().ok());
    Some((nums.next()?, nums.next()?))
}

/* ───────────── 进程管理 ───────────── */

/// 优雅结束：先 SIGTERM（Node 会带走所有 ffmpeg 子进程再退出），超时才强杀。
fn terminate(mut child: Child) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill").args(["-TERM", &child.id().to_string()]).status();
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// 应用退出时调用
pub fn shutdown() {
    let child = {
        let mut g = NAS.lock().unwrap();
        g.generation += 1; // 让监控线程别再“自动重启”
        g.child.take()
    };
    if let Some(c) = child {
        terminate(c);
    }
}

fn save_config(dir: &Path, cfg: &NasConfig) -> Result<(), String> {
    let text = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(CONFIG_FILE), text).map_err(|e| format!("保存配置失败：{e}"))
}

/// 应用启动时调用：读配置；启用则把接入地址指向本机服务并后台拉起。
pub fn init(app: &AppHandle, dir: &Path) {
    let cfg = std::fs::read_to_string(dir.join(CONFIG_FILE))
        .ok()
        .and_then(|t| serde_json::from_str::<NasConfig>(&t).ok())
        .unwrap_or_default();
    {
        let mut g = NAS.lock().unwrap();
        g.cfg = cfg.clone();
        g.data_dir = Some(dir.to_path_buf());
    }
    if cfg.enabled && !cfg.media_dir.trim().is_empty() {
        // 启动即指向本机服务：前端读到的门牌就是它，启动页挡住业务请求直到服务就绪
        let _ = crate::infra::source::gate_open(&local_base(cfg.port));
        start(app.clone());
    }
}

/// （重）启动：先结束旧进程，再在后台线程里完成检查 → 拉起 → 等就绪。
pub fn start(app: AppHandle) {
    let (gen, cfg, data_dir, old) = {
        let mut g = NAS.lock().unwrap();
        g.generation += 1;
        g.restarts = 0;
        g.videos = None;
        g.categories = None;
        g.log.clear();
        // 同步先置状态：命令返回给前端的快照不能还是旧状态（否则界面会闪一下旧的“就绪/出错”）
        g.state = if g.cfg.enabled { "starting" } else { "off" };
        g.message = if g.cfg.enabled { "正在准备…".into() } else { String::new() };
        (g.generation, g.cfg.clone(), g.data_dir.clone(), g.child.take())
    };
    std::thread::spawn(move || {
        if let Some(c) = old {
            terminate(c);
        }
        if !cfg.enabled {
            set_state(&app, gen, "off", "");
            return;
        }
        run(app, gen, cfg, data_dir);
    });
}

fn run(app: AppHandle, gen: u64, cfg: NasConfig, data_dir: Option<PathBuf>) {
    if cfg!(any(target_os = "android", target_os = "ios")) {
        return set_state(&app, gen, "error", UNSUPPORTED);
    }
    set_state(&app, gen, "starting", "正在检查运行环境…");

    let media = cfg.media_dir.trim().to_string();
    if !Path::new(&media).is_dir() {
        return set_state(&app, gen, "error", format!("媒体目录不存在或未挂载：{media}"));
    }
    let Some(node) = find_node() else {
        return set_state(&app, gen, "error", "未找到 Node.js（需要 18 或更高版本）。请先安装：brew install node");
    };
    if find_tool("ffmpeg").is_none() || find_tool("ffprobe").is_none() {
        return set_state(&app, gen, "error", "未找到 ffmpeg / ffprobe。请先安装：brew install ffmpeg");
    }
    let Some(script) = find_script(&app) else {
        return set_state(&app, gen, "error", "找不到后端脚本 nas-backend/server.mjs");
    };
    if health(cfg.port).is_some() {
        return set_state(&app, gen, "error", format!("端口 {} 已被占用（可能是上次未退出的服务），请换一个端口", cfg.port));
    }

    set_state(&app, gen, "starting", "正在启动服务…");
    let cache = data_dir.map(|d| d.join("nas-cache")).unwrap_or_else(|| std::env::temp_dir().join("hghubx-nas-cache"));
    let mut child = match Command::new(&node)
        .arg(&script)
        .arg(&media)
        .args(["--port", &cfg.port.to_string(), "--cache"])
        .arg(&cache)
        .env("PATH", child_path())
        .env("HGHUBX_PARENT_PID", std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return set_state(&app, gen, "error", format!("启动失败：{e}")),
    };
    for stream in [
        child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>),
        child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let app = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                push_log(&app, gen, line);
            }
        });
    }
    {
        let mut g = NAS.lock().unwrap();
        if g.generation != gen {
            drop(g);
            return terminate(child); // 启动期间已被新的启动 / 退出取代
        }
        g.child = Some(child);
    }

    // 等就绪
    let began = Instant::now();
    loop {
        std::thread::sleep(Duration::from_millis(250));
        let exited = {
            let mut g = NAS.lock().unwrap();
            if g.generation != gen {
                return;
            }
            g.child.as_mut().and_then(|c| c.try_wait().ok().flatten())
        };
        if let Some(status) = exited {
            let tail = last_log_lines(3);
            return set_state(&app, gen, "error", format!("服务启动后退出（{status}）{tail}"));
        }
        if let Some((videos, categories)) = health(cfg.port) {
            {
                let mut g = NAS.lock().unwrap();
                if g.generation != gen {
                    return;
                }
                g.videos = Some(videos);
                g.categories = Some(categories);
            }
            set_state(&app, gen, "ready", format!("服务已就绪：{videos} 个视频 / {categories} 个分类"));
            break;
        }
        if began.elapsed() > READY_TIMEOUT {
            return set_state(&app, gen, "error", format!("启动超时（{} 秒），媒体库可能太大或网络盘太慢", READY_TIMEOUT.as_secs()));
        }
    }

    // 就绪后继续看护：意外退出则自动重启，最多 MAX_RESTARTS 次
    loop {
        std::thread::sleep(Duration::from_secs(1));
        let exited = {
            let mut g = NAS.lock().unwrap();
            if g.generation != gen {
                return;
            }
            g.child.as_mut().and_then(|c| c.try_wait().ok().flatten())
        };
        let Some(status) = exited else { continue };
        let restart = {
            let mut g = NAS.lock().unwrap();
            if g.generation != gen {
                return;
            }
            g.child = None;
            if g.restarts < MAX_RESTARTS {
                g.restarts += 1;
                g.generation += 1;
                Some((g.generation, g.restarts))
            } else {
                None
            }
        };
        match restart {
            Some((next_gen, n)) => {
                {
                    let mut g = NAS.lock().unwrap();
                    g.state = "starting";
                    g.message = format!("服务意外退出（{status}），正在重启（{n}/{MAX_RESTARTS}）…");
                }
                emit(&app);
                let (app2, cfg2, dir2) = (app.clone(), cfg.clone(), NAS.lock().unwrap().data_dir.clone());
                return run(app2, next_gen, cfg2, dir2);
            }
            None => {
                let tail = last_log_lines(3);
                return set_state(&app, gen, "error", format!("服务多次意外退出（{status}）{tail}"));
            }
        }
    }
}

fn last_log_lines(n: usize) -> String {
    let g = NAS.lock().unwrap();
    let lines: Vec<&str> = g.log.iter().rev().take(n).rev().map(String::as_str).collect();
    if lines.is_empty() { String::new() } else { format!("：{}", lines.join(" | ")) }
}

/* ───────────── 命令 ───────────── */

#[tauri::command]
pub fn nas_status() -> NasStatus {
    status()
}

#[tauri::command]
pub fn nas_configure(app: AppHandle, enabled: bool, media_dir: String, port: Option<u16>) -> Result<NasStatus, String> {
    if cfg!(any(target_os = "android", target_os = "ios")) {
        return Err(UNSUPPORTED.into());
    }
    let media_dir = media_dir.trim().to_string();
    let port = port.unwrap_or(DEFAULT_PORT);
    if enabled {
        if media_dir.is_empty() {
            return Err("请填写媒体目录".into());
        }
        if !Path::new(&media_dir).is_dir() {
            return Err(format!("媒体目录不存在或未挂载：{media_dir}"));
        }
        if port < 1024 {
            return Err("端口需在 1024–65535 之间".into());
        }
    }
    {
        let mut g = NAS.lock().unwrap();
        g.cfg = NasConfig { enabled, media_dir: if media_dir.is_empty() { g.cfg.media_dir.clone() } else { media_dir }, port };
        if let Some(dir) = g.data_dir.clone() {
            save_config(&dir, &g.cfg)?;
        }
    }
    start(app);
    Ok(status())
}

#[tauri::command]
pub fn nas_restart(app: AppHandle) -> NasStatus {
    start(app);
    status()
}
