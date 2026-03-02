#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use libloading::{Library, Symbol};
use serde_json::json;
use std::collections::VecDeque;
use std::ffi::{c_char, c_void, CStr, CString};
use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use std::{env, io};

const ZTS_AF_INET: i32 = 2;
const ZTS_SOCK_STREAM: i32 = 1;
const ZTS_IP_MAX_STR_LEN: usize = 46;
const SIGNAL_INBOX_LIMIT: usize = 2048;
const LIBZT_EVENT_INBOX_LIMIT: usize = 1024;
const NODE_ONLINE_WAIT_TRIES: usize = 16;
const NODE_ONLINE_WAIT_INTERVAL_MS: u64 = 150;
const IP_ASSIGN_WAIT_TRIES: usize = 12;
const IP_ASSIGN_WAIT_INTERVAL_MS: u64 = 150;
const LIBZT_CONNECT_TIMEOUT_MS: i32 = 8000;

#[repr(C)]
struct ZtsEventMsg {
    event_code: i16,
    node: *mut c_void,
    network: *mut c_void,
    netif: *mut c_void,
    route: *mut c_void,
    peer: *mut c_void,
    addr: *mut c_void,
    cache: *mut c_void,
    len: i32,
}

type ZtsEventCallback = unsafe extern "C" fn(*mut c_void);
type ZtsInitSetEventHandler = unsafe extern "C" fn(Option<ZtsEventCallback>) -> i32;
type ZtsInitFromStorage = unsafe extern "C" fn(*const c_char) -> i32;
type ZtsNodeStart = unsafe extern "C" fn() -> i32;
type ZtsNodeStop = unsafe extern "C" fn() -> i32;
type ZtsNodeFree = unsafe extern "C" fn() -> i32;
type ZtsNodeIsOnline = unsafe extern "C" fn() -> i32;
type ZtsNetJoin = unsafe extern "C" fn(u64) -> i32;
type ZtsAddrGetStr = unsafe extern "C" fn(u64, u32, *mut c_char, u32) -> i32;
type ZtsSocket = unsafe extern "C" fn(i32, i32, i32) -> i32;
type ZtsBind = unsafe extern "C" fn(i32, *const c_char, u16) -> i32;
type ZtsListen = unsafe extern "C" fn(i32, i32) -> i32;
type ZtsAccept = unsafe extern "C" fn(i32, *mut c_char, i32, *mut u16) -> i32;
type ZtsConnect = unsafe extern "C" fn(i32, *const c_char, u16, i32) -> i32;
type ZtsSend = unsafe extern "C" fn(i32, *const c_void, usize, i32) -> isize;
type ZtsRecv = unsafe extern "C" fn(i32, *mut c_void, usize, i32) -> isize;
type ZtsClose = unsafe extern "C" fn(i32) -> i32;

#[derive(Clone, Copy)]
struct LibztSocketApi {
    socket: ZtsSocket,
    bind: ZtsBind,
    listen: ZtsListen,
    accept: ZtsAccept,
    connect: ZtsConnect,
    send: ZtsSend,
    recv: ZtsRecv,
    close: ZtsClose,
}

struct LibztApi {
    _library: Library,
    init_set_event_handler: ZtsInitSetEventHandler,
    init_from_storage: ZtsInitFromStorage,
    node_start: ZtsNodeStart,
    node_stop: ZtsNodeStop,
    node_free: ZtsNodeFree,
    node_is_online: ZtsNodeIsOnline,
    net_join: ZtsNetJoin,
    addr_get_str: ZtsAddrGetStr,
    socket_api: LibztSocketApi,
}

impl LibztApi {
    fn socket_api(&self) -> LibztSocketApi {
        self.socket_api
    }
}

struct LibztRuntime {
    api: LibztApi,
    network_id: u64,
}

struct SignalRuntime {
    api: LibztSocketApi,
    stop: Arc<AtomicBool>,
    listen_fd: Arc<AtomicI32>,
    conn_fd: Arc<AtomicI32>,
    inbox: Arc<Mutex<VecDeque<String>>>,
    threads: Vec<thread::JoinHandle<()>>,
}

static LIBZT_RUNTIME: OnceLock<Mutex<Option<LibztRuntime>>> = OnceLock::new();
static LIBZT_LOG_PATH: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
static LIBZT_EVENT_INBOX: OnceLock<Mutex<VecDeque<String>>> = OnceLock::new();
static SIGNAL_RUNTIME: OnceLock<Mutex<Option<SignalRuntime>>> = OnceLock::new();
static MEDIA_RUNTIME: OnceLock<Mutex<Option<SignalRuntime>>> = OnceLock::new();

fn runtime_slot() -> &'static Mutex<Option<LibztRuntime>> {
    LIBZT_RUNTIME.get_or_init(|| Mutex::new(None))
}

fn libzt_log_slot() -> &'static Mutex<Option<PathBuf>> {
    LIBZT_LOG_PATH.get_or_init(|| Mutex::new(None))
}

fn libzt_event_inbox_slot() -> &'static Mutex<VecDeque<String>> {
    LIBZT_EVENT_INBOX.get_or_init(|| Mutex::new(VecDeque::new()))
}

fn signal_slot() -> &'static Mutex<Option<SignalRuntime>> {
    SIGNAL_RUNTIME.get_or_init(|| Mutex::new(None))
}

fn media_slot() -> &'static Mutex<Option<SignalRuntime>> {
    MEDIA_RUNTIME.get_or_init(|| Mutex::new(None))
}

fn set_libzt_log_path(path: PathBuf) {
    if let Ok(mut guard) = libzt_log_slot().lock() {
        *guard = Some(path);
    }
}

fn append_libzt_log_line(line: &str) {
    let path = libzt_log_slot().lock().ok().and_then(|guard| guard.clone());

    if let Some(path) = path {
        let _ = write_log_line(&path, &format!("[libzt] {line}"));
    }

    if let Ok(mut guard) = libzt_event_inbox_slot().lock() {
        if guard.len() >= LIBZT_EVENT_INBOX_LIMIT {
            guard.pop_front();
        }
        guard.push_back(line.to_string());
    }
}

#[tauri::command]
fn zt_events_poll() -> Result<Vec<String>, String> {
    let mut queue = libzt_event_inbox_slot()
        .lock()
        .map_err(|_| "libzt event inbox lock poisoned".to_string())?;

    let mut out = Vec::with_capacity(queue.len());
    while let Some(item) = queue.pop_front() {
        out.push(item);
    }

    Ok(out)
}

unsafe extern "C" fn libzt_event_handler(msg: *mut c_void) {
    if msg.is_null() {
        append_libzt_log_line("libzt event: <null>");
        return;
    }

    let event_msg = {
        // SAFETY: `msg` is provided by libzt callback and points to a valid event struct
        unsafe { &*(msg as *const ZtsEventMsg) }
    };

    append_libzt_log_line(&format!(
        "libzt event code={} ({}) len={}",
        event_msg.event_code,
        libzt_event_name(event_msg.event_code),
        event_msg.len
    ));
}

fn libzt_event_name(code: i16) -> &'static str {
    match code {
        200 => "NODE_UP",
        201 => "NODE_ONLINE",
        202 => "NODE_OFFLINE",
        203 => "NODE_DOWN",
        210 => "NETWORK_NOT_FOUND",
        213 => "NETWORK_OK",
        214 => "NETWORK_ACCESS_DENIED",
        215 => "NETWORK_READY_IP4",
        216 => "NETWORK_READY_IP6",
        218 => "NETWORK_DOWN",
        240 => "PEER_DIRECT",
        241 => "PEER_RELAY",
        242 => "PEER_UNREACHABLE",
        _ => "UNKNOWN",
    }
}

unsafe fn load_symbol<T: Copy>(library: &Library, name: &[u8]) -> Result<T, String> {
    // SAFETY: caller guarantees the symbol type matches the dynamic library function signature
    let symbol: Symbol<T> = unsafe { library.get(name) }.map_err(|e| e.to_string())?;
    Ok(*symbol)
}

fn load_libzt_api(dll_path: &Path) -> Result<LibztApi, String> {
    let library = {
        // SAFETY: loading user-provided shared library path for runtime FFI calls
        unsafe { Library::new(dll_path) }.map_err(|e| format!("load dll failed: {e}"))?
    };

    let init_set_event_handler = {
        // SAFETY: symbol signatures are matched to ZeroTier C API declarations
        unsafe { load_symbol::<ZtsInitSetEventHandler>(&library, b"zts_init_set_event_handler\0") }?
    };
    let init_from_storage = {
        // SAFETY: symbol signatures are matched to ZeroTier C API declarations
        unsafe { load_symbol::<ZtsInitFromStorage>(&library, b"zts_init_from_storage\0") }?
    };
    let node_start = {
        // SAFETY: symbol signatures are matched to ZeroTier C API declarations
        unsafe { load_symbol::<ZtsNodeStart>(&library, b"zts_node_start\0") }?
    };
    let node_stop = {
        // SAFETY: symbol signatures are matched to ZeroTier C API declarations
        unsafe { load_symbol::<ZtsNodeStop>(&library, b"zts_node_stop\0") }?
    };
    let node_free = {
        // SAFETY: symbol signatures are matched to ZeroTier C API declarations
        unsafe { load_symbol::<ZtsNodeFree>(&library, b"zts_node_free\0") }?
    };
    let node_is_online = {
        // SAFETY: symbol signatures are matched to ZeroTier C API declarations
        unsafe { load_symbol::<ZtsNodeIsOnline>(&library, b"zts_node_is_online\0") }?
    };
    let net_join = {
        // SAFETY: symbol signatures are matched to ZeroTier C API declarations
        unsafe { load_symbol::<ZtsNetJoin>(&library, b"zts_net_join\0") }?
    };
    let addr_get_str = {
        // SAFETY: symbol signatures are matched to ZeroTier C API declarations
        unsafe { load_symbol::<ZtsAddrGetStr>(&library, b"zts_addr_get_str\0") }?
    };

    let socket = {
        // SAFETY: symbol signatures are matched to ZeroTier C API declarations
        unsafe { load_symbol::<ZtsSocket>(&library, b"zts_socket\0") }?
    };
    let bind = {
        // SAFETY: symbol signatures are matched to ZeroTier C API declarations
        unsafe { load_symbol::<ZtsBind>(&library, b"zts_bind\0") }?
    };
    let listen = {
        // SAFETY: symbol signatures are matched to ZeroTier C API declarations
        unsafe { load_symbol::<ZtsListen>(&library, b"zts_listen\0") }?
    };
    let accept = {
        // SAFETY: symbol signatures are matched to ZeroTier C API declarations
        unsafe { load_symbol::<ZtsAccept>(&library, b"zts_accept\0") }?
    };
    let connect = {
        // SAFETY: symbol signatures are matched to ZeroTier C API declarations
        unsafe { load_symbol::<ZtsConnect>(&library, b"zts_connect\0") }?
    };
    let send = {
        // SAFETY: symbol signatures are matched to ZeroTier C API declarations
        unsafe { load_symbol::<ZtsSend>(&library, b"zts_send\0") }?
    };
    let recv = {
        // SAFETY: symbol signatures are matched to ZeroTier C API declarations
        unsafe { load_symbol::<ZtsRecv>(&library, b"zts_recv\0") }?
    };
    let close = {
        // SAFETY: symbol signatures are matched to ZeroTier C API declarations
        unsafe { load_symbol::<ZtsClose>(&library, b"zts_close\0") }?
    };

    Ok(LibztApi {
        _library: library,
        init_set_event_handler,
        init_from_storage,
        node_start,
        node_stop,
        node_free,
        node_is_online,
        net_join,
        addr_get_str,
        socket_api: LibztSocketApi {
            socket,
            bind,
            listen,
            accept,
            connect,
            send,
            recv,
            close,
        },
    })
}

fn parse_network_id(network_id: &str) -> Result<u64, String> {
    let trimmed = network_id.trim();
    if trimmed.is_empty() {
        return Err("network_id is empty".to_string());
    }
    let hex = trimmed.strip_prefix("0x").unwrap_or(trimmed);
    u64::from_str_radix(hex, 16).map_err(|e| format!("invalid network_id(hex): {e}"))
}

fn check_libzt_ret(action: &str, code: i32) -> Result<(), String> {
    if code < 0 {
        return Err(format!("{action} failed: code={code}"));
    }
    Ok(())
}

fn resolve_libzt_dll_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let validate_candidate = |candidate: PathBuf| -> Option<PathBuf> {
        if candidate.is_file() {
            return Some(candidate);
        }
        if candidate.is_dir() {
            let nested = candidate.join("libzt.dll");
            if nested.is_file() {
                return Some(nested);
            }
        }
        None
    };

    if let Ok(custom) = env::var("LIBZT_DLL_PATH") {
        let custom_path = PathBuf::from(custom);
        if let Some(path) = validate_candidate(custom_path) {
            return Ok(path);
        }
    }

    let manifest_dll = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("public")
        .join("libzt.dll");
    if let Some(path) = validate_candidate(manifest_dll) {
        return Ok(path);
    }

    if let Some(resource_dir) = app.path_resolver().resource_dir() {
        let resource_dll = resource_dir.join("libzt.dll");
        if let Some(path) = validate_candidate(resource_dll) {
            return Ok(path);
        }
        let resource_public_dll = resource_dir.join("public").join("libzt.dll");
        if let Some(path) = validate_candidate(resource_public_dll) {
            return Ok(path);
        }
    }

    if let Ok(exe_path) = env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let exe_dll = exe_dir.join("libzt.dll");
            if let Some(path) = validate_candidate(exe_dll) {
                return Ok(path);
            }
            let exe_public_dll = exe_dir.join("public").join("libzt.dll");
            if let Some(path) = validate_candidate(exe_public_dll) {
                return Ok(path);
            }
        }
    }

    Err("libzt.dll not found".to_string())
}

fn resolve_libzt_storage_dir(log_dir: &Path) -> PathBuf {
    if let Some(base_dir) = log_dir.parent() {
        return base_dir.join("libzt_state");
    }
    log_dir.join("libzt_state")
}

fn should_call_node_free_on_stop() -> bool {
    match env::var("LIBZT_CALL_NODE_FREE_ON_STOP") {
        Ok(value) => {
            let normalized = value.trim().to_ascii_lowercase();
            matches!(normalized.as_str(), "1" | "true" | "yes" | "on")
        }
        Err(_) => false,
    }
}

fn try_get_libzt_ip4(api: &LibztApi, net_id: u64) -> Option<String> {
    let mut buffer = [0_i8; ZTS_IP_MAX_STR_LEN + 1];
    // SAFETY: valid writable buffer and net_id/family are simple values
    let ret = unsafe {
        (api.addr_get_str)(
            net_id,
            ZTS_AF_INET as u32,
            buffer.as_mut_ptr(),
            ZTS_IP_MAX_STR_LEN as u32,
        )
    };
    if ret < 0 {
        return None;
    }

    // SAFETY: libzt writes a null-terminated string on success
    let cstr = unsafe { CStr::from_ptr(buffer.as_ptr()) };
    let value = cstr.to_string_lossy().trim().to_string();
    if value.is_empty() || value == "0.0.0.0" {
        None
    } else {
        Some(value)
    }
}

fn get_socket_api() -> Result<LibztSocketApi, String> {
    let guard = runtime_slot()
        .lock()
        .map_err(|_| "libzt runtime lock poisoned".to_string())?;
    let runtime = guard
        .as_ref()
        .ok_or_else(|| "libzt is not started".to_string())?;
    Ok(runtime.api.socket_api())
}

fn push_inbox(inbox: &Arc<Mutex<VecDeque<String>>>, value: String) {
    if let Ok(mut guard) = inbox.lock() {
        if guard.len() >= SIGNAL_INBOX_LIMIT {
            guard.pop_front();
        }
        guard.push_back(value);
    }
}

fn push_sys_event(inbox: &Arc<Mutex<VecDeque<String>>>, event: &str, message: &str) {
    push_inbox(
        inbox,
        json!({
            "__sys": event,
            "message": message,
        })
        .to_string(),
    );
}

fn zt_close_fd(api: &LibztSocketApi, fd: i32) {
    if fd < 0 {
        return;
    }
    // SAFETY: `fd` is a libzt socket descriptor created by zts_socket/accept
    unsafe {
        (api.close)(fd);
    }
}

fn zt_send_all(api: &LibztSocketApi, fd: i32, data: &[u8]) -> Result<(), String> {
    let mut sent = 0;
    while sent < data.len() {
        // SAFETY: `fd` is a valid socket and pointer/len pair are derived from `data`
        let n = unsafe {
            (api.send)(
                fd,
                data[sent..].as_ptr() as *const c_void,
                data.len() - sent,
                0,
            )
        };
        if n <= 0 {
            return Err(format!("zts_send failed: {n}"));
        }
        sent += n as usize;
    }
    Ok(())
}

fn spawn_recv_thread(
    api: LibztSocketApi,
    stop: Arc<AtomicBool>,
    conn_fd: Arc<AtomicI32>,
    inbox: Arc<Mutex<VecDeque<String>>>,
    fd: i32,
    channel: &'static str,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut pending: Vec<u8> = Vec::new();
        let mut buffer = [0u8; 4096];

        loop {
            if stop.load(Ordering::SeqCst) {
                break;
            }

            // SAFETY: `fd` is a valid socket and buffer is writable
            let n = unsafe { (api.recv)(fd, buffer.as_mut_ptr() as *mut c_void, buffer.len(), 0) };

            if n > 0 {
                pending.extend_from_slice(&buffer[..n as usize]);

                while let Some(pos) = pending.iter().position(|b| *b == b'\n') {
                    let mut line = pending.drain(..=pos).collect::<Vec<u8>>();
                    while matches!(line.last(), Some(b'\n') | Some(b'\r')) {
                        line.pop();
                    }
                    if line.is_empty() {
                        continue;
                    }
                    match String::from_utf8(line) {
                        Ok(text) => push_inbox(&inbox, text),
                        Err(err) => push_sys_event(
                            &inbox,
                            "error",
                            &format!("{channel} utf8 decode failed: {err}"),
                        ),
                    }
                }
                continue;
            }

            if n == 0 {
                push_sys_event(&inbox, "disconnected", &format!("{channel} peer closed"));
            } else {
                push_sys_event(
                    &inbox,
                    "disconnected",
                    &format!("{channel} zts_recv failed: {n}"),
                );
            }
            break;
        }

        if conn_fd.load(Ordering::SeqCst) == fd {
            conn_fd.store(-1, Ordering::SeqCst);
        }
        zt_close_fd(&api, fd);
    })
}

fn join_runtime_threads(mut threads: Vec<thread::JoinHandle<()>>) {
    while let Some(handle) = threads.pop() {
        let _ = handle.join();
    }
}

fn join_runtime_threads_async(threads: Vec<thread::JoinHandle<()>>) {
    thread::spawn(move || {
        join_runtime_threads(threads);
    });
}

fn zt_signal_close_internal(wait_threads: bool) -> Result<(), String> {
    let mut guard = signal_slot()
        .lock()
        .map_err(|_| "signal runtime lock poisoned".to_string())?;
    let Some(mut runtime) = guard.take() else {
        return Ok(());
    };

    runtime.stop.store(true, Ordering::SeqCst);

    let conn_fd = runtime.conn_fd.swap(-1, Ordering::SeqCst);
    let listen_fd = runtime.listen_fd.swap(-1, Ordering::SeqCst);
    zt_close_fd(&runtime.api, conn_fd);
    zt_close_fd(&runtime.api, listen_fd);

    let threads = std::mem::take(&mut runtime.threads);
    if wait_threads {
        join_runtime_threads(threads);
    } else {
        join_runtime_threads_async(threads);
    }

    append_libzt_log_line("signal runtime closed");
    Ok(())
}

#[tauri::command]
fn zt_signal_listen(port: u16) -> Result<(), String> {
    if port == 0 {
        return Err("invalid signal port".to_string());
    }

    zt_signal_close_internal(false)?;

    let api = get_socket_api()?;
    let stop = Arc::new(AtomicBool::new(false));
    let listen_fd = Arc::new(AtomicI32::new(-1));
    let conn_fd = Arc::new(AtomicI32::new(-1));
    let inbox = Arc::new(Mutex::new(VecDeque::new()));

    let thread_api = api;
    let thread_stop = Arc::clone(&stop);
    let thread_listen_fd = Arc::clone(&listen_fd);
    let thread_conn_fd = Arc::clone(&conn_fd);
    let thread_inbox = Arc::clone(&inbox);

    let listener = thread::spawn(move || {
        // SAFETY: creating a libzt TCP socket with valid family/type values
        let fd = unsafe { (thread_api.socket)(ZTS_AF_INET, ZTS_SOCK_STREAM, 0) };
        if fd < 0 {
            push_sys_event(&thread_inbox, "error", &format!("zts_socket failed: {fd}"));
            return;
        }

        let any_ip = CString::new("0.0.0.0").expect("valid static ip");
        // SAFETY: passing a valid C string and socket descriptor to libzt
        let bind_ret = unsafe { (thread_api.bind)(fd, any_ip.as_ptr(), port) };
        if bind_ret < 0 {
            push_sys_event(
                &thread_inbox,
                "error",
                &format!("zts_bind failed: {bind_ret}"),
            );
            zt_close_fd(&thread_api, fd);
            return;
        }

        // SAFETY: valid socket descriptor and backlog
        let listen_ret = unsafe { (thread_api.listen)(fd, 4) };
        if listen_ret < 0 {
            push_sys_event(
                &thread_inbox,
                "error",
                &format!("zts_listen failed: {listen_ret}"),
            );
            zt_close_fd(&thread_api, fd);
            return;
        }

        thread_listen_fd.store(fd, Ordering::SeqCst);
        push_sys_event(
            &thread_inbox,
            "listener_started",
            &format!("signal listening on 0.0.0.0:{port}"),
        );

        while !thread_stop.load(Ordering::SeqCst) {
            let mut remote = [0_i8; ZTS_IP_MAX_STR_LEN + 1];
            let mut remote_port = 0_u16;

            // SAFETY: accept buffer is writable and properly sized
            let client_fd = unsafe {
                (thread_api.accept)(
                    fd,
                    remote.as_mut_ptr(),
                    ZTS_IP_MAX_STR_LEN as i32,
                    &mut remote_port,
                )
            };

            if client_fd < 0 {
                if thread_stop.load(Ordering::SeqCst) {
                    break;
                }
                thread::sleep(Duration::from_millis(200));
                continue;
            }

            let old = thread_conn_fd.swap(client_fd, Ordering::SeqCst);
            if old >= 0 {
                zt_close_fd(&thread_api, old);
            }

            let remote_ip = if remote[0] == 0 {
                "unknown".to_string()
            } else {
                // SAFETY: libzt accept writes a null-terminated IPv4/IPv6 string
                unsafe { CStr::from_ptr(remote.as_ptr()) }
                    .to_string_lossy()
                    .to_string()
            };
            push_sys_event(
                &thread_inbox,
                "connected",
                &format!("viewer connected from {remote_ip}:{remote_port}"),
            );

            let recv_handle = spawn_recv_thread(
                thread_api,
                Arc::clone(&thread_stop),
                Arc::clone(&thread_conn_fd),
                Arc::clone(&thread_inbox),
                client_fd,
                "signal",
            );
            let _ = recv_handle.join();
        }

        let active_conn = thread_conn_fd.swap(-1, Ordering::SeqCst);
        let active_listener = thread_listen_fd.swap(-1, Ordering::SeqCst);
        zt_close_fd(&thread_api, active_conn);
        zt_close_fd(&thread_api, active_listener);
        push_sys_event(&thread_inbox, "listener_stopped", "signal listener stopped");
    });

    let runtime = SignalRuntime {
        api,
        stop,
        listen_fd,
        conn_fd,
        inbox,
        threads: vec![listener],
    };

    let mut guard = signal_slot()
        .lock()
        .map_err(|_| "signal runtime lock poisoned".to_string())?;
    *guard = Some(runtime);

    append_libzt_log_line(&format!("signal listener initialized on {port}"));
    Ok(())
}

#[tauri::command]
fn zt_signal_connect(peer_ip: String, port: u16) -> Result<(), String> {
    if port == 0 {
        return Err("invalid signal port".to_string());
    }
    let peer_ip = peer_ip.trim().to_string();
    if peer_ip.is_empty() {
        return Err("peer_ip is empty".to_string());
    }

    zt_signal_close_internal(false)?;

    let api = get_socket_api()?;

    // SAFETY: creating a libzt TCP socket with valid family/type values
    let fd = unsafe { (api.socket)(ZTS_AF_INET, ZTS_SOCK_STREAM, 0) };
    if fd < 0 {
        return Err(format!("zts_socket failed: {fd}"));
    }

    let peer_cstr = CString::new(peer_ip.clone()).map_err(|e| format!("invalid peer_ip: {e}"))?;
    // SAFETY: passing valid socket descriptor and peer endpoint to libzt
    let connect_ret = unsafe { (api.connect)(fd, peer_cstr.as_ptr(), port, LIBZT_CONNECT_TIMEOUT_MS) };
    if connect_ret < 0 {
        zt_close_fd(&api, fd);
        return Err(format!("zts_connect failed: code={connect_ret}"));
    }

    let stop = Arc::new(AtomicBool::new(false));
    let listen_fd = Arc::new(AtomicI32::new(-1));
    let conn_fd = Arc::new(AtomicI32::new(fd));
    let inbox = Arc::new(Mutex::new(VecDeque::new()));

    push_sys_event(
        &inbox,
        "connected",
        &format!("connected to sharer {peer_ip}:{port}"),
    );

    let recv_handle = spawn_recv_thread(
        api,
        Arc::clone(&stop),
        Arc::clone(&conn_fd),
        Arc::clone(&inbox),
        fd,
        "signal",
    );

    let runtime = SignalRuntime {
        api,
        stop,
        listen_fd,
        conn_fd,
        inbox,
        threads: vec![recv_handle],
    };

    let mut guard = signal_slot()
        .lock()
        .map_err(|_| "signal runtime lock poisoned".to_string())?;
    *guard = Some(runtime);

    append_libzt_log_line(&format!("signal connected to {peer_ip}:{port}"));
    Ok(())
}

#[tauri::command]
fn zt_signal_send(payload: String) -> Result<(), String> {
    if payload.trim().is_empty() {
        return Ok(());
    }

    let (api, conn_fd, inbox) = {
        let guard = signal_slot()
            .lock()
            .map_err(|_| "signal runtime lock poisoned".to_string())?;
        let runtime = guard
            .as_ref()
            .ok_or_else(|| "signal runtime is not initialized".to_string())?;
        (
            runtime.api,
            Arc::clone(&runtime.conn_fd),
            Arc::clone(&runtime.inbox),
        )
    };

    let fd = conn_fd.load(Ordering::SeqCst);
    if fd < 0 {
        return Err("signal peer is not connected".to_string());
    }

    let mut bytes = payload.into_bytes();
    bytes.push(b'\n');

    if let Err(err) = zt_send_all(&api, fd, &bytes) {
        push_sys_event(&inbox, "error", &format!("signal send failed: {err}"));
        return Err(err);
    }

    Ok(())
}

#[tauri::command]
fn zt_signal_poll() -> Result<Vec<String>, String> {
    let inbox = {
        let guard = signal_slot()
            .lock()
            .map_err(|_| "signal runtime lock poisoned".to_string())?;
        let Some(runtime) = guard.as_ref() else {
            return Ok(Vec::new());
        };
        Arc::clone(&runtime.inbox)
    };

    let mut queue = inbox
        .lock()
        .map_err(|_| "signal inbox lock poisoned".to_string())?;

    let mut out = Vec::with_capacity(queue.len());
    while let Some(item) = queue.pop_front() {
        out.push(item);
    }

    Ok(out)
}

#[tauri::command]
fn zt_signal_close() -> Result<(), String> {
    zt_signal_close_internal(false)
}

fn zt_media_close_internal(wait_threads: bool) -> Result<(), String> {
    let mut guard = media_slot()
        .lock()
        .map_err(|_| "media runtime lock poisoned".to_string())?;
    let Some(mut runtime) = guard.take() else {
        return Ok(());
    };

    runtime.stop.store(true, Ordering::SeqCst);

    let conn_fd = runtime.conn_fd.swap(-1, Ordering::SeqCst);
    let listen_fd = runtime.listen_fd.swap(-1, Ordering::SeqCst);
    zt_close_fd(&runtime.api, conn_fd);
    zt_close_fd(&runtime.api, listen_fd);

    let threads = std::mem::take(&mut runtime.threads);
    if wait_threads {
        join_runtime_threads(threads);
    } else {
        join_runtime_threads_async(threads);
    }

    append_libzt_log_line("media runtime closed");
    Ok(())
}

#[tauri::command]
fn zt_media_listen(port: u16) -> Result<(), String> {
    if port == 0 {
        return Err("invalid media port".to_string());
    }

    zt_media_close_internal(false)?;

    let api = get_socket_api()?;
    let stop = Arc::new(AtomicBool::new(false));
    let listen_fd = Arc::new(AtomicI32::new(-1));
    let conn_fd = Arc::new(AtomicI32::new(-1));
    let inbox = Arc::new(Mutex::new(VecDeque::new()));

    let thread_api = api;
    let thread_stop = Arc::clone(&stop);
    let thread_listen_fd = Arc::clone(&listen_fd);
    let thread_conn_fd = Arc::clone(&conn_fd);
    let thread_inbox = Arc::clone(&inbox);

    let listener = thread::spawn(move || {
        // SAFETY: creating a libzt TCP socket with valid family/type values
        let fd = unsafe { (thread_api.socket)(ZTS_AF_INET, ZTS_SOCK_STREAM, 0) };
        if fd < 0 {
            push_sys_event(
                &thread_inbox,
                "error",
                &format!("media zts_socket failed: {fd}"),
            );
            return;
        }

        let any_ip = CString::new("0.0.0.0").expect("valid static ip");
        // SAFETY: passing a valid C string and socket descriptor to libzt
        let bind_ret = unsafe { (thread_api.bind)(fd, any_ip.as_ptr(), port) };
        if bind_ret < 0 {
            push_sys_event(
                &thread_inbox,
                "error",
                &format!("media zts_bind failed: {bind_ret}"),
            );
            zt_close_fd(&thread_api, fd);
            return;
        }

        // SAFETY: valid socket descriptor and backlog
        let listen_ret = unsafe { (thread_api.listen)(fd, 2) };
        if listen_ret < 0 {
            push_sys_event(
                &thread_inbox,
                "error",
                &format!("media zts_listen failed: {listen_ret}"),
            );
            zt_close_fd(&thread_api, fd);
            return;
        }

        thread_listen_fd.store(fd, Ordering::SeqCst);
        push_sys_event(
            &thread_inbox,
            "listener_started",
            &format!("media listening on 0.0.0.0:{port}"),
        );

        while !thread_stop.load(Ordering::SeqCst) {
            let mut remote = [0_i8; ZTS_IP_MAX_STR_LEN + 1];
            let mut remote_port = 0_u16;

            // SAFETY: accept buffer is writable and properly sized
            let client_fd = unsafe {
                (thread_api.accept)(
                    fd,
                    remote.as_mut_ptr(),
                    ZTS_IP_MAX_STR_LEN as i32,
                    &mut remote_port,
                )
            };

            if client_fd < 0 {
                if thread_stop.load(Ordering::SeqCst) {
                    break;
                }
                thread::sleep(Duration::from_millis(200));
                continue;
            }

            let old = thread_conn_fd.swap(client_fd, Ordering::SeqCst);
            if old >= 0 {
                zt_close_fd(&thread_api, old);
            }

            let remote_ip = if remote[0] == 0 {
                "unknown".to_string()
            } else {
                // SAFETY: libzt accept writes a null-terminated IPv4/IPv6 string
                unsafe { CStr::from_ptr(remote.as_ptr()) }
                    .to_string_lossy()
                    .to_string()
            };
            push_sys_event(
                &thread_inbox,
                "connected",
                &format!("media viewer connected from {remote_ip}:{remote_port}"),
            );

            let recv_handle = spawn_recv_thread(
                thread_api,
                Arc::clone(&thread_stop),
                Arc::clone(&thread_conn_fd),
                Arc::clone(&thread_inbox),
                client_fd,
                "media",
            );
            let _ = recv_handle.join();
        }

        let active_conn = thread_conn_fd.swap(-1, Ordering::SeqCst);
        let active_listener = thread_listen_fd.swap(-1, Ordering::SeqCst);
        zt_close_fd(&thread_api, active_conn);
        zt_close_fd(&thread_api, active_listener);
        push_sys_event(&thread_inbox, "listener_stopped", "media listener stopped");
    });

    let runtime = SignalRuntime {
        api,
        stop,
        listen_fd,
        conn_fd,
        inbox,
        threads: vec![listener],
    };

    let mut guard = media_slot()
        .lock()
        .map_err(|_| "media runtime lock poisoned".to_string())?;
    *guard = Some(runtime);

    append_libzt_log_line(&format!("media listener initialized on {port}"));
    Ok(())
}

#[tauri::command]
fn zt_media_connect(peer_ip: String, port: u16) -> Result<(), String> {
    if port == 0 {
        return Err("invalid media port".to_string());
    }
    let peer_ip = peer_ip.trim().to_string();
    if peer_ip.is_empty() {
        return Err("peer_ip is empty".to_string());
    }

    zt_media_close_internal(false)?;

    let api = get_socket_api()?;

    // SAFETY: creating a libzt TCP socket with valid family/type values
    let fd = unsafe { (api.socket)(ZTS_AF_INET, ZTS_SOCK_STREAM, 0) };
    if fd < 0 {
        return Err(format!("media zts_socket failed: {fd}"));
    }

    let peer_cstr = CString::new(peer_ip.clone()).map_err(|e| format!("invalid peer_ip: {e}"))?;
    // SAFETY: passing valid socket descriptor and peer endpoint to libzt
    let connect_ret = unsafe { (api.connect)(fd, peer_cstr.as_ptr(), port, LIBZT_CONNECT_TIMEOUT_MS) };
    if connect_ret < 0 {
        zt_close_fd(&api, fd);
        return Err(format!("media zts_connect failed: code={connect_ret}"));
    }

    let stop = Arc::new(AtomicBool::new(false));
    let listen_fd = Arc::new(AtomicI32::new(-1));
    let conn_fd = Arc::new(AtomicI32::new(fd));
    let inbox = Arc::new(Mutex::new(VecDeque::new()));

    push_sys_event(
        &inbox,
        "connected",
        &format!("media connected to sharer {peer_ip}:{port}"),
    );

    let recv_handle = spawn_recv_thread(
        api,
        Arc::clone(&stop),
        Arc::clone(&conn_fd),
        Arc::clone(&inbox),
        fd,
        "media",
    );

    let runtime = SignalRuntime {
        api,
        stop,
        listen_fd,
        conn_fd,
        inbox,
        threads: vec![recv_handle],
    };

    let mut guard = media_slot()
        .lock()
        .map_err(|_| "media runtime lock poisoned".to_string())?;
    *guard = Some(runtime);

    append_libzt_log_line(&format!("media connected to {peer_ip}:{port}"));
    Ok(())
}

#[tauri::command]
fn zt_media_send(payload: String) -> Result<(), String> {
    if payload.trim().is_empty() {
        return Ok(());
    }

    let (api, conn_fd, inbox) = {
        let guard = media_slot()
            .lock()
            .map_err(|_| "media runtime lock poisoned".to_string())?;
        let runtime = guard
            .as_ref()
            .ok_or_else(|| "media runtime is not initialized".to_string())?;
        (
            runtime.api,
            Arc::clone(&runtime.conn_fd),
            Arc::clone(&runtime.inbox),
        )
    };

    let fd = conn_fd.load(Ordering::SeqCst);
    if fd < 0 {
        return Err("media peer is not connected".to_string());
    }

    let mut bytes = payload.into_bytes();
    bytes.push(b'\n');

    if let Err(err) = zt_send_all(&api, fd, &bytes) {
        push_sys_event(&inbox, "error", &format!("media send failed: {err}"));
        return Err(err);
    }

    Ok(())
}

#[tauri::command]
fn zt_media_poll() -> Result<Vec<String>, String> {
    let inbox = {
        let guard = media_slot()
            .lock()
            .map_err(|_| "media runtime lock poisoned".to_string())?;
        let Some(runtime) = guard.as_ref() else {
            return Ok(Vec::new());
        };
        Arc::clone(&runtime.inbox)
    };

    let mut queue = inbox
        .lock()
        .map_err(|_| "media inbox lock poisoned".to_string())?;

    let mut out = Vec::with_capacity(queue.len());
    while let Some(item) = queue.pop_front() {
        out.push(item);
    }

    Ok(out)
}

#[tauri::command]
fn zt_media_close() -> Result<(), String> {
    zt_media_close_internal(false)
}

#[tauri::command]
fn zt_start(app: tauri::AppHandle, network_id: String) -> Result<String, String> {
    let net_id = parse_network_id(&network_id)?;
    let log_dir = resolve_log_dir(&app)?;
    ensure_log_dir(&log_dir)?;
    let libzt_log_path = log_dir.join("frontend.log");
    set_libzt_log_path(libzt_log_path.clone());

    let mut runtime_guard = runtime_slot()
        .lock()
        .map_err(|_| "libzt runtime lock poisoned".to_string())?;
    if runtime_guard.is_some() {
        append_libzt_log_line("libzt already started");
        return Ok("libzt already started".to_string());
    }

    let dll_path = resolve_libzt_dll_path(&app)?;
    append_libzt_log_line(&format!("loading libzt from {}", dll_path.display()));

    let api = load_libzt_api(&dll_path)?;

    let storage_dir = resolve_libzt_storage_dir(&log_dir);
    ensure_log_dir(&storage_dir)?;
    let storage_path = CString::new(storage_dir.to_string_lossy().to_string())
        .map_err(|e| format!("invalid storage path: {e}"))?;

    // SAFETY: FFI calls with validated pointers and initialization order from libzt API docs
    unsafe {
        check_libzt_ret(
            "zts_init_set_event_handler",
            (api.init_set_event_handler)(Some(libzt_event_handler)),
        )?;
        check_libzt_ret(
            "zts_init_from_storage",
            (api.init_from_storage)(storage_path.as_ptr()),
        )?;
        check_libzt_ret("zts_node_start", (api.node_start)())?;
    }

    let mut online = false;
    for _ in 0..NODE_ONLINE_WAIT_TRIES {
        // SAFETY: no parameters and no aliasing involved
        let status = unsafe { (api.node_is_online)() };
        if status < 0 {
            return Err(format!("zts_node_is_online failed: code={status}"));
        }
        if status == 1 {
            online = true;
            break;
        }
        thread::sleep(Duration::from_millis(NODE_ONLINE_WAIT_INTERVAL_MS));
    }

    if !online {
        append_libzt_log_line("node did not become online within timeout");
    } else {
        append_libzt_log_line("node online");
    }

    // SAFETY: net_id parsed from user hex input
    unsafe {
        check_libzt_ret("zts_net_join", (api.net_join)(net_id))?;
    }

    let mut assigned_ip: Option<String> = None;
    for _ in 0..IP_ASSIGN_WAIT_TRIES {
        assigned_ip = try_get_libzt_ip4(&api, net_id);
        if assigned_ip.is_some() {
            break;
        }
        thread::sleep(Duration::from_millis(IP_ASSIGN_WAIT_INTERVAL_MS));
    }

    if let Some(ip) = &assigned_ip {
        append_libzt_log_line(&format!("joined network {network_id}, ip={ip}"));
    } else {
        append_libzt_log_line(&format!(
            "joined network {network_id}, waiting for ip assignment"
        ));
    }

    *runtime_guard = Some(LibztRuntime {
        api,
        network_id: net_id,
    });

    Ok(format!(
        "libzt started, network={} ip={}",
        network_id,
        assigned_ip.unwrap_or_else(|| "pending".to_string())
    ))
}

#[tauri::command]
fn zt_stop() -> Result<(), String> {
    zt_signal_close_internal(true)?;
    zt_media_close_internal(true)?;

    let mut runtime_guard = runtime_slot()
        .lock()
        .map_err(|_| "libzt runtime lock poisoned".to_string())?;
    let Some(runtime) = runtime_guard.take() else {
        append_libzt_log_line("libzt stop requested but runtime not started");
        return Ok(());
    };

    append_libzt_log_line(&format!("stopping libzt network={:x}", runtime.network_id));

    // SAFETY: runtime holds valid function pointers while library is alive
    unsafe {
        let stop_ret = (runtime.api.node_stop)();
        if stop_ret < 0 {
            append_libzt_log_line(&format!("zts_node_stop failed: code={stop_ret}"));
        }
        if should_call_node_free_on_stop() {
            let free_ret = (runtime.api.node_free)();
            if free_ret < 0 {
                append_libzt_log_line(&format!("zts_node_free failed: code={free_ret}"));
            } else {
                append_libzt_log_line("zts_node_free executed by opt-in env flag");
            }
        }
    }

    Ok(())
}

#[tauri::command]
fn zt_get_ip() -> Result<Option<String>, String> {
    let guard = runtime_slot()
        .lock()
        .map_err(|_| "libzt runtime lock poisoned".to_string())?;
    let Some(runtime) = guard.as_ref() else {
        return Ok(None);
    };

    Ok(try_get_libzt_ip4(&runtime.api, runtime.network_id))
}

#[tauri::command]
fn append_log(app: tauri::AppHandle, message: String) -> Result<(), String> {
    let log_dir = resolve_log_dir(&app)?;
    let log_path = log_dir.join("frontend.log");

    if let Err(err) = ensure_log_dir(&log_dir) {
        return fallback_log(&app, &message, &err);
    }

    if let Err(err) = write_log_line(&log_path, &message) {
        return fallback_log(&app, &message, &err);
    }
    Ok(())
}

#[tauri::command]
fn open_log_dir(app: tauri::AppHandle) -> Result<(), String> {
    let log_dir = resolve_log_dir(&app)?;
    ensure_log_dir(&log_dir).map_err(|e| format!("create log dir: {e}"))?;

    open_directory(&log_dir).map_err(|e| format!("open log dir: {e}"))
}

fn resolve_runtime_base_dir() -> Option<PathBuf> {
    if let Ok(exe_path) = env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            return Some(exe_dir.to_path_buf());
        }
    }

    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest_dir.parent().map(|dir| dir.to_path_buf())
}

fn resolve_log_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(custom) = env::var("FRONTEND_LOG_DIR") {
        if !custom.trim().is_empty() {
            return Ok(PathBuf::from(custom));
        }
    }

    if let Some(base_dir) = resolve_runtime_base_dir() {
        return Ok(base_dir.join("logs"));
    }

    app.path_resolver()
        .app_data_dir()
        .map(|dir| dir.join("logs"))
        .ok_or_else(|| "failed to resolve app data dir".to_string())
}

fn ensure_log_dir(dir: &Path) -> Result<(), String> {
    create_dir_all(dir).map_err(|e| e.to_string())
}

fn write_log_line(path: &Path, message: &str) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    writeln!(file, "{message}").map_err(|e| e.to_string())
}

fn fallback_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path_resolver()
        .app_data_dir()
        .map(|dir| dir.join("logs"))
        .ok_or_else(|| "failed to resolve app data dir".to_string())
}

fn fallback_log(app: &tauri::AppHandle, message: &str, err: &str) -> Result<(), String> {
    let fallback = fallback_dir(app)?;
    ensure_log_dir(&fallback).map_err(|e| format!("fallback create dir: {e}"))?;
    let log_path = fallback.join("frontend.log");
    write_log_line(&log_path, message)
        .map_err(|e| format!("fallback write log: {e}; original error: {err}"))
}

#[cfg(target_os = "windows")]
fn open_directory(path: &Path) -> Result<(), io::Error> {
    Command::new("explorer").arg(path).spawn().map(|_| ())
}

#[cfg(target_os = "macos")]
fn open_directory(path: &Path) -> Result<(), io::Error> {
    Command::new("open").arg(path).spawn().map(|_| ())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_directory(path: &Path) -> Result<(), io::Error> {
    Command::new("xdg-open").arg(path).spawn().map(|_| ())
}

#[cfg(all(not(target_os = "windows"), not(unix)))]
fn open_directory(_path: &Path) -> Result<(), io::Error> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "open directory is not supported on this platform",
    ))
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            append_log,
            open_log_dir,
            zt_start,
            zt_stop,
            zt_get_ip,
            zt_events_poll,
            zt_signal_listen,
            zt_signal_connect,
            zt_signal_send,
            zt_signal_poll,
            zt_signal_close,
            zt_media_listen,
            zt_media_connect,
            zt_media_send,
            zt_media_poll,
            zt_media_close
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
