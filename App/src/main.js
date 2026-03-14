import { invoke } from "@tauri-apps/api/tauri";
import config from "../config.js";
import {
  SHARE_PROFILES,
  DEFAULT_QUALITY,
  MEDIA_POLL_INTERVAL_MS,
  LIBZT_EVENT_POLL_INTERVAL_MS,
  STATS_INTERVAL_MS,
  METRICS_LOG_INTERVAL_MS,
  OFFLINE_DEBOUNCE_MS,
  LIBZT_OFFLINE_IDLE_INVALIDATE_MS,
  LIBZT_READY_GRACE_MS,
  LIBZT_READY_POLL_MS,
  SIGNAL_RECONNECT_DELAYS_MS,
  MAX_AUTO_RECONNECT_ATTEMPTS,
  VIEWER_CONNECT_MAX_ATTEMPTS,
  VIEWER_CONNECT_RETRY_DELAY_MS,
  LIBZT_NOISY_EVENT_MARKERS,
} from "./module/constants.js";
import { state } from "./module/state.js";
import { ui } from "./module/ui.js";
import {
  is_tauri,
  log,
  log_trace,
  update_status,
  update_remote_stats,
  update_merged_video_view,
} from "./module/logger.js";
import { create_media_module } from "./module/media.js";
import { create_signal_module } from "./module/signal.js";

// 获取Signal Port。
function get_signal_port() {
  const input = Number(ui.port.value);
  if (Number.isFinite(input) && input > 0 && input <= 65535) {
    return input;
  }
  return Number(config.signaling.defaultPort) || 34157;
}

// 获取媒体端口（信令端口+1）。
function get_media_port() {
  const base = get_signal_port();
  return base >= 65535 ? 65535 : base + 1;
}

// 获取当前选择的清晰度档位。
function get_selected_profile() {
  const profile_key = ui.quality_select?.value || DEFAULT_QUALITY;
  const profile =
    SHARE_PROFILES[profile_key] || SHARE_PROFILES[DEFAULT_QUALITY];
  return {
    profile_key,
    profile,
  };
}

// 记录信令或媒体变档
function log_selected_profile_change(reason = "user") {
  const { profile_key, profile } = get_selected_profile();
  if (state.last_user_selected_profile_key === profile_key) {
    return;
  }
  state.last_user_selected_profile_key = profile_key;
  log(
    `selected profile changed | reason=${reason} profile=${profile_key} res=${profile.width}x${profile.height} max_bitrate_kbps=${profile.maxBitrateKbps} max_fps=${profile.maxFps}`,
    0,
  );
}
const busy_controls = [
  ui.connect_btn,
  ui.start_btn,
  ui.role_select,
  ui.port,
  ui.network_input,
  ui.peer_ip,
  ui.quality_select,
];
const always_enabled_controls = [ui.stop_btn, ui.open_log_btn];

// 设置按钮状态；支持单个控件或控件数组。
function set_buttons_busy(controls, busy) {
  const targets = Array.isArray(controls) ? controls : [controls];
  const disabled = Boolean(busy);
  for (const control of targets) {
    if (control) {
      control.disabled = disabled;
    }
  }
}

//异步等待
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 判断当前连接是否应停止：手动断开，或这次尝试已被新的连接轮次替代。
function should_stop_current_connect(connect_epoch) {
  const is_stale_connect_attempt = connect_epoch !== state.reconnect_epoch;
  return state.manual_disconnect || is_stale_connect_attempt;
}

// 连接阶段可视化回调（状态栏 + trace）。
function report_connect_stage(stage, detail = "") {
  update_status(stage, "#f6c177");
  if (detail) {
    log_trace("connect stage", `${stage} | ${detail}`);
  } else {
    log_trace("connect stage", stage);
  }
}

// 观看端：短超时 + 多次快速重试连接。
async function connect_viewer_with_retry({
  peer_ip,
  signal_port,
  media_port,
  connect_epoch,
}) {
  let last_error = null;
  for (let i = 0; i < VIEWER_CONNECT_MAX_ATTEMPTS; i += 1) {
    if (should_stop_current_connect(connect_epoch)) {
      return;
    }
    const attempt = i + 1;
    report_connect_stage(
      "连接对端",
      `peer=${peer_ip}, signal=${signal_port}, media=${media_port}`,
    );
    try {
      await invoke("zt_signal_connect", {
        peerIp: peer_ip,
        port: signal_port,
      });
      await invoke("zt_media_connect", {
        peerIp: peer_ip,
        port: media_port,
      });
      return;
    } catch (error) {
      last_error = error;
      await close_transports();
      if (attempt < VIEWER_CONNECT_MAX_ATTEMPTS) {
        log(
          `观看端连接尝试失败，${VIEWER_CONNECT_RETRY_DELAY_MS}ms 后重试 (${attempt}/${VIEWER_CONNECT_MAX_ATTEMPTS})`,
          error,
          0,
        );
        await sleep(VIEWER_CONNECT_RETRY_DELAY_MS);
      }
    }
  }
  throw last_error || new Error("观看端连接失败：重试已耗尽");
}

// 滑动时间窗口计数器
function count_metric_ts(arr, now, window_ms) {
  const deadline = now - window_ms;
  while (arr.length > 0 && arr[0] < deadline) {
    arr.shift();
  }
  return arr.length;
}

// 清空每秒统计计数器。
function reset_second_metrics() {
  state.rx_pkts_sec = 0;
  state.rx_bytes_sec = 0;
  state.rx_frames_completed_sec = 0;
  state.rx_frames_played_sec = 0;
  state.rx_drop_deadline_sec = 0;
  state.rx_late_after_deadline_pkts_sec = 0;
  state.rx_expired_frames_sec = 0;
  state.rx_missing_on_deadline_pkts_sec = 0;
  state.rx_completed_frame_pkt_total_sec = 0;
  state.rx_data_pkts_sec = 0;
  state.rx_out_of_order_pkts_sec = 0;
  state.rx_nack_enqueued_sec = 0;
  state.rx_nack_sent_sec = 0;
  state.rx_nack_active_frames_sec = 0;
  state.rx_nack_budget_active_frames.clear();
  state.rx_nack_skipped_rtt_sec = 0;
  state.rx_nack_skipped_missing_sec = 0;
  state.rx_nack_skipped_rounds_sec = 0;
  state.tx_pkts_sec = 0;
  state.tx_bytes_sec = 0;
  state.tx_captured_frames_sec = 0;
  state.tx_capture_skip_cadence_sec = 0;
  state.tx_encode_attempt_sec = 0;
  state.tx_encode_budget_drop_sec = 0;
  state.tx_encoded_frames_sec = 0;
  state.tx_frames_sent_sec = 0;
  state.tx_keyframes_sec = 0;
  state.tx_frame_pkt_total_sec = 0;
  state.nack_rx_sec = 0;
}

// 清除重连定时器。
function clear_reconnect_timer() {
  if (state.reconnect_timer) {
    clearTimeout(state.reconnect_timer);
    state.reconnect_timer = null;
  }
}

// 判断 libzt 是否满足发起网络连接条件。
function has_libzt_net_ready() {
  const has_ip = Boolean(
    ui.host_ip && ui.host_ip.value && ui.host_ip.value !== "0.0.0.0",
  );
  if (has_ip) {
    return true;
  }
  return state.libzt_node_online && state.libzt_network_ready;
}

// 清除离线防抖定时器。
function clear_offline_timer() {
  if (state.libzt_offline_timer) {
    clearTimeout(state.libzt_offline_timer);
    state.libzt_offline_timer = null;
  }
}
// 检查通讯和信令活动
function mark_transport_activity(kind) {
  const now = Date.now();
  if (kind === "signal") {
    state.last_signal_activity_at = now;
    return;
  }
  if (kind === "media") {
    state.last_media_activity_at = now;
  }
}

function get_last_transport_activity_at() {
  return Math.max(
    state.last_signal_activity_at || 0,
    state.last_media_activity_at || 0,
  );
}

function has_recent_transport_activity(now = Date.now()) {
  const last_activity_at = get_last_transport_activity_at();
  return (
    last_activity_at > 0 &&
    now - last_activity_at <= LIBZT_OFFLINE_IDLE_INVALIDATE_MS
  );
}

function build_soft_offline_invalidation_reason(now, reason) {
  const offline_for_ms = state.libzt_offline_since
    ? now - state.libzt_offline_since
    : -1;
  const last_signal_ms = state.last_signal_activity_at
    ? now - state.last_signal_activity_at
    : -1;
  const last_media_ms = state.last_media_activity_at
    ? now - state.last_media_activity_at
    : -1;
  const last_transport_ms = get_last_transport_activity_at()
    ? now - get_last_transport_activity_at()
    : -1;
  return [
    `reason=${reason}`,
    `offline_for_ms=${offline_for_ms}`,
    `last_signal_activity_ms=${last_signal_ms}`,
    `last_media_activity_ms=${last_media_ms}`,
    `last_transport_activity_ms=${last_transport_ms}`,
    `idle_threshold_ms=${LIBZT_OFFLINE_IDLE_INVALIDATE_MS}`,
    `signal_connected=${state.signal_connected}`,
    `signal_listening=${state.signal_listening}`,
    `media_open=${state.media_transport_open}`,
    `start_requested=${state.start_requested}`,
    `peer_ready=${state.peer_ready}`,
  ].join(" ");
}

async function invalidate_transports_for_libzt_offline(reason) {
  if (
    state.transport_resetting ||
    state.libzt_transport_invalidated ||
    state.manual_disconnect
  ) {
    return;
  }
  state.libzt_transport_invalidated = true;
  stop_cc_timer();
  state.peer_ready = false;
  log_trace("libzt offline invalidate", `reason=${reason}`);
  update_status("ZeroTier 离线，旧通道失效，等待恢复", "#ffb4a2");
  state.transport_resetting = true;
  try {
    await close_transports();
  } catch (error) {
    log("离线后关闭旧通道失败", error, 0);
  } finally {
    state.transport_resetting = false;
  }
}
//评估 libzt 软离线状态：如果长时间没有信令或媒体活动
async function evaluate_libzt_soft_offline(reason = "periodic") {
  if (
    state.libzt_node_online ||
    state.manual_disconnect ||
    !state.auto_reconnect_enabled ||
    !state.libzt_reonline_need_restore ||
    state.transport_resetting ||
    state.connecting ||
    state.libzt_transport_invalidated
  ) {
    return;
  }
  const now = Date.now();
  if (!state.libzt_offline_since) {
    state.libzt_offline_since = now;
  }
  if (has_recent_transport_activity(now)) {
    return;
  }
  log(
    `判定旧通道已死 | ${build_soft_offline_invalidation_reason(now, reason)}`,
    0,
  );
  await invalidate_transports_for_libzt_offline(reason);
}

// 重置媒体对端状态。
function reset_media_peer_state() {
  state.media_peer_known = false;
  state.media_peer_unknown_notified = false;
}

// 标记媒体对端就绪。
function mark_media_peer_known() {
  state.media_peer_known = true;
  state.media_peer_unknown_notified = false;
}

// 清理对端会话状态。
function clear_peer_session_state() {
  state.peer_ready = false;
  state.peer_target_id = "";
  state.session_id = "";
}

// 停止媒体轮询。
function stop_media_pump() {
  if (state.media_pump_timer) {
    clearInterval(state.media_pump_timer);
    state.media_pump_timer = null;
  }
  state.media_poll_busy = false;
}

// 停止 libzt 事件轮询。
function stop_libzt_event_pump() {
  if (state.libzt_event_pump_timer) {
    clearInterval(state.libzt_event_pump_timer);
    state.libzt_event_pump_timer = null;
  }
  state.libzt_event_poll_busy = false;
}

// 关闭信令通道。
async function close_signal_transport() {
  stop_signal_pump();
  state.signal_connected = false;
  state.signal_listening = false;
  state.last_signal_activity_at = 0;
  if (!is_tauri()) {
    return;
  }
  try {
    await invoke("zt_signal_close");
  } catch (error) {
    log("关闭信令通道失败", error, 0);
  }
}

// 关闭媒体通道。
async function close_media_transport() {
  stop_media_pump();
  state.media_transport_open = false;
  state.last_media_activity_at = 0;
  reset_media_peer_state();
  set_libzt_route_status("UNKNOWN");
  if (!is_tauri()) {
    return;
  }
  try {
    await invoke("zt_media_close");
  } catch (error) {
    log("关闭媒体通道失败", error, 0);
  }
}

// 关闭传输通道。
async function close_transports() {
  await close_signal_transport();
  await close_media_transport();
}

// 判断是否允许触发自动重连。
function should_schedule_reconnect() {
  if (state.role === "viewer") {
    return true;
  }
  return !state.signal_listening;
}

// 调度重连。
function schedule_signal_reconnect(reason) {
  if (state.manual_disconnect || !state.auto_reconnect_enabled) {
    return;
  }
  if (!should_schedule_reconnect()) {
    log_trace("skip reconnect", `reason=${reason}, role=${state.role}`);
    return;
  }
  if (state.reconnect_timer || state.connecting) {
    return;
  }
  if (state.reconnect_attempts >= MAX_AUTO_RECONNECT_ATTEMPTS) {
    state.auto_reconnect_enabled = false;
    clear_reconnect_timer();
    set_buttons_busy(busy_controls, false);
    set_buttons_busy(always_enabled_controls, false);
    update_status("重连已停止，请手动重试", "#ffb4a2");
    log(
      `自动重连已达上限(${MAX_AUTO_RECONNECT_ATTEMPTS}次)，停止重连，reason=${reason}, role=${state.role}`,
    );
    return;
  }
  const idx = Math.min(
    state.reconnect_attempts,
    SIGNAL_RECONNECT_DELAYS_MS.length - 1,
  );
  const delay = SIGNAL_RECONNECT_DELAYS_MS[idx];
  state.reconnect_attempts += 1;
  update_status(`重连中(${state.reconnect_attempts})`, "#f6c177");
  log(`通道重连调度：${delay}ms 后重连，reason=${reason}, role=${state.role}`);
  log_trace("schedule reconnect", `reason=${reason}, delayMs=${delay}`);
  const epoch = state.reconnect_epoch;
  state.reconnect_timer = setTimeout(async () => {
    state.reconnect_timer = null;
    if (epoch !== state.reconnect_epoch) {
      return;
    }
    if (state.manual_disconnect || !state.auto_reconnect_enabled) {
      return;
    }
    try {
      /////////////////////////////////////////////////////////////////////////////////////////////////////////////////不知道怎么实现的
      await connect_channels({
        is_reconnect: true,
        expected_reconnect_epoch: epoch,
      });
      if (state.role === "viewer" && state.start_requested) {
        start_cc_timer();
      }
    } catch (error) {
      log("通道重连失败", error);
      schedule_signal_reconnect("retry-failed");
    }
  }, delay);
}

// 发送媒体包批次（每帧铺开发送）。
async function send_media_batch(packets, spread_ms, batch_tag = "delta") {
  if (!state.media_transport_open || !packets.length) {
    return false;
  }
  if (state.role === "share" && !state.media_peer_known) {
    return false;
  }
  const payloads = packets.map((bytes) => Array.from(bytes));
  try {
    await invoke("zt_media_send_batch", {
      packets: payloads,
      spreadMs: Math.max(0, Math.floor(spread_ms)),
      batchTag: batch_tag,
    });
    return true;
  } catch (error) {
    const message = error?.message || String(error || "");
    if (message.includes("media peer is unknown")) {
      state.media_peer_known = false;
      if (!state.media_peer_unknown_notified) {
        log("媒体对端尚未就绪，暂不发送媒体包", 0);
        state.media_peer_unknown_notified = true;
      }
      return false;
    }
    throw error;
  }
}
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// 轮询Tauri收到的udp数据包，提交媒体
async function poll_media_packets() {
  if (state.media_poll_busy || !is_tauri() || !state.media_transport_open) {
    return;
  }
  state.media_poll_busy = true;
  try {
    const packets = await invoke("zt_media_poll");
    if (!Array.isArray(packets) || packets.length === 0) {
      check_rx_health();
      evaluate_libzt_soft_offline("media-idle").catch((error) =>
        log("离线活性检测失败", error, 0),
      );
      return;
    }
    mark_transport_activity("media");
    for (const packet of packets) {
      if (!Array.isArray(packet) || packet.length === 0) {
        continue;
      }
      handle_incoming_media_packet(new Uint8Array(packet));
    }
    check_rx_health();
  } catch (error) {
    log("轮询媒体失败", error, 0);
  } finally {
    state.media_poll_busy = false;
  }
}

// 启动媒体轮询。
function start_media_pump() {
  if (state.media_pump_timer) {
    return;
  }
  state.media_pump_timer = setInterval(() => {
    poll_media_packets().catch((error) => log("media pump error", error, 0));
  }, MEDIA_POLL_INTERVAL_MS);
}

// 处理 libzt 离线防抖。
function handle_libzt_offline() {
  if (state.libzt_offline_timer) {
    return;
  }
  state.libzt_offline_timer = setTimeout(() => {
    state.libzt_offline_timer = null;
    if (state.libzt_node_online) {
      return;
    }
    const had_session =
      state.signal_connected ||
      state.signal_listening ||
      state.media_transport_open ||
      state.start_requested;
    state.libzt_reonline_need_restore = had_session;
    log_trace("libzt offline debounced", `hadSession=${had_session}`);
    if (
      had_session &&
      state.auto_reconnect_enabled &&
      !state.manual_disconnect
    ) {
      update_status("ZeroTier 离线，保留现有通道观察中", "#ffb4a2");
      evaluate_libzt_soft_offline("offline-debounced").catch((error) =>
        log("离线观察失败", error, 0),
      );
    }
  }, OFFLINE_DEBOUNCE_MS);
}


// 处理 libzt 在线恢复。
function handle_libzt_online() {
  const need_restore = state.libzt_reonline_need_restore;
  state.libzt_node_online = true;
  state.libzt_offline_since = 0;
  if (
    need_restore &&
    state.libzt_transport_invalidated &&
    !state.manual_disconnect &&
    state.auto_reconnect_enabled
  ) {
    state.libzt_reonline_need_restore = false;
    schedule_signal_reconnect("libzt-online-restore");
  }
}

// 获取路由状态（直连/中继/不可达/未知/离线）
function get_route_label() {
  if (!state.libzt_node_online) {
    return "OFFLINE";
  }
  return state.libzt_route_status || "UNKNOWN";
}

// 设置Libzt 路由状态
function set_libzt_route_status(next_status) {
  if (state.libzt_route_status !== next_status) {
    state.libzt_route_status = next_status;
    state.libzt_route_changed_at = Date.now();
  }
  return;
}

// 轮询 libzt 事件。
async function poll_libzt_events() {
  if (state.libzt_event_poll_busy || !is_tauri()) {
    return;
  }
  state.libzt_event_poll_busy = true;
  try {
    const events = await invoke("zt_events_poll");
    if (!Array.isArray(events) || events.length === 0) {
      return;
    }
    for (const event_line of events) {
      //处理非法日志事件
      // if (typeof event_line !== "string" || !event_line.trim()) {
      //   continue;
      // }
      /////////////////////////////////////////////////////////////////////////////////////////////////////////
      const is_noisy_libzt_event = LIBZT_NOISY_EVENT_MARKERS.some((marker) =>
        event_line.includes(marker),
      );
      if (!is_noisy_libzt_event) {
        log(`[libzt] ${event_line}`, 0);
      }
      if (event_line.includes("(NODE_ONLINE)")) {
        state.libzt_node_online = true;
        if (
          !state.libzt_route_status ||
          state.libzt_route_status === "OFFLINE"
        ) {
          set_libzt_route_status("UNKNOWN");
        }
        clear_offline_timer();
        handle_libzt_online();
      } else if (event_line.includes("(NODE_OFFLINE)")) {
        state.libzt_node_online = false;
        state.libzt_network_ready = false;
        if (!state.libzt_offline_since) {
          state.libzt_offline_since = Date.now();
        }
        set_libzt_route_status("OFFLINE");
        handle_libzt_offline();
      } else if (
        event_line.includes("(NETWORK_READY_IP4)") ||
        event_line.includes("(NETWORK_OK)")
      ) {
        state.libzt_network_ready = true;
      } else if (event_line.includes("(NETWORK_DOWN)")) {
        state.libzt_network_ready = false;
      } else if (event_line.includes("(PEER_DIRECT)")) {
        set_libzt_route_status("DIRECT");
      } else if (event_line.includes("(PEER_RELAY)")) {
        set_libzt_route_status("RELAY");
      } else if (event_line.includes("(PEER_UNREACHABLE)")) {
        set_libzt_route_status("UNREACHABLE");
      }
    }
  } catch (error) {
    log("轮询 libzt 事件失败", error, 0);
  } finally {
    state.libzt_event_poll_busy = false;
  }
}

// 启动 libzt 事件轮询。
function start_poll_libzt_event() {
  if (state.libzt_event_pump_timer) {
    return;
  }
  state.libzt_event_pump_timer = setInterval(() => {
    poll_libzt_events().catch((error) =>
      log("libzt event pump error", error, 0),
    );
  }, LIBZT_EVENT_POLL_INTERVAL_MS);
}

// 同步本机 ZeroTier IP。
async function sync_local_virtual_ip() {
  if (!is_tauri() || !ui.host_ip) {
    return;
  }
  try {
    const ip = await invoke("zt_get_ip");
    ui.host_ip.value = typeof ip === "string" ? ip : "";
    if (ui.host_ip.value) {
      state.libzt_network_ready = true;
    }
  } catch (error) {
    log("读取本机虚拟 IP 失败", error, 0);
  }
}

// 等待 libzt 就绪。
async function wait_for_libzt_ready(
  timeout_ms = LIBZT_READY_GRACE_MS,
  on_progress = null,
) {
  if (has_libzt_net_ready()) {
    return true;
  }
  const started_at = Date.now();
  let last_progress_sec = -1;
  let last_recovery_retry_sec = -1;
  const deadline = Date.now() + timeout_ms;
  while (Date.now() < deadline) {
    await poll_libzt_events();
    await sync_local_virtual_ip();
    if (has_libzt_net_ready()) {
      return true;
    }
    if (typeof on_progress === "function") {
      const elapsed_sec = Math.floor((Date.now() - started_at) / 1000);
      if (elapsed_sec !== last_progress_sec) {
        last_progress_sec = elapsed_sec;
        if (
          elapsed_sec >= 3 &&
          elapsed_sec % 3 === 0 &&
          elapsed_sec !== last_recovery_retry_sec
        ) {
          last_recovery_retry_sec = elapsed_sec;
          log_trace("libzt ready recovery retry", `elapsedSec=${elapsed_sec}`);
          await poll_libzt_events();
          await sync_local_virtual_ip();
          if (has_libzt_net_ready()) {
            return true;
          }
        }
        on_progress(elapsed_sec);
      }
    }
    await sleep(LIBZT_READY_POLL_MS);
  }
  return has_libzt_net_ready();
}

// 启动 libzt。
async function sure_libzt_started() {
  if (!is_tauri()) {
    return;
  }
  start_poll_libzt_event();
  if (state.zt_started) {
    /////////防呆
    await sync_local_virtual_ip();
    await poll_libzt_events();
    return;
  }
  const network_id = ui.network_input.value.trim();
  if (!network_id) {
    throw new Error("Network 为空");
  }
  const result = await invoke("zt_start", {
    networkId: network_id,
  });
  state.zt_started = true;
  state.libzt_reonline_need_restore = false;
  state.libzt_transport_invalidated = false;
  state.libzt_offline_since = 0;
  log(result);
  log_trace("libzt started", `networkId=${network_id}`);
  await sync_local_virtual_ip();
  await poll_libzt_events();
}

// 停止 libzt。
async function stop_libzt() {
  if (!is_tauri() || !state.zt_started) {
    return;
  }
  await invoke("zt_stop");
  state.zt_started = false;
  state.libzt_node_online = false;
  state.libzt_network_ready = false;
  state.libzt_reonline_need_restore = false;
  state.libzt_transport_invalidated = false;
  state.libzt_offline_since = 0;
  set_libzt_route_status("OFFLINE");
  if (ui.host_ip) {
    ui.host_ip.value = "";
  }
  stop_libzt_event_pump();
  log("libzt 已停止", 0);
}

// 构建媒体包头。

const {
  get_active_send_policy,
  sync_send_vbv,
  ensure_decoder,
  start_share_pipeline,
  stop_share_pipeline,
  stop_viewer_pipeline,
  start_cc_timer,
  stop_cc_timer,
  reset_cc_runtime,
  send_feedback_req,
  check_rx_health,
  handle_incoming_media_packet,
} = create_media_module({
  send_media_batch,
  get_selected_profile,
});
const { send_signal, send_join_signal, start_signal_pump, stop_signal_pump } =
  create_signal_module({
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
    update_merged_video_view,
  });

async function reset_transports_before_connect(connect_epoch) {
  report_connect_stage("关闭旧通道");
  await close_transports();
  return !should_stop_current_connect(connect_epoch);
}
//角色确定
async function create_channels_by_role(connect_epoch) {
  const signal_port = get_signal_port();
  const media_port = get_media_port();
  state.libzt_transport_invalidated = false;

  if (state.role === "share") {
    report_connect_stage("启动共享监听");
    await invoke("zt_signal_listen", {
      port: signal_port,
    });
    await invoke("zt_media_listen", {
      port: media_port,
    });
    state.signal_listening = true;
    state.signal_connected = false;
    state.media_transport_open = true;
    reset_media_peer_state();
    update_status("监听中", "#f6c177");
    log(`已监听：signal=${signal_port}, media(udp)=${media_port}`);
    return;
  }
  //观看方
  const peer_ip = ui.peer_ip.value.trim();
  if (!peer_ip) {
    throw new Error("观看端必须填写对方 IP");
  }
  //观看者链接重试
  await connect_viewer_with_retry({
    peer_ip,
    signal_port,
    media_port,
    connect_epoch,
  });
  if (should_stop_current_connect(connect_epoch)) {
    return;
  }
  state.signal_connected = true;
  state.signal_listening = false;
  state.media_transport_open = true;
  mark_media_peer_known();
  update_status("已连接", "#7ee787");
  log(`已连接：${peer_ip} signal=${signal_port}, media(udp)=${media_port}`);
  send_join_signal();
}

// 建立通道。
async function connect_channels({
  is_reconnect = false,
  expected_reconnect_epoch = null,
} = {}) {
  if (!is_tauri()) {
    throw new Error("客户端异常，无法使用 libzt 通道");
  }
  if (state.connecting) {
    throw new Error("通道连接中，请稍后");
  }
  if (
    is_reconnect &&
    (state.manual_disconnect || !state.auto_reconnect_enabled)
  ) {
    return;
  }
  if (
    typeof expected_reconnect_epoch === "number" &&
    expected_reconnect_epoch !== state.reconnect_epoch
  ) {
    return;
  }
  if (!is_reconnect) {
    state.reconnect_epoch += 1;
  }
  const connect_epoch = state.reconnect_epoch;
  state.connecting = true;
  set_buttons_busy(busy_controls, true);
  set_buttons_busy(always_enabled_controls, false);
  let reconnect_after_failure = false;
  state.transport_resetting = true;
  try {
    clear_reconnect_timer();
    if (!is_reconnect) {
      state.manual_disconnect = false;
      state.auto_reconnect_enabled = true;
      state.reconnect_attempts = 0;
    }
    state.role = ui.role_select.value;
    if (!(await reset_transports_before_connect(connect_epoch))) {
      return;
    }
    report_connect_stage("启动 libzt...");
    await sure_libzt_started();
    if (should_stop_current_connect(connect_epoch)) {
      return;
    }
    report_connect_stage("等待 ZeroTier 就绪");
    const libzt_ready = await wait_for_libzt_ready(
      LIBZT_READY_GRACE_MS,
      (elapsed_sec) => {
        report_connect_stage(
          `等待 ZeroTier 就绪(${elapsed_sec}s)`,
          `nodeOnline=${state.libzt_node_online}, networkReady=${state.libzt_network_ready}`,
        );
      },
    );
    if (should_stop_current_connect(connect_epoch)) {
      return;
    }
    if (!libzt_ready) {
      const ip = ui.host_ip?.value || "";
      throw new Error(
        `ZeroTier 尚未就绪，稍后重试（nodeOnline=${state.libzt_node_online}, networkReady=${state.libzt_network_ready}, ip=${ip || "none"}）`,
      );
    }
    await create_channels_by_role(connect_epoch);
    if (should_stop_current_connect(connect_epoch)) {
      return;
    }
    start_signal_pump();
    start_media_pump();
    state.libzt_transport_invalidated = false;
    state.libzt_reonline_need_restore = false;
    state.reconnect_attempts = 0;
    clear_reconnect_timer();
    log_trace("connectChannels success", `isReconnect=${is_reconnect}`);
  } catch (error) {
    await close_transports();
    if (should_stop_current_connect(connect_epoch)) {
      log_trace(
        "connectChannels aborted",
        `isReconnect=${is_reconnect}, epoch=${connect_epoch}`,
      );
      return;
    }
    const message =
      error && typeof error.message === "string"
        ? error.message
        : String(error || "");
    const is_input_validation_error =
      (state.role === "viewer" && message.includes("观看端必须填写对方 IP")) ||
      message.includes("Network 为空");
    const should_retry =
      state.auto_reconnect_enabled &&
      !state.manual_disconnect &&
      !is_input_validation_error;
    if (should_retry) {
      reconnect_after_failure = true;
      update_status("等待对端就绪，自动重试中", "#f6c177");
      log("通道尚未就绪，已切换为自动重试模式", error);
      return;
    }
    throw error;
  } finally {
    state.transport_resetting = false;
    state.connecting = false;
    set_buttons_busy(busy_controls, false);
    set_buttons_busy(always_enabled_controls, false);
    if (
      reconnect_after_failure &&
      !state.manual_disconnect &&
      connect_epoch === state.reconnect_epoch
    ) {
      schedule_signal_reconnect(
        is_reconnect ? "reconnect-attempt-failed" : "initial-connect-failed",
      );
    }
  }
}

// 开始共享或观看。
async function start_share_or_view() {
  state.start_requested = true;
  state.role = ui.role_select.value;
  reset_cc_runtime();
  log_trace("startShareOrView", `role=${state.role}`);
  //观看端
  if (state.role === "viewer") {
    if (!state.signal_connected || !state.media_transport_open) {
      log("观看端请先建立通道");
      return;
    }
    await ensure_decoder();
    state.rx_need_keyframe = true;
    state.rx_first_media_packet_at = 0;
    state.rx_start_at = Date.now();
    state.rx_play_clock_wall_ms = 0;
    state.rx_play_clock_media_ts_ms = 0;
    state.rx_last_complete_frame_at = 0;
    state.rx_last_frame_assembled_at = 0;
    state.rx_consecutive_drop_frames = 0;
    state.rx_last_drop_at = 0;
    state.rx_decode_wait_frame_id = null;
    state.rx_decode_wait_started_at = 0;
    state.rx_expected_seq = null;
    state.rx_reorder_pending.clear();
    start_cc_timer();
    await send_feedback_req();
    update_status("已连接，等待远端画面", "#7ee787");
    send_join_signal();
    return;
  }
  //共享端
  if (!state.signal_listening || !state.media_transport_open) {
    log("共享端请先建立通道");
    return;
  }
  try {
    if (!state.session_id) {
      state.session_id = crypto.randomUUID();
    }
    const selected_profile = get_selected_profile().profile;
    state.cc.vbvTargetBps = selected_profile.maxBitrateKbps * 1000;
    const { profileKey: profile_key } = sync_send_vbv();
    state.cc.lastFpsSwitchAt = 0;
    await start_share_pipeline();
    start_cc_timer();
    log(
      `共享端已开始：H.264 UDP ${profile_key}${state.cc.currentFps}（VBV ${Math.round(state.cc.vbvTargetBps / 1000)}kbps）`,
    );
    send_join_signal();
  } catch (error) {
    log("无法开始共享", error);
  }
}

// 打开日志目录。
async function open_log_folder() {
  if (!is_tauri()) {
    log("当前环境不支持打开日志目录");
    return;
  }
  await invoke("open_log_dir");
}

// 断开所有连接并复位。
async function disconnect_all() {
  log_trace("disconnectAll begin");
  state.reconnect_epoch += 1;
  state.manual_disconnect = true;
  state.auto_reconnect_enabled = false;
  state.transport_resetting = true;
  clear_reconnect_timer();
  clear_offline_timer();
  stop_cc_timer();
  if (state.role === "share" && state.start_requested) {
    send_signal({
      type: "share-ended",
      role: "share",
      target: state.peer_target_id || undefined,
      ts: Date.now(),
    });
  }
  await stop_share_pipeline();
  stop_viewer_pipeline();
  reset_cc_runtime();
  await close_transports();
  await stop_libzt();
  state.start_requested = false;
  clear_peer_session_state();
  state.reconnect_attempts = 0;
  state.transport_resetting = false;
  state.media_transport_open = false;
  state.libzt_transport_invalidated = false;
  state.libzt_offline_since = 0;
  state.libzt_reonline_need_restore = false;
  reset_media_peer_state();
  update_merged_video_view();
  update_status("未连接", "#b1b1b1");
  log_trace("disconnectAll complete");
}

// 获取Share Stats Text。
function get_share_stats_text(tx_kbps, tx_fps) {
  const active_profile_key =
    state.cc.activeProfileKey || get_active_send_policy().profileKey;
  const active_profile =
    SHARE_PROFILES[active_profile_key] || get_selected_profile().profile;
  const codec = (state.active_video_codec_key || "h264").toUpperCase();
  return `TX ${tx_kbps.toFixed(0)} kbps | VBV ${Math.round(state.cc.vbvTargetBps / 1000)} kbps | PROFILE ${active_profile_key} ${active_profile.width}x${active_profile.height} | CODEC ${codec} | FPS ${tx_fps.toFixed(1)} | RTT ${state.cc.rttMs.toFixed(0)} ms | QD ${state.cc.queueDelayMs.toFixed(0)} ms | FEC ${(state.cc.currentFecRate * 100).toFixed(0)}% | LINK ${get_route_label()} | BADLINK ${state.bad_link_mode ? "ON" : "OFF"}`;
}

// 启动统计监控。
function start_stats_monitor() {
  if (state.stats_timer) {
    clearInterval(state.stats_timer);
  }
  state.stats_timer = setInterval(() => {
    const tx_kbps =
      (state.tx_window_bytes * 8) / 1000 / (STATS_INTERVAL_MS / 1000);
    const rx_kbps =
      (state.rx_window_bytes * 8) / 1000 / (STATS_INTERVAL_MS / 1000);
    const tx_fps = state.tx_window_frames / (STATS_INTERVAL_MS / 1000);
    const rx_fps = state.rx_window_frames / (STATS_INTERVAL_MS / 1000);
    if (state.role === "share") {
      update_remote_stats(get_share_stats_text(tx_kbps, tx_fps));
    } else {
      update_remote_stats(
        `RX ${rx_kbps.toFixed(0)} kbps | FPS ${rx_fps.toFixed(1)} | Jitter ${state.rx_jitter_ms.toFixed(1)} ms | Delay ${state.rx_target_delay_ms.toFixed(0)} ms | LINK ${get_route_label()} | BADLINK ${state.bad_link_mode ? "ON" : "OFF"}`,
      );
    }
    state.tx_window_bytes = 0;
    state.tx_window_frames = 0;
    state.rx_window_bytes = 0;
    state.rx_window_frames = 0;
    evaluate_libzt_soft_offline("stats-tick").catch((error) =>
      log("离线状态评估失败", error, 0),
    );
  }, STATS_INTERVAL_MS);
}

// 每秒写入一行收发核心指标到日志文件（不写 UI）。
function start_metrics_logger() {
  if (state.metrics_log_timer) {
    clearInterval(state.metrics_log_timer);
  }
  reset_second_metrics();
  state.metrics_log_timer = setInterval(() => {
    const now = Date.now();
    const pli_per_min = count_metric_ts(state.pli_sent_ts, now, 60_000);
    const pli_rx_per_min = count_metric_ts(state.pli_rx_ts, now, 60_000);
    if (state.role === "viewer" && state.start_requested) {
      const has_viewer_traffic =
        state.rx_pkts_sec > 0 ||
        state.rx_frames_completed_sec > 0 ||
        state.rx_frames_played_sec > 0 ||
        state.rx_drop_deadline_sec > 0 ||
        state.rx_late_after_deadline_pkts_sec > 0 ||
        state.rx_expired_frames_sec > 0 ||
        state.rx_missing_on_deadline_pkts_sec > 0;
      if (!has_viewer_traffic) {
        reset_second_metrics();
        return;
      }
      const avg_pkt_cnt_per_frame =
        state.rx_frames_completed_sec > 0
          ? state.rx_completed_frame_pkt_total_sec /
            state.rx_frames_completed_sec
          : 0;
      const out_of_order_rate =
        state.rx_data_pkts_sec > 0
          ? state.rx_out_of_order_pkts_sec / state.rx_data_pkts_sec
          : 0;
      const rx_kbps = (state.rx_bytes_sec * 8) / 1000;
      log(
        `[viewer-metrics] rx_in_pkts/s=${state.rx_pkts_sec} rx_kbps=${rx_kbps.toFixed(1)} frames_completed/s=${state.rx_frames_completed_sec} frames_played/s=${state.rx_frames_played_sec} drop_deadline/s=${state.rx_drop_deadline_sec} expired_frames/s=${state.rx_expired_frames_sec} missing_on_deadline_pkts/s=${state.rx_missing_on_deadline_pkts_sec} late_after_deadline_pkts/s=${state.rx_late_after_deadline_pkts_sec} nack_enqueued/s=${state.rx_nack_enqueued_sec} nack_sent/s=${state.rx_nack_sent_sec} nack_skip_rtt/s=${state.rx_nack_skipped_rtt_sec} nack_skip_missing/s=${state.rx_nack_skipped_missing_sec} nack_skip_round_frames/s=${state.rx_nack_skipped_rounds_sec} avg_pkt_cnt_per_frame=${avg_pkt_cnt_per_frame.toFixed(2)} out_of_order_rate=${(out_of_order_rate * 100).toFixed(2)}% pli/min=${pli_per_min} target_delay_ms=${Math.round(state.rx_target_delay_ms)} bad_link=${state.bad_link_mode ? "on" : "off"}`,
        0,
      );
    } else if (state.role === "share" && state.start_requested) {
      const has_sender_traffic =
        state.tx_pkts_sec > 0 ||
        state.tx_frames_sent_sec > 0 ||
        state.nack_rx_sec > 0;
      if (!has_sender_traffic) {
        reset_second_metrics();
        return;
      }
      const avg_pkt_cnt_per_frame =
        state.tx_frames_sent_sec > 0
          ? state.tx_frame_pkt_total_sec / state.tx_frames_sent_sec
          : 0;
      const tx_kbps = (state.tx_bytes_sec * 8) / 1000;
      const { profileKey: active_profile_key, profile: active_profile } =
        get_active_send_policy();
      log(
        `[sender-metrics] capture_in/s=${state.tx_captured_frames_sec} cadence_skip/s=${state.tx_capture_skip_cadence_sec} encode_attempt/s=${state.tx_encode_attempt_sec} budget_drop/s=${state.tx_encode_budget_drop_sec} encoded/s=${state.tx_encoded_frames_sec} motion=${state.capture_motion_level} motion_score=${Number(state.capture_motion_score || 0).toFixed(2)} tx_out_pkts/s=${state.tx_pkts_sec} tx_kbps=${tx_kbps.toFixed(1)} frames_sent/s=${state.tx_frames_sent_sec} keyframes/s=${state.tx_keyframes_sec} avg_pkt_cnt_per_frame=${avg_pkt_cnt_per_frame.toFixed(2)} nack_rx/s=${state.nack_rx_sec} pli_rx/min=${pli_rx_per_min} vbv_target_kbps=${Math.round(state.cc.vbvTargetBps / 1000)} encoder_kbps=${Math.round(state.cc.vbvEncoderBitrateBps / 1000)} fps=${state.cc.currentFps} codec=${(state.active_video_codec_key || "h264").toUpperCase()} res_profile=${active_profile_key} res=${active_profile.width}x${active_profile.height} queue_delay_ms=${Math.round(state.cc.queueDelayMs)} rtt_ms=${Math.round(state.cc.rttMs)} fec_rate=${Math.round(state.cc.currentFecRate * 100)}% bad_link=${state.bad_link_mode ? "on" : "off"}`,
        0,
      );
    }
    reset_second_metrics();
  }, METRICS_LOG_INTERVAL_MS);
}

// 初始化表单与首屏状态。
function init_form() {
  ui.host_ip.value = "";
  ui.port.value = String(config.signaling.defaultPort || 34157);
  ui.network_input.value =
    config.signaling.network || config.user.defaultNetwork || "";
  ui.role_select.value = config.user.defaultRole || "share";
  ui.peer_ip.value = "";
  if (ui.quality_select) {
    ui.quality_select.value = DEFAULT_QUALITY;
    state.last_user_selected_profile_key = DEFAULT_QUALITY;
    ui.quality_select.addEventListener("change", () => {
      log_selected_profile_change("user");
    });
  }
  ui.local_video.srcObject = null;
  const canvas = ui.remote_canvas;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width || 1, canvas.height || 1);
  update_merged_video_view();
  update_remote_stats("Bitrate: - kbps | FPS: -");
  start_stats_monitor();
  start_metrics_logger();
}
ui.connect_btn.addEventListener("click", () => {
  connect_channels().catch((error) => log("建立通道失败", error));
});
ui.start_btn.addEventListener("click", () => {
  start_share_or_view().catch((error) => log("开始共享/观看失败", error));
});
ui.open_log_btn.addEventListener("click", () => {
  open_log_folder().catch((error) => log("打开日志目录失败", error));
});
ui.stop_btn.addEventListener("click", () => {
  disconnect_all().catch((error) => log("断开失败", error));
});
init_form();
update_status("未连接", "#b1b1b1");
log("应用已就绪（纯 ZeroTier UDP H.264 模式）");
log_selected_profile_change("init");
