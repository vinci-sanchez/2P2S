import { invoke } from "@tauri-apps/api/tauri";
import { MAX_UI_LOG_ITEMS } from "./constants.js";
import { state } from "./state.js";
import { ui } from "./ui.js";

// 判断Tauri。
function is_tauri() {
  return Boolean(window.__TAURI__) && typeof invoke === "function";
}

// 从堆栈信息中提取行号，便于定位异常。
function extract_line_from_stack(stack, skip_first = false) {
  const matches = Array.from(stack.matchAll(/(\.js|\.ts|\.vue)(\?.*?)?:(\d+):(\d+)/g));
  if (!matches.length) {
    return null;
  }
  const index = skip_first && matches.length > 1 ? 1 : 0;
  return matches[index][3];
}

// 格式化错误行号信息。
function format_error_line(error, fallback_stack) {
  if (error && typeof error.lineNumber === "number") {
    return ` (line ${error.lineNumber})`;
  }
  const stack = error && typeof error.stack === "string" ? error.stack : "";
  const line_from_error = stack ? extract_line_from_stack(stack) : null;
  if (line_from_error) {
    return ` (line ${line_from_error})`;
  }
  if (typeof fallback_stack === "string") {
    const line_from_fallback = extract_line_from_stack(fallback_stack, true);
    if (line_from_fallback) {
      return ` (line ${line_from_fallback})`;
    }
  }
  return "";
}

// 格式化错误正文，防止对象错误直接丢失信息。
function format_error_info(error) {
  if (!error) {
    return "";
  }
  if (error instanceof Error && error.message) {
    return ` | ${error.message}`;
  }
  if (typeof error === "object" && typeof error.message === "string") {
    return ` | ${error.message}`;
  }
  if (typeof error === "string") {
    return ` | ${error}`;
  }
  try {
    return ` | ${JSON.stringify(error)}`;
  } catch {
    return " | [unknown error]";
  }
}

// 追加日志到本地文件（Tauri 命令）。
async function write_log_to_file(entry) {
  if (!is_tauri()) {
    return;
  }
  try {
    await invoke("append_log", {
      message: entry
    });
  } catch {
    // 忽略日志落盘失败
  }
}

// 统一日志入口：写 UI、写文件、补充错误位置信息。
function log(message, arg2 = 1, arg3 = undefined) {
  let channel = 1;
  let error;
  if (typeof arg2 === "number") {
    channel = arg2;
    error = arg3;
  } else {
    error = arg2;
    if (typeof arg3 === "number") {
      channel = arg3;
    }
  }
  const fallback_stack = new Error().stack;
  const entry = `${new Date().toLocaleTimeString()} - ${message}${format_error_line(error, fallback_stack)}${format_error_info(error)}`;
  if (channel === 1 && ui.log_list) {
    const item = document.createElement("div");
    item.className = "log-item";
    item.textContent = entry;
    ui.log_list.prepend(item);
    while (ui.log_list.childElementCount > MAX_UI_LOG_ITEMS) {
      ui.log_list.lastElementChild?.remove();
    }
  }
  write_log_to_file(entry);
}

// 汇总关键状态，便于 trace 日志一次看全。
function summarize_state() {
  return `role=${state.role} ztOnline=${state.libzt_node_online} netReady=${state.libzt_network_ready} signal=${state.signal_connected}/${state.signal_listening} media=${state.media_transport_open} startRequested=${state.start_requested} peerReady=${state.peer_ready} target=${state.peer_target_id || "-"} reconnectAttempts=${state.reconnect_attempts}`;
}

// 记录带上下文的 trace 日志。
function log_trace(title, detail = "", channel = 0) {
  const body = detail ? `${title} | ${detail}` : title;
  log(`[trace] ${body} | ${summarize_state()}`, channel);
}
let last_status_log_text = "";

// ??????????????????
function update_status(text, color) {
  ui.status_Text.textContent = text;
  ui.status_point.style.background = color;
  if (text !== last_status_log_text) {
    last_status_log_text = text;
    log(`状态更新：${text}`);
  }
}

// 更新Remote Stats。
function update_remote_stats(text) {
  if (ui.remote_stats) {
    ui.remote_stats.textContent = text;
  }
}

// 根据是否有本地/远端视频切换主画面。
function update_merged_video_view() {
  const has_remote = state.rx_last_complete_frame_at > 0;
  const show_local = !has_remote && Boolean(ui.local_video.srcObject);
  ui.remote_canvas.classList.toggle("video-hidden", !has_remote);
  ui.local_video.classList.toggle("video-hidden", !show_local);
  if (ui.video_source_tag) {
    if (has_remote) {
      ui.video_source_tag.textContent = "远端画面";
    } else if (show_local) {
      ui.video_source_tag.textContent = "本地预览";
    } else {
      ui.video_source_tag.textContent = "无信号";
    }
  }
}

// 连接中时禁用关键按钮，避免并发触发。

export { is_tauri, log, log_trace, update_status, update_remote_stats, update_merged_video_view };
