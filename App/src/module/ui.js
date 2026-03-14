// 处理 qs 相关逻辑。
function qs(selector) {
  return document.querySelector(selector);
}

const ui = {
  host_ip: qs("#host_ip"),
  port: qs("#port"),
  network_input: qs("#network_input"),
  role_select: qs("#role_select"),
  peer_ip: qs("#peer_ip"),
  quality_select: qs("#quality_select"),
  connect_btn: qs("#connect_btn"),
  start_btn: qs("#start_btn"),
  open_log_btn: qs("#open_log_btn"),
  stop_btn: qs("#stop_btn"),
  status_point: qs("#status_point"),
  status_Text: qs("#status_Text"),
  local_video: qs("#local_video"),
  remote_canvas: qs("#remote_canvas"),
  remote_stats: qs("#remote_stats"),
  video_source_tag: qs("#video_source_tag"),
  log_list: qs("#log_list"),
};

// 判断当前是否运行在 Tauri 环境。

export { ui };
