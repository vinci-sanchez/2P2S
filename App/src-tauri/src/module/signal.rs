use super::*;

pub(crate) fn zt_signal_close_internal(wait_threads: bool) -> Result<(), String> {
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
pub(crate) fn zt_signal_listen(port: u16) -> Result<(), String> {
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
pub(crate) fn zt_signal_connect(peer_ip: String, port: u16) -> Result<(), String> {
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
    let connect_ret = unsafe {
        (api.connect)(
            fd,
            peer_cstr.as_ptr(),
            port,
            LIBZT_SIGNAL_CONNECT_TIMEOUT_MS,
        )
    };
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
pub(crate) fn zt_signal_send(payload: String) -> Result<(), String> {
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
pub(crate) fn zt_signal_poll() -> Result<Vec<String>, String> {
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
pub(crate) fn zt_signal_close() -> Result<(), String> {
    zt_signal_close_internal(false)
}

// 关闭媒体运行时：停止线程并关闭 UDP fd。
