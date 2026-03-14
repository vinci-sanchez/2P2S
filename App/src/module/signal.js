import { SIGNAL_POLL_INTERVAL_MS, BAD_LINK_HOLD_MS } from "./constants.js";
import { state } from "./state.js";
import { is_tauri, log, log_trace, update_status } from "./logger.js";

// 创建信令处理模块。
function create_signal_module({
  invoke,
  get_media_port,
  mark_transport_activity,
  clear_reconnect_timer,
  schedule_signal_reconnect,
  mark_media_peer_known,
  start_cc_timer,
  stop_cc_timer,
  send_feedback_req,
  stop_viewer_pipeline,
  update_merged_video_view
}) {
  // 设置Share Bad Link State。
  function set_share_bad_link_state(active, reason = "") {
    if (state.role !== "share") {
      return;
    }
    if (active) {
      const entering_bad_link = !state.bad_link_mode;
      state.bad_link_mode = true;
      state.bad_link_until = Math.max(state.bad_link_until || 0, Date.now() + BAD_LINK_HOLD_MS);
      state.bad_link_last_trigger_at = Date.now();
      state.bad_link_last_reason = reason || "";
      if (entering_bad_link) {
        state.force_next_keyframe = true;
      }
      return;
    }
    state.bad_link_until = Date.now();
    if (state.bad_link_mode) {
      state.bad_link_mode = false;
      state.bad_link_last_reason = "";
    }
  }

  // 提取Peer Ip From Signal Message。
  function extract_peer_ip_from_signal_message(message) {
    if (typeof message !== "string" || !message.trim()) {
      return "";
    }
    const from_matched = message.match(/\bfrom\s+([0-9a-fA-F:.]+):\d+\b/i);
    if (from_matched?.[1]) {
      return from_matched[1];
    }
    const fallback_matched = message.match(/\b([0-9a-fA-F:.]+):\d+\b/);
    return fallback_matched?.[1] || "";
  }

  // 同步Media Peer From Signal。
  async function sync_media_peer_from_signal(message) {
    if (!is_tauri() || state.role !== "share" || !state.media_transport_open) {
      return;
    }
    const peer_ip = extract_peer_ip_from_signal_message(message);
    if (!peer_ip) {
      return;
    }
    const media_port = get_media_port();
    await invoke("zt_media_set_peer", {
      peerIp: peer_ip,
      port: media_port
    });
    mark_media_peer_known();
    state.force_next_keyframe = true;
    log(`媒体对端已更新：${peer_ip}:${media_port}`, 0);
  }

  // 发送Signal。
  function send_signal(payload) {
    if (!state.signal_connected) {
      return false;
    }
    const wire = JSON.stringify({
      ...payload,
      client_id: state.client_id,
      session_id: state.session_id || undefined
    });
    invoke("zt_signal_send", {
      payload: wire
    }).then(() => {
      mark_transport_activity("signal");
    }).catch(error => {
      state.signal_connected = false;
      log("信令发送失败", error);
      if (state.role === "viewer") {
        schedule_signal_reconnect("signal-send-failed");
      }
    });
    return true;
  }

  // 发送Join Signal。
  function send_join_signal() {
    return send_signal({
      type: "join",
      role: state.role,
      target: state.peer_target_id || undefined,
      ts: Date.now()
    });
  }

  // 处理Signal Message。
  async function handle_signal_message(msg) {
    log(`recv signal type=${msg?.type || "?"} client_id=${msg?.client_id || "?"} role=${msg?.role || "?"}`, 0);
    if (!msg || msg.client_id === state.client_id) {
      return;
    }
    if (msg.client_id) {
      state.peer_target_id = msg.client_id;
    }
    if (msg.type === "join") {
      state.peer_ready = true;
      if (state.role === "share" && msg.role === "viewer") {
        send_join_signal();
        return;
      }
      if (state.role === "viewer" && msg.role === "share" && state.start_requested) {
        start_cc_timer();
        await send_feedback_req();
      }
      return;
    }
    if (msg.type === "share-ended") {
      if (state.role === "viewer") {
        stop_cc_timer();
        stop_viewer_pipeline();
        state.start_requested = false;
        state.peer_ready = false;
        update_merged_video_view();
        update_status("远端已停止共享", "#f6c177");
        log("收到远端停止共享通知", 0);
      }
      return;
    }
    if (msg.type === "bad-link") {
      if (state.role === "share") {
        set_share_bad_link_state(true, msg.reason || "");
        log(`收到远端坏秒通知${msg.reason ? ` | ${msg.reason}` : ""}`, 0);
      }
      return;
    }
    if (msg.type === "bad-link-clear") {
      if (state.role === "share") {
        const was_bad_link = state.bad_link_mode;
        set_share_bad_link_state(false);
        if (was_bad_link) {
          log("收到远端坏秒恢复通知", 0);
        }
      }
      return;
    }
    if (msg.type === "ping") {
      send_signal({
        type: "pong",
        role: state.role,
        target: msg.client_id || undefined,
        ts: msg.ts
      });
    }
  }

  // 处理Signal System。
  async function handle_signal_system(sys_msg) {
    const event = sys_msg.__sys;
    const message = sys_msg.message || "";
    log(`signal sys: ${event}${message ? ` | ${message}` : ""}`, 0);
    log_trace("signal sys", `event=${event}${message ? `, message=${message}` : ""}`);
    if (event === "listener_started") {
      state.signal_listening = true;
      if (state.role === "share") {
        update_status("信令监听中", "#f6c177");
      }
      return;
    }
    if (event === "listener_stopped") {
      state.signal_listening = false;
      state.signal_connected = false;
      if (!state.transport_resetting) {
        schedule_signal_reconnect("signal-listener-stopped");
      }
      return;
    }
    if (event === "connected") {
      state.signal_connected = true;
      state.reconnect_attempts = 0;
      clear_reconnect_timer();
      try {
        await sync_media_peer_from_signal(message);
      } catch (error) {
        log("同步媒体对端失败", error, 0);
      }
      send_join_signal();
      if (state.role === "viewer" && state.start_requested) {
        start_cc_timer();
        await send_feedback_req();
      }
      if (state.media_transport_open) {
        update_status("已连接", "#7ee787");
      } else {
        update_status("信令已连接", "#7ee787");
      }
      return;
    }
    if (event === "disconnected") {
      state.signal_connected = false;
      if (!state.transport_resetting && (state.role === "viewer" || !state.signal_listening)) {
        schedule_signal_reconnect("signal-disconnected");
      }
      return;
    }
    if (event === "error" && !state.transport_resetting) {
      schedule_signal_reconnect("signal-error");
    }
  }

  // 轮询Signal Messages。
  async function poll_signal_messages() {
    if (state.signal_poll_busy || !is_tauri()) {
      return;
    }
    state.signal_poll_busy = true;
    try {
      const lines = await invoke("zt_signal_poll");
      if (!Array.isArray(lines) || lines.length === 0) {
        return;
      }
      for (const line of lines) {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch (error) {
          log(`信令消息解析失败: ${line}`, error, 0);
          continue;
        }
        mark_transport_activity("signal");
        if (msg && msg.__sys) {
          await handle_signal_system(msg);
        } else {
          await handle_signal_message(msg);
        }
      }
    } catch (error) {
      log("轮询信令失败", error, 0);
    } finally {
      state.signal_poll_busy = false;
    }
  }

  // 停止Signal Pump。
  function stop_signal_pump() {
    if (state.signal_pump_timer) {
      clearInterval(state.signal_pump_timer);
      state.signal_pump_timer = null;
    }
    state.signal_poll_busy = false;
  }

  // 启动Signal Pump。
  function start_signal_pump() {
    if (state.signal_pump_timer) {
      return;
    }
    state.signal_pump_timer = setInterval(() => {
      poll_signal_messages().catch(error => log("signal pump error", error, 0));
    }, SIGNAL_POLL_INTERVAL_MS);
  }
  return {
    send_signal,
    send_join_signal,
    start_signal_pump,
    stop_signal_pump
  };
}
export { create_signal_module };
