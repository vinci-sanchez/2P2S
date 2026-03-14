use super::*;

pub(crate) fn zt_media_close_internal(wait_threads: bool) -> Result<(), String> {
    let mut guard = media_slot()
        .lock()
        .map_err(|_| "media runtime lock poisoned".to_string())?;
    let Some(mut runtime) = guard.take() else {
        return Ok(());
    };

    runtime.stop.store(true, Ordering::SeqCst);
    runtime.send_queue.cv.notify_all();

    let fd = runtime.fd.swap(-1, Ordering::SeqCst);
    zt_close_fd(&runtime.api, fd);

    let threads = std::mem::take(&mut runtime.threads);
    if wait_threads {
        join_runtime_threads(threads);
    } else {
        join_runtime_threads_async(threads);
    }

    append_libzt_log_line("media runtime closed");
    Ok(())
}

// 启动媒体运行时：创建并绑定 UDP socket，启动接收线程并维护 peer 信息。
fn start_media_runtime(bind_port: u16, preset_peer: Option<(String, u16)>) -> Result<(), String> {
    zt_media_close_internal(false)?;

    let api = get_socket_api()?;
    let stop = Arc::new(AtomicBool::new(false));
    let fd_slot = Arc::new(AtomicI32::new(-1));
    let inbox = Arc::new(Mutex::new(VecDeque::<Vec<u8>>::new()));
    let peer = Arc::new(Mutex::new(None));
    let send_queue = media_send_queue_slot();

    // SAFETY: creating a libzt UDP socket with valid family/type values
    let fd = unsafe { (api.socket)(ZTS_AF_INET, ZTS_SOCK_DGRAM, 0) };
    if fd < 0 {
        return Err(format!("media zts_socket(dgram) failed: {fd}"));
    }

    let any_ip = CString::new("0.0.0.0").expect("valid static ip");
    // SAFETY: passing a valid C string and socket descriptor to libzt
    let bind_ret = unsafe { (api.bind)(fd, any_ip.as_ptr(), bind_port) };
    if bind_ret < 0 {
        zt_close_fd(&api, fd);
        return Err(format!("media zts_bind failed: {bind_ret}"));
    }

    fd_slot.store(fd, Ordering::SeqCst);

    if let Some((peer_ip, peer_port)) = preset_peer {
        set_media_peer(&api, &fd_slot, &peer, peer_ip, peer_port)?;
    }

    let recv_api = api;
    let recv_stop = Arc::clone(&stop);
    let recv_fd_slot = Arc::clone(&fd_slot);
    let recv_inbox = Arc::clone(&inbox);
    let recv_peer = Arc::clone(&peer);
    let recv_thread = thread::spawn(move || {
        let mut buffer = [0_u8; 2048];
        while !recv_stop.load(Ordering::SeqCst) {
            let current_fd = recv_fd_slot.load(Ordering::SeqCst);
            if current_fd < 0 {
                break;
            }
            let mut remote = [0_i8; ZTS_IP_MAX_STR_LEN + 1];
            let mut remote_port = 0_u16;
            let n = if let Some(recvfrom) = recv_api.recvfrom {
                // SAFETY: recvfrom writes into valid mutable buffers.
                unsafe {
                    recvfrom(
                        current_fd,
                        buffer.as_mut_ptr() as *mut c_void,
                        buffer.len(),
                        0,
                        remote.as_mut_ptr(),
                        ZTS_IP_MAX_STR_LEN as i32,
                        &mut remote_port,
                    )
                }
            } else {
                // SAFETY: recv writes into a valid mutable buffer.
                unsafe { (recv_api.recv)(current_fd, buffer.as_mut_ptr() as *mut c_void, buffer.len(), 0) }
            };

            if n > 0 {
                let packet = buffer[..n as usize].to_vec();
                push_media_packet(&recv_inbox, packet);

                if remote[0] != 0 {
                    let remote_ip = unsafe { CStr::from_ptr(remote.as_ptr()) }
                        .to_string_lossy()
                        .to_string();
                    if !remote_ip.is_empty() {
                        if let Ok(mut guard) = recv_peer.lock() {
                            let should_update = guard
                                .as_ref()
                                .map(|p| p.ip != remote_ip || p.port != remote_port)
                                .unwrap_or(true);
                            if should_update {
                                if let Ok(new_peer) = make_media_peer(remote_ip.clone(), remote_port)
                                {
                                    *guard = Some(new_peer);
                                }
                            }
                        }
                    }
                }
                continue;
            }

            if n == 0 {
                thread::sleep(Duration::from_millis(1));
                continue;
            }

            if recv_stop.load(Ordering::SeqCst) {
                break;
            }
            thread::sleep(Duration::from_millis(2));
        }

        let closed_fd = recv_fd_slot.swap(-1, Ordering::SeqCst);
        zt_close_fd(&recv_api, closed_fd);
    });

    let send_thread = spawn_media_send_thread(
        api,
        Arc::clone(&stop),
        Arc::clone(&fd_slot),
        Arc::clone(&peer),
        Arc::clone(&send_queue),
    );

    let runtime = MediaRuntime {
        api,
        stop,
        fd: fd_slot,
        inbox,
        peer,
        send_queue,
        threads: vec![recv_thread, send_thread],
    };

    let mut guard = media_slot()
        .lock()
        .map_err(|_| "media runtime lock poisoned".to_string())?;
    *guard = Some(runtime);

    append_libzt_log_line(&format!("media udp opened on 0.0.0.0:{bind_port}"));
    Ok(())
}

#[tauri::command]
// 共享端入口：监听本地媒体 UDP 端口。
pub(crate) fn zt_media_listen(port: u16) -> Result<(), String> {
    if port == 0 {
        return Err("invalid media port".to_string());
    }
    start_media_runtime(port, None)
}

#[tauri::command]
// 观看端入口：启动本地 UDP 并预设远端 peer 地址。
pub(crate) fn zt_media_connect(peer_ip: String, port: u16) -> Result<(), String> {
    if port == 0 {
        return Err("invalid media port".to_string());
    }
    let peer_ip = peer_ip.trim().to_string();
    if peer_ip.is_empty() {
        return Err("peer_ip is empty".to_string());
    }
    start_media_runtime(port, Some((peer_ip, port)))
}

#[tauri::command]
// 运行中动态修改媒体 peer（用于地址变化或首次学习后覆盖）。
pub(crate) fn zt_media_set_peer(peer_ip: String, port: u16) -> Result<(), String> {
    if port == 0 {
        return Err("invalid media peer port".to_string());
    }
    let peer_ip = peer_ip.trim().to_string();
    if peer_ip.is_empty() {
        return Err("peer_ip is empty".to_string());
    }

    let guard = media_slot()
        .lock()
        .map_err(|_| "media runtime lock poisoned".to_string())?;
    let runtime = guard
        .as_ref()
        .ok_or_else(|| "media runtime is not initialized".to_string())?;
    set_media_peer(&runtime.api, &runtime.fd, &runtime.peer, peer_ip, port)
}

#[tauri::command]
// 发送单个媒体 UDP 包。
pub(crate) fn zt_media_send(payload: Vec<u8>) -> Result<(), String> {
    if payload.is_empty() {
        return Ok(());
    }

    let guard = media_slot()
        .lock()
        .map_err(|_| "media runtime lock poisoned".to_string())?;
    let runtime = guard
        .as_ref()
        .ok_or_else(|| "media runtime is not initialized".to_string())?;
    media_send_packet(runtime, &payload)
}

#[tauri::command]
// 按批次发送媒体 UDP 包，并在 spread_ms 窗口内做 pacing。
pub(crate) fn zt_media_send_batch(
    packets: Vec<Vec<u8>>,
    spread_ms: u16,
    batch_tag: Option<String>,
) -> Result<(), String> {
    if packets.is_empty() {
        return Ok(());
    }
    if packets.len() > MEDIA_MAX_BATCH_PACKETS {
        return Err(format!(
            "media packet batch too large: {} (max={MEDIA_MAX_BATCH_PACKETS})",
            packets.len()
        ));
    }

    let batch_tag = batch_tag.unwrap_or_else(|| "delta".to_string());
    let send_queue = {
        let guard = media_slot()
            .lock()
            .map_err(|_| "media runtime lock poisoned".to_string())?;
        let runtime = guard
            .as_ref()
            .ok_or_else(|| "media runtime is not initialized".to_string())?;
        Arc::clone(&runtime.send_queue)
    };

    enqueue_media_send_batch(
        &send_queue,
        MediaSendBatch {
            priority: classify_media_batch_priority(&batch_tag, packets.len(), spread_ms),
            packets,
            spread_ms,
        },
    )
}

#[tauri::command]
// 轮询拉取已接收的媒体 UDP 包（一次最多返回固定上限）。
pub(crate) fn zt_media_poll() -> Result<Vec<Vec<u8>>, String> {
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

    let mut out = Vec::with_capacity(queue.len().min(MEDIA_MAX_BATCH_PACKETS));
    while let Some(item) = queue.pop_front() {
        out.push(item);
        if out.len() >= MEDIA_MAX_BATCH_PACKETS {
            break;
        }
    }

    Ok(out)
}

#[tauri::command]
// 对外关闭媒体通道命令。
pub(crate) fn zt_media_close() -> Result<(), String> {
    zt_media_close_internal(false)
}
