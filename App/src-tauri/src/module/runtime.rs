use super::*;

#[tauri::command]
pub(crate) fn zt_start(app: tauri::AppHandle, network_id: String) -> Result<String, String> {
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
pub(crate) fn zt_stop() -> Result<(), String> {
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
pub(crate) fn zt_get_ip() -> Result<Option<String>, String> {
    let guard = runtime_slot()
        .lock()
        .map_err(|_| "libzt runtime lock poisoned".to_string())?;
    let Some(runtime) = guard.as_ref() else {
        return Ok(None);
    };

    Ok(try_get_libzt_ip4(&runtime.api, runtime.network_id))
}
