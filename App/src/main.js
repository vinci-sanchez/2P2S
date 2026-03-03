import { invoke } from "@tauri-apps/api/tauri";
import config from "../config.js";

const SHARE_PROFILES = {
  "360p": { width: 640, height: 360, maxBitrateKbps: 900, minBpf: 7000 },
  "480p": { width: 854, height: 480, maxBitrateKbps: 1400, minBpf: 10000 },
  "720p": { width: 1280, height: 720, maxBitrateKbps: 2600, minBpf: 18000 },
  "1080p": { width: 1920, height: 1080, maxBitrateKbps: 5200, minBpf: 30000 },
};

const DEFAULT_QUALITY = "720p";
const FPS_LEVELS = [12, 15, 20, 24, 30, 40, 50, 60, 80];

const SIGNAL_POLL_INTERVAL_MS = 120;
const MEDIA_POLL_INTERVAL_MS = 6;
const LIBZT_EVENT_POLL_INTERVAL_MS = 500;
const STATS_INTERVAL_MS = 500;
const METRICS_LOG_INTERVAL_MS = 1000;
const CC_INTERVAL_MS = 220;
const PLI_TIMEOUT_MS = 500;
const KEYFRAME_INTERVAL_MS = 1000;
const FPS_COOLDOWN_MS = 800;
const OFFLINE_DEBOUNCE_MS = 3000;
const LIBZT_READY_GRACE_MS = 15000;
const LIBZT_READY_POLL_MS = 150;
const SIGNAL_RECONNECT_DELAYS_MS = [1000, 2000, 5000, 8000, 12000];
const MAX_AUTO_RECONNECT_ATTEMPTS = SIGNAL_RECONNECT_DELAYS_MS.length;
const VIEWER_CONNECT_MAX_ATTEMPTS = 6;
const VIEWER_CONNECT_RETRY_DELAY_MS = 350;
const MAX_UI_LOG_ITEMS = 300;

const PACKET_MAX_BYTES = 1200;
const PACKET_HEADER_BYTES = 32;
const PACKET_PAYLOAD_BYTES = PACKET_MAX_BYTES - PACKET_HEADER_BYTES;
const PACING_MIN_MS = 5;
const PACING_MAX_MS = 15;
const JITTER_MIN_MS = 20;
const JITTER_MAX_MS = 80;
const RX_DEADLINE_SAFETY_MS = 12;
const RX_DEADLINE_BONUS_PER_PKT_MS = 1;
const RX_DEADLINE_MAX_BONUS_MS = 24;
const RX_NEED_KEYFRAME_DROP_THRESHOLD = 3;
const RX_NEED_KEYFRAME_DROP_WINDOW_MS = 900;
const RX_SEQ_REORDER_GAP_THRESHOLD = 8;
const RX_SEQ_REORDER_HOLD_MS = 20;
const RX_SEQ_REORDER_MAX_PENDING = 512;
const DELTA_NACK_MAX_PER_FRAME = 1;
const DELTA_NACK_MAX_MISSING = 2;
const DELTA_NACK_REMAIN_GUARD_MS = 12;
const FEC_MIN_RATE = 0.1;
const FEC_MAX_RATE = 0.2;
const KEYFRAME_CACHE_KEEP_MS = 3000;
const DELTA_CACHE_KEEP_MS = 1200;
const RETRANS_CACHE_MAX_ITEMS = 1800;
const MIN_RTT_WINDOW_MS = 15_000;

const PKT_KIND_DATA = 0;
const PKT_KIND_FEEDBACK_REQ = 1;
const PKT_KIND_FEEDBACK = 2;
const PKT_KIND_NACK = 3;
const PKT_KIND_PLI = 4;

const FLAG_KEYFRAME = 1 << 0;
const FLAG_FEC = 1 << 1;
const FLAG_RETRANS = 1 << 2;

const LIBZT_NOISY_EVENT_MARKERS = [
  "(PEER_DIRECT)",
  "(PEER_RELAY)",
  "(PEER_UNREACHABLE)",
  "code=219",
  "code=243",
  "code=244",
];

const state = {
  role: "share",
  client_id: crypto.randomUUID(),
  session_id: "",

  ztStarted: false,
  libztNodeOnline: false,
  libztNetworkReady: false,
  libztNeedRestore: false,
  libztOfflineTimer: null,

  connecting: false,
  manualDisconnect: false,
  autoReconnectEnabled: false,
  reconnectTimer: null,
  reconnectAttempts: 0,
  reconnectEpoch: 0,
  transportResetting: false,

  signalConnected: false,
  signalListening: false,
  signalPumpTimer: null,
  signalPollBusy: false,

  mediaConnected: false,
  mediaPeerKnown: false,
  mediaPeerUnknownNotified: false,
  mediaPumpTimer: null,
  mediaPollBusy: false,

  libztEventPumpTimer: null,
  libztEventPollBusy: false,

  startRequested: false,
  peerReady: false,
  peerTargetId: "",

  localStream: null,
  captureTimer: null,
  encoder: null,
  decoder: null,
  encoderConfigured: false,
  decoderConfigured: false,
  forceNextKeyframe: false,
  lastKeyframeAt: 0,
  lastCaptureAt: 0,
  captureBusy: false,

  seq: 1,
  frameId: 1,
  retransCache: new Map(),

  rxFrameBuffer: new Map(),
  rxNeedKeyframe: true,
  rxLastCompleteFrameAt: 0,
  rxLastCompleteFrameId: 0,
  rxPliLastSentAt: 0,
  rxStartAt: 0,
  rxExpectedSeq: null,
  rxDeltaRecvPackets: 0,
  rxDeltaLostPackets: 0,
  rxJitterMs: 10,
  rxPrevTransitMs: null,
  rxTargetDelayMs: 30,
  rxConsecutiveDropFrames: 0,
  rxLastDropAt: 0,
  rxReorderPending: new Map(),

  ccTimer: null,
  lastCcReqTs: 0,
  cc: {
    targetBitrateBps: 2_000_000,
    ewmaBitrateBps: 2_000_000,
    currentFps: 30,
    currentFecRate: FEC_MIN_RATE,
    minRttMs: Infinity,
    rttMs: 0,
    queueDelayMs: 0,
    lossPermille: 0,
    lastFpsSwitchAt: 0,
    rttSamples: [],
  },

  statsTimer: null,
  metricsLogTimer: null,
  txWindowBytes: 0,
  txWindowFrames: 0,
  rxWindowBytes: 0,
  rxWindowFrames: 0,

  rxPktsSec: 0,
  rxBytesSec: 0,
  rxFramesCompletedSec: 0,
  rxFramesPlayedSec: 0,
  rxDropDeadlineSec: 0,
  rxCompletedFramePktTotalSec: 0,
  rxDataPktsSec: 0,
  rxOutOfOrderPktsSec: 0,
  pliSentTs: [],

  txPktsSec: 0,
  txBytesSec: 0,
  txFramesSentSec: 0,
  txKeyframesSec: 0,
  txFramePktTotalSec: 0,
  nackRxSec: 0,
  pliRxTs: [],
};

// 选择器简写，便于集中获取 DOM。
const qs = (selector) => document.querySelector(selector);
const ui = {
  host_ip: qs("#host_ip"),
  port: qs("#port"),
  network_input: qs("#network_input"),
  role_select: qs("#role_select"),
  peer_ip: qs("#peer_ip"),
  quality_select: qs("#quality_select"),
  connect_btn: qs("#connect_btn"),
  start_btn: qs("#start_btn"),
  quickViewBtn: qs("#quickViewBtn"),
  mute_remote_btn: qs("#mute_remote_btn"),
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
const isTauri = () => Boolean(window.__TAURI__) && typeof invoke === "function";

// 从堆栈信息中提取行号，便于定位异常。
const extractLineFromStack = (stack, skipFirst = false) => {
  const matches = Array.from(
    stack.matchAll(/(\.js|\.ts|\.vue)(\?.*?)?:(\d+):(\d+)/g),
  );
  if (!matches.length) {
    return null;
  }
  const index = skipFirst && matches.length > 1 ? 1 : 0;
  return matches[index][3];
};

// 格式化错误行号信息。
const formatErrorLine = (error, fallbackStack) => {
  if (error && typeof error.lineNumber === "number") {
    return ` (line ${error.lineNumber})`;
  }

  const stack = error && typeof error.stack === "string" ? error.stack : "";
  const lineFromError = stack ? extractLineFromStack(stack) : null;
  if (lineFromError) {
    return ` (line ${lineFromError})`;
  }

  if (typeof fallbackStack === "string") {
    const lineFromFallback = extractLineFromStack(fallbackStack, true);
    if (lineFromFallback) {
      return ` (line ${lineFromFallback})`;
    }
  }

  return "";
};

// 格式化错误正文，防止对象错误直接丢失信息。
const formatErrorInfo = (error) => {
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
};

// 追加日志到本地文件（Tauri 命令）。
const writeLogToFile = async (entry) => {
  if (!isTauri()) {
    return;
  }
  try {
    await invoke("append_log", { message: entry });
  } catch {
    // 忽略日志落盘失败
  }
};

// 统一日志入口：写 UI、写文件、补充错误位置信息。
const log = (message, arg2 = 1, arg3 = undefined) => {
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

  const fallbackStack = new Error().stack;
  const entry = `${new Date().toLocaleTimeString()} - ${message}${formatErrorLine(error, fallbackStack)}${formatErrorInfo(error)}`;

  if (channel === 1 && ui.log_list) {
    const item = document.createElement("div");
    item.className = "log-item";
    item.textContent = entry;
    ui.log_list.prepend(item);
    while (ui.log_list.childElementCount > MAX_UI_LOG_ITEMS) {
      ui.log_list.lastElementChild?.remove();
    }
  }

  writeLogToFile(entry);
};

// 汇总关键状态，便于 trace 日志一次看全。
const summarizeState = () =>
  `role=${state.role} ztOnline=${state.libztNodeOnline} netReady=${state.libztNetworkReady} signal=${state.signalConnected}/${state.signalListening} media=${state.mediaConnected} startRequested=${state.startRequested} peerReady=${state.peerReady} target=${state.peerTargetId || "-"} reconnectAttempts=${state.reconnectAttempts}`;

// 记录带上下文的 trace 日志。
const logTrace = (title, detail = "", channel = 0) => {
  const body = detail ? `${title} | ${detail}` : title;
  log(`[trace] ${body} | ${summarizeState()}`, channel);
};

// 更新顶部连接状态展示。
const updateStatus = (text, color) => {
  ui.status_Text.textContent = text;
  ui.status_point.style.background = color;
  log(`状态更新：${text}`);
};

// 更新底部实时统计文本。
const updateRemoteStats = (text) => {
  if (ui.remote_stats) {
    ui.remote_stats.textContent = text;
  }
};

// 根据是否有本地/远端视频切换主画面。
const updateMergedVideoView = () => {
  const hasRemote = state.rxLastCompleteFrameAt > 0;
  const showLocal = !hasRemote && Boolean(ui.local_video.srcObject);

  ui.remote_canvas.classList.toggle("video-hidden", !hasRemote);
  ui.local_video.classList.toggle("video-hidden", !showLocal);

  if (ui.video_source_tag) {
    if (hasRemote) {
      ui.video_source_tag.textContent = "远端画面";
    } else if (showLocal) {
      ui.video_source_tag.textContent = "本地预览";
    } else {
      ui.video_source_tag.textContent = "无信号";
    }
  }
};

// 连接中时禁用关键按钮，避免并发触发。
const setButtonsBusy = (busy) => {
  if (ui.connect_btn) {
    ui.connect_btn.disabled = busy;
  }
};

// 获取信令端口并做容错。
const getSignalPort = () => {
  const input = Number(ui.port.value);
  if (Number.isFinite(input) && input > 0 && input <= 65535) {
    return input;
  }
  return Number(config.signaling.defaultPort) || 34157;
};

// 获取媒体端口（信令端口+1）。
const getMediaPort = () => {
  const base = getSignalPort();
  return base >= 65535 ? 65535 : base + 1;
};

// 获取当前选择的清晰度档位。
const getSelectedProfile = () => {
  const profileKey = ui.quality_select?.value || DEFAULT_QUALITY;
  const profile = SHARE_PROFILES[profileKey] || SHARE_PROFILES[DEFAULT_QUALITY];
  return { profileKey, profile };
};

// 刷新音频按钮状态（当前仅视频）。
const refreshMuteButton = () => {
  ui.mute_remote_btn.disabled = true;
  ui.mute_remote_btn.textContent = "无音频（保留）";
};

// Promise 版 sleep。
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 判断连接流程是否已被新一轮连接或手动断开打断。
const isConnectFlowCancelled = (connectEpoch) =>
  state.manualDisconnect || connectEpoch !== state.reconnectEpoch;

// 连接阶段可视化回调（状态栏 + trace）。
const reportConnectStage = (stage, detail = "") => {
  updateStatus(stage, "#f6c177");
  if (detail) {
    logTrace("connect stage", `${stage} | ${detail}`);
  } else {
    logTrace("connect stage", stage);
  }
};

// 观看端：短超时 + 多次快速重试连接。
const connectViewerWithRetry = async ({
  peerIp,
  signalPort,
  mediaPort,
  connectEpoch,
}) => {
  let lastError = null;

  for (let i = 0; i < VIEWER_CONNECT_MAX_ATTEMPTS; i += 1) {
    if (isConnectFlowCancelled(connectEpoch)) {
      return;
    }

    const attempt = i + 1;
    reportConnectStage(
      `连接对端(${attempt}/${VIEWER_CONNECT_MAX_ATTEMPTS})`,
      `peer=${peerIp}, signal=${signalPort}, media=${mediaPort}`,
    );

    try {
      await invoke("zt_signal_connect", { peerIp, port: signalPort });
      await invoke("zt_media_connect", { peerIp, port: mediaPort });
      return;
    } catch (error) {
      lastError = error;
      await closeTransports();
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

  throw lastError || new Error("观看端连接失败：重试已耗尽");
};

// 安全裁剪数值范围。
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// 计算 EWMA 平滑值。
const ewma = (prev, next, alpha) => prev + alpha * (next - prev);

// 将事件时间戳写入窗口数组，并裁剪到最近窗口内。
const pushMetricTs = (arr, now, windowMs) => {
  arr.push(now);
  const deadline = now - windowMs;
  while (arr.length > 0 && arr[0] < deadline) {
    arr.shift();
  }
};

// 统计窗口内事件数。
const countMetricTs = (arr, now, windowMs) => {
  const deadline = now - windowMs;
  while (arr.length > 0 && arr[0] < deadline) {
    arr.shift();
  }
  return arr.length;
};

// 清空每秒统计计数器。
const resetSecondMetrics = () => {
  state.rxPktsSec = 0;
  state.rxBytesSec = 0;
  state.rxFramesCompletedSec = 0;
  state.rxFramesPlayedSec = 0;
  state.rxDropDeadlineSec = 0;
  state.rxCompletedFramePktTotalSec = 0;
  state.rxDataPktsSec = 0;
  state.rxOutOfOrderPktsSec = 0;

  state.txPktsSec = 0;
  state.txBytesSec = 0;
  state.txFramesSentSec = 0;
  state.txKeyframesSec = 0;
  state.txFramePktTotalSec = 0;
  state.nackRxSec = 0;
};
// 判断 libzt 是否满足发起网络连接条件。
const hasLibztReady = () => {
  const hasIp = Boolean(ui.host_ip && ui.host_ip.value && ui.host_ip.value !== "0.0.0.0");
  if (hasIp) {
    return true;
  }
  return state.libztNodeOnline && state.libztNetworkReady;
};

// 清除重连定时器。
const clearReconnectTimer = () => {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
};

// 清除离线防抖定时器。
const clearOfflineTimer = () => {
  if (state.libztOfflineTimer) {
    clearTimeout(state.libztOfflineTimer);
    state.libztOfflineTimer = null;
  }
};

// 停止信令轮询。
const stopSignalPump = () => {
  if (state.signalPumpTimer) {
    clearInterval(state.signalPumpTimer);
    state.signalPumpTimer = null;
  }
  state.signalPollBusy = false;
};

// 停止媒体轮询。
const stopMediaPump = () => {
  if (state.mediaPumpTimer) {
    clearInterval(state.mediaPumpTimer);
    state.mediaPumpTimer = null;
  }
  state.mediaPollBusy = false;
};

// 停止 libzt 事件轮询。
const stopLibztEventPump = () => {
  if (state.libztEventPumpTimer) {
    clearInterval(state.libztEventPumpTimer);
    state.libztEventPumpTimer = null;
  }
  state.libztEventPollBusy = false;
};

// 关闭信令通道。
const closeSignalTransport = async () => {
  stopSignalPump();
  state.signalConnected = false;
  state.signalListening = false;
  if (!isTauri()) {
    return;
  }
  try {
    await invoke("zt_signal_close");
  } catch (error) {
    log("关闭信令通道失败", error, 0);
  }
};

// 关闭媒体通道。
const closeMediaTransport = async () => {
  stopMediaPump();
  state.mediaConnected = false;
  state.mediaPeerKnown = false;
  state.mediaPeerUnknownNotified = false;
  if (!isTauri()) {
    return;
  }
  try {
    await invoke("zt_media_close");
  } catch (error) {
    log("关闭媒体通道失败", error, 0);
  }
};

// 关闭传输通道。
const closeTransports = async () => {
  await closeSignalTransport();
  await closeMediaTransport();
};

// 判断是否允许触发自动重连。
const shouldScheduleReconnect = () => {
  if (state.role === "viewer") {
    return true;
  }
  return !state.signalListening;
};

// 调度重连。
const scheduleSignalReconnect = (reason) => {
  if (state.manualDisconnect || !state.autoReconnectEnabled) {
    return;
  }
  if (!shouldScheduleReconnect()) {
    logTrace("skip reconnect", `reason=${reason}, role=${state.role}`);
    return;
  }
  if (state.reconnectTimer || state.connecting) {
    return;
  }
  if (state.reconnectAttempts >= MAX_AUTO_RECONNECT_ATTEMPTS) {
    state.autoReconnectEnabled = false;
    clearReconnectTimer();
    setButtonsBusy(false);
    updateStatus("重连已停止，请手动重试", "#ffb4a2");
    log(
      `自动重连已达上限(${MAX_AUTO_RECONNECT_ATTEMPTS}次)，停止重连，reason=${reason}, role=${state.role}`,
    );
    return;
  }

  const idx = Math.min(
    state.reconnectAttempts,
    SIGNAL_RECONNECT_DELAYS_MS.length - 1,
  );
  const delay = SIGNAL_RECONNECT_DELAYS_MS[idx];
  state.reconnectAttempts += 1;

  updateStatus(`重连中(${state.reconnectAttempts})`, "#f6c177");
  log(`通道重连调度：${delay}ms 后重连，reason=${reason}, role=${state.role}`);
  logTrace("schedule reconnect", `reason=${reason}, delayMs=${delay}`);
  const epoch = state.reconnectEpoch;

  state.reconnectTimer = setTimeout(async () => {
    state.reconnectTimer = null;
    if (epoch !== state.reconnectEpoch) {
      return;
    }
    if (state.manualDisconnect || !state.autoReconnectEnabled) {
      return;
    }
    try {
      await connectChannels({ isReconnect: true, expectedReconnectEpoch: epoch });
      if (state.role === "viewer" && state.startRequested) {
        startCcTimer();
      }
    } catch (error) {
      log("通道重连失败", error);
      scheduleSignalReconnect("retry-failed");
    }
  }, delay);
};

// 发送信令消息。
const sendSignal = (payload) => {
  if (!state.signalConnected) {
    return false;
  }

  const wire = JSON.stringify({
    ...payload,
    client_id: state.client_id,
    session_id: state.session_id || undefined,
  });

  invoke("zt_signal_send", { payload: wire }).catch((error) => {
    state.signalConnected = false;
    log("信令发送失败", error);
    if (state.role === "viewer") {
      scheduleSignalReconnect("signal-send-failed");
    }
  });

  return true;
};

// 从信令系统文本中提取对端 ZeroTier IP（例如 "viewer connected from 10.0.0.2:54321"）。
const extractPeerIpFromSignalMessage = (message) => {
  if (typeof message !== "string" || !message.trim()) {
    return "";
  }
  const fromMatched = message.match(/\bfrom\s+([0-9a-fA-F:.]+):\d+\b/i);
  if (fromMatched?.[1]) {
    return fromMatched[1];
  }
  const fallbackMatched = message.match(/\b([0-9a-fA-F:.]+):\d+\b/);
  return fallbackMatched?.[1] || "";
};

// 共享端在收到 viewer 的信令连接事件后，更新媒体 UDP 对端地址。
const syncMediaPeerFromSignal = async (message) => {
  if (!isTauri() || state.role !== "share" || !state.mediaConnected) {
    return;
  }
  const peerIp = extractPeerIpFromSignalMessage(message);
  if (!peerIp) {
    return;
  }
  const mediaPort = getMediaPort();
  await invoke("zt_media_set_peer", { peerIp, port: mediaPort });
  state.mediaPeerKnown = true;
  state.mediaPeerUnknownNotified = false;
  state.forceNextKeyframe = true;
  log(`媒体对端已更新：${peerIp}:${mediaPort}`, 0);
};

// 发送媒体包批次（每帧铺开发送）。
const sendMediaBatch = async (packets, spreadMs) => {
  if (!state.mediaConnected || !packets.length) {
    return false;
  }
  if (state.role === "share" && !state.mediaPeerKnown) {
    return false;
  }

  const payloads = packets.map((bytes) => Array.from(bytes));
  try {
    await invoke("zt_media_send_batch", {
      packets: payloads,
      spreadMs: Math.max(0, Math.floor(spreadMs)),
    });
    return true;
  } catch (error) {
    const message = error?.message || String(error || "");
    if (message.includes("media peer is unknown")) {
      state.mediaPeerKnown = false;
      if (!state.mediaPeerUnknownNotified) {
        log("媒体对端尚未就绪，暂不发送媒体包", 0);
        state.mediaPeerUnknownNotified = true;
      }
      return false;
    }
    throw error;
  }
};

// 轮询信令消息。
const pollSignalMessages = async () => {
  if (state.signalPollBusy || !isTauri()) {
    return;
  }
  state.signalPollBusy = true;

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

      if (msg && msg.__sys) {
        await handleSignalSystem(msg);
      } else {
        await handleSignalMessage(msg);
      }
    }
  } catch (error) {
    log("轮询信令失败", error, 0);
  } finally {
    state.signalPollBusy = false;
  }
};

// 轮询媒体数据包。
const pollMediaPackets = async () => {
  if (state.mediaPollBusy || !isTauri() || !state.mediaConnected) {
    return;
  }
  state.mediaPollBusy = true;

  try {
    const packets = await invoke("zt_media_poll");
    if (!Array.isArray(packets) || packets.length === 0) {
      checkRxHealth();
      return;
    }

    for (const packet of packets) {
      if (!Array.isArray(packet) || packet.length === 0) {
        continue;
      }
      handleIncomingMediaPacket(new Uint8Array(packet));
    }

    checkRxHealth();
  } catch (error) {
    log("轮询媒体失败", error, 0);
  } finally {
    state.mediaPollBusy = false;
  }
};

// 启动信令轮询。
const startSignalPump = () => {
  if (state.signalPumpTimer) {
    return;
  }
  state.signalPumpTimer = setInterval(() => {
    pollSignalMessages().catch((error) => log("signal pump error", error, 0));
  }, SIGNAL_POLL_INTERVAL_MS);
};

// 启动媒体轮询。
const startMediaPump = () => {
  if (state.mediaPumpTimer) {
    return;
  }
  state.mediaPumpTimer = setInterval(() => {
    pollMediaPackets().catch((error) => log("media pump error", error, 0));
  }, MEDIA_POLL_INTERVAL_MS);
};

// 处理 libzt 离线防抖。
const handleLibztOffline = async () => {
  clearOfflineTimer();
  state.libztOfflineTimer = setTimeout(async () => {
    if (state.libztNodeOnline) {
      return;
    }

    const hadSession = state.signalConnected || state.signalListening || state.mediaConnected;
    state.libztNeedRestore = hadSession;
    logTrace("libzt offline debounced", `hadSession=${hadSession}`);

    if (hadSession && state.autoReconnectEnabled && !state.manualDisconnect) {
      updateStatus("ZeroTier 离线，等待恢复", "#ffb4a2");
    }
  }, OFFLINE_DEBOUNCE_MS);
};

// 处理 libzt 在线恢复。
const handleLibztOnline = () => {
  const needRestore = state.libztNeedRestore;
  state.libztNodeOnline = true;
  const hasActiveSession = state.signalConnected || state.signalListening || state.mediaConnected;
  if (needRestore && !hasActiveSession && !state.manualDisconnect && state.autoReconnectEnabled) {
    state.libztNeedRestore = false;
    scheduleSignalReconnect("libzt-online-restore");
  }
};

// 轮询 libzt 事件。
const pollLibztEvents = async () => {
  if (state.libztEventPollBusy || !isTauri()) {
    return;
  }
  state.libztEventPollBusy = true;

  try {
    const events = await invoke("zt_events_poll");
    if (!Array.isArray(events) || events.length === 0) {
      return;
    }

    for (const eventLine of events) {
      if (typeof eventLine !== "string" || !eventLine.trim()) {
        continue;
      }

      const isNoisyLibztEvent = LIBZT_NOISY_EVENT_MARKERS.some((marker) =>
        eventLine.includes(marker),
      );
      if (!isNoisyLibztEvent) {
        log(`[libzt] ${eventLine}`, 0);
      }

      if (eventLine.includes("(NODE_ONLINE)")) {
        state.libztNodeOnline = true;
        clearOfflineTimer();
        handleLibztOnline();
      } else if (eventLine.includes("(NODE_OFFLINE)")) {
        state.libztNodeOnline = false;
        state.libztNetworkReady = false;
        handleLibztOffline().catch((error) => log("处理离线事件失败", error, 0));
      } else if (
        eventLine.includes("(NETWORK_READY_IP4)") ||
        eventLine.includes("(NETWORK_OK)")
      ) {
        state.libztNetworkReady = true;
      } else if (eventLine.includes("(NETWORK_DOWN)")) {
        state.libztNetworkReady = false;
      }
    }
  } catch (error) {
    log("轮询 libzt 事件失败", error, 0);
  } finally {
    state.libztEventPollBusy = false;
  }
};
// 启动 libzt 事件轮询。
const startLibztEventPump = () => {
  if (state.libztEventPumpTimer) {
    return;
  }
  state.libztEventPumpTimer = setInterval(() => {
    pollLibztEvents().catch((error) => log("libzt event pump error", error, 0));
  }, LIBZT_EVENT_POLL_INTERVAL_MS);
};

// 同步本机 ZeroTier IP。
const syncLocalVirtualIp = async () => {
  if (!isTauri() || !ui.host_ip) {
    return;
  }

  try {
    const ip = await invoke("zt_get_ip");
    ui.host_ip.value = typeof ip === "string" ? ip : "";
    if (ui.host_ip.value) {
      state.libztNetworkReady = true;
    }
  } catch (error) {
    log("读取本机虚拟 IP 失败", error, 0);
  }
};

// 等待 libzt 就绪。
const waitForLibztReady = async (timeoutMs = LIBZT_READY_GRACE_MS, onProgress = null) => {
  if (hasLibztReady()) {
    return true;
  }

  const startedAt = Date.now();
  let lastProgressSec = -1;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await pollLibztEvents();
    await syncLocalVirtualIp();
    if (hasLibztReady()) {
      return true;
    }
    if (typeof onProgress === "function") {
      const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
      if (elapsedSec !== lastProgressSec) {
        lastProgressSec = elapsedSec;
        onProgress(elapsedSec);
      }
    }
    await sleep(LIBZT_READY_POLL_MS);
  }

  return hasLibztReady();
};

// 启动 libzt。
const ensureLibztStarted = async () => {
  if (!isTauri()) {
    return;
  }

  startLibztEventPump();

  if (state.ztStarted) {
    await syncLocalVirtualIp();
    await pollLibztEvents();
    return;
  }

  const networkId = ui.network_input.value.trim();
  if (!networkId) {
    throw new Error("Network 为空");
  }

  const result = await invoke("zt_start", { networkId });
  state.ztStarted = true;
  state.libztNeedRestore = false;
  log(result);
  logTrace("libzt started", `networkId=${networkId}`);

  await syncLocalVirtualIp();
  await pollLibztEvents();
};

// 停止 libzt。
const stopLibzt = async () => {
  if (!isTauri() || !state.ztStarted) {
    return;
  }

  await invoke("zt_stop");
  state.ztStarted = false;
  state.libztNodeOnline = false;
  state.libztNetworkReady = false;
  state.libztNeedRestore = false;
  if (ui.host_ip) {
    ui.host_ip.value = "";
  }
  stopLibztEventPump();
  log("libzt 已停止", 0);
};

// 构建媒体包头。
const buildPacket = ({
  kind,
  flags = 0,
  seq,
  frameId = 0,
  packetId = 0,
  packetCount = 0,
  timestampMs,
  payload,
  aux = 0,
  aux2 = 0,
}) => {
  const payloadBytes = payload || new Uint8Array(0);
  const buffer = new Uint8Array(PACKET_HEADER_BYTES + payloadBytes.length);
  const view = new DataView(buffer.buffer);

  view.setUint8(0, kind);
  view.setUint8(1, flags);
  view.setUint16(2, PACKET_HEADER_BYTES, true);
  view.setUint32(4, seq >>> 0, true);
  view.setUint32(8, frameId >>> 0, true);
  view.setUint16(12, packetId >>> 0, true);
  view.setUint16(14, packetCount >>> 0, true);
  view.setUint32(16, timestampMs >>> 0, true);
  view.setUint16(20, payloadBytes.length >>> 0, true);
  view.setUint16(22, 0, true);
  view.setUint32(24, aux >>> 0, true);
  view.setUint32(28, aux2 >>> 0, true);

  if (payloadBytes.length > 0) {
    buffer.set(payloadBytes, PACKET_HEADER_BYTES);
  }

  return buffer;
};

// 解析媒体包头。
const parsePacket = (bytes) => {
  if (!(bytes instanceof Uint8Array) || bytes.length < PACKET_HEADER_BYTES) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = view.getUint16(2, true);
  if (headerLen < PACKET_HEADER_BYTES || headerLen > bytes.length) {
    return null;
  }

  const payloadLen = view.getUint16(20, true);
  const payloadStart = headerLen;
  const payloadEnd = Math.min(bytes.length, payloadStart + payloadLen);

  return {
    kind: view.getUint8(0),
    flags: view.getUint8(1),
    seq: view.getUint32(4, true),
    frameId: view.getUint32(8, true),
    packetId: view.getUint16(12, true),
    packetCount: view.getUint16(14, true),
    timestampMs: view.getUint32(16, true),
    payloadLen,
    aux: view.getUint32(24, true),
    aux2: view.getUint32(28, true),
    payload: bytes.slice(payloadStart, payloadEnd),
  };
};

// 选择可用的 H.264 编码配置。
const pickEncoderConfig = async (width, height, bitrate, framerate) => {
  const candidates = [
    {
      codec: "avc1.64001f",
      width,
      height,
      bitrate,
      framerate,
      latencyMode: "realtime",
      hardwareAcceleration: "prefer-hardware",
      avc: { format: "annexb" },
    },
    {
      codec: "avc1.42E01F",
      width,
      height,
      bitrate,
      framerate,
      latencyMode: "realtime",
      hardwareAcceleration: "prefer-hardware",
      avc: { format: "annexb" },
    },
    {
      codec: "avc1.42001f",
      width,
      height,
      bitrate,
      framerate,
      latencyMode: "realtime",
      hardwareAcceleration: "prefer-hardware",
      avc: { format: "annexb" },
    },
  ];

  for (const cfg of candidates) {
    try {
      const support = await VideoEncoder.isConfigSupported(cfg);
      if (support?.supported) {
        return support.config;
      }
    } catch {
      // ignore and try next
    }
  }

  throw new Error("当前环境不支持 H.264 WebCodecs 编码");
};

// 初始化视频编码器（H.264 低延迟）。
const ensureEncoder = async () => {
  if (state.encoder && state.encoderConfigured) {
    return;
  }

  const { profile } = getSelectedProfile();
  const bitrate = Math.max(300_000, Math.floor(state.cc.ewmaBitrateBps));
  const fps = Math.max(12, Math.floor(state.cc.currentFps));
  const config = await pickEncoderConfig(profile.width, profile.height, bitrate, fps);

  if (!state.encoder) {
    state.encoder = new VideoEncoder({
      output: (chunk) => {
        handleEncodedChunk(chunk).catch((error) => log("编码输出处理失败", error, 0));
      },
      error: (error) => {
        log("编码器错误", error, 0);
      },
    });
  }

  state.encoder.configure(config);
  state.encoderConfigured = true;
  log(`编码器配置：${config.codec} ${profile.width}x${profile.height} ${fps}fps`);
};

// 初始化视频解码器。
const ensureDecoder = async () => {
  if (state.decoder && state.decoderConfigured) {
    return;
  }

  const canvas = ui.remote_canvas;
  const ctx = canvas.getContext("2d", { alpha: false });

  if (!state.decoder) {
    state.decoder = new VideoDecoder({
      output: (frame) => {
        try {
          if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
            canvas.width = frame.displayWidth;
            canvas.height = frame.displayHeight;
          }
          ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
          state.rxLastCompleteFrameAt = Date.now();
          state.rxWindowFrames += 1;
          state.rxFramesPlayedSec += 1;
          updateMergedVideoView();
        } finally {
          frame.close();
        }
      },
      error: (error) => {
        log("解码器错误", error, 0);
        const now = Date.now();
        noteRxFrameDrop(now);
        maybeRequestPliForStall(now);
      },
    });
  }

  state.decoder.configure({
    codec: "avc1.42E01F",
    hardwareAcceleration: "prefer-hardware",
    optimizeForLatency: true,
  });
  state.decoderConfigured = true;
};

// 关闭编码器。
const closeEncoder = async () => {
  if (state.captureTimer) {
    clearInterval(state.captureTimer);
    state.captureTimer = null;
  }

  if (state.encoder) {
    try {
      await state.encoder.flush();
    } catch {
      // ignore flush failure
    }
    state.encoder.close();
    state.encoder = null;
  }

  state.encoderConfigured = false;
  state.retransCache.clear();
};

// 关闭解码器。
const closeDecoder = () => {
  if (state.decoder) {
    state.decoder.close();
    state.decoder = null;
  }
  state.decoderConfigured = false;
  state.rxFrameBuffer.clear();
  state.rxNeedKeyframe = true;
  state.rxConsecutiveDropFrames = 0;
  state.rxLastDropAt = 0;
  state.rxExpectedSeq = null;
  state.rxReorderPending.clear();
};
// 按 MTU 对编码后帧做分包，并缓存可重传的数据包。
const packetizeEncodedFrame = (frameBytes, isKeyframe, frameId, timestampMs) => {
  const packets = [];
  const totalBytes = frameBytes.length;
  const packetCount = Math.max(1, Math.ceil(totalBytes / PACKET_PAYLOAD_BYTES));

  for (let i = 0; i < packetCount; i += 1) {
    const start = i * PACKET_PAYLOAD_BYTES;
    const end = Math.min(totalBytes, start + PACKET_PAYLOAD_BYTES);
    const payload = frameBytes.slice(start, end);

    const seq = state.seq;
    state.seq = (state.seq + 1) >>> 0;

    const packet = buildPacket({
      kind: PKT_KIND_DATA,
      flags: isKeyframe ? FLAG_KEYFRAME : 0,
      seq,
      frameId,
      packetId: i,
      packetCount,
      timestampMs,
      payload,
      aux: totalBytes,
      aux2: 0,
    });

    packets.push(packet);

    const cacheKey = `${frameId}:${i}`;
    state.retransCache.set(cacheKey, {
      packet,
      sentAt: Date.now(),
      retransmitted: false,
      isKeyframe,
    });
  }

  return packets;
};

// 根据 FEC 比例追加冗余副本包（轻量冗余）。
const appendFecCopies = (packets, rate) => {
  if (!packets.length || rate <= 0) {
    return packets;
  }

  const out = [...packets];
  const extraCount = Math.floor(packets.length * rate);
  if (extraCount <= 0) {
    return out;
  }

  for (let i = 0; i < extraCount; i += 1) {
    const sourceIndex = Math.floor((i * packets.length) / extraCount);
    const src = packets[sourceIndex];
    const copy = src.slice();
    copy[1] = copy[1] | FLAG_FEC;
    out.push(copy);
  }

  return out;
};

// 计算每帧包铺开发送时长。
const computePacingSpreadMs = (packetCount) => {
  if (packetCount <= 1) {
    return PACING_MIN_MS;
  }
  const estimate = Math.round(packetCount * 0.7);
  return clamp(estimate, PACING_MIN_MS, PACING_MAX_MS);
};

// 清理过期重传缓存（关键帧与 delta 帧分别使用不同保留时间）。
const cleanupRetransCache = () => {
  const now = Date.now();
  for (const [key, item] of state.retransCache.entries()) {
    const keepMs = item.isKeyframe ? KEYFRAME_CACHE_KEEP_MS : DELTA_CACHE_KEEP_MS;
    if (now - item.sentAt > keepMs) {
      state.retransCache.delete(key);
    }
  }

  const overflow = state.retransCache.size - RETRANS_CACHE_MAX_ITEMS;
  if (overflow <= 0) {
    return;
  }

  const oldest = Array.from(state.retransCache.entries())
    .sort((a, b) => a[1].sentAt - b[1].sentAt)
    .slice(0, overflow);
  for (const [key] of oldest) {
    state.retransCache.delete(key);
  }
};

// 处理编码器输出，做分包 + FEC + pacing 发送。
const handleEncodedChunk = async (chunk) => {
  if (!state.mediaConnected) {
    return;
  }

  const isKeyframe = chunk.type === "key";
  if (isKeyframe) {
    state.lastKeyframeAt = Date.now();
  }

  const frameBytes = new Uint8Array(chunk.byteLength);
  chunk.copyTo(frameBytes);

  const frameId = state.frameId;
  state.frameId = (state.frameId + 1) >>> 0;
  const timestampMs = Date.now() & 0xffffffff;

  const dataPackets = packetizeEncodedFrame(frameBytes, isKeyframe, frameId, timestampMs);
  const packets = appendFecCopies(dataPackets, state.cc.currentFecRate);
  const wireBytes = packets.reduce((sum, pkt) => sum + pkt.byteLength, 0);

  const spreadMs = computePacingSpreadMs(dataPackets.length);
  const sent = await sendMediaBatch(packets, spreadMs);
  if (!sent) {
    return;
  }

  state.txWindowBytes += frameBytes.byteLength;
  state.txWindowFrames += 1;
  state.txPktsSec += packets.length;
  state.txBytesSec += wireBytes;
  state.txFramesSentSec += 1;
  state.txFramePktTotalSec += dataPackets.length;

  if (isKeyframe) {
    state.txKeyframesSec += 1;
  }

  cleanupRetransCache();
};

// 计算 32 位毫秒时钟下，距离 deadline 的剩余时间。
const remainingMsToDeadline32 = (deadlineMs, nowMs) => (deadlineMs - nowMs) | 0;

// 尝试发起数据包重传（仅一次且来得及才发）。
const tryRetransmitPacket = async (frameId, packetId, deadlineMs) => {
  const key = `${frameId}:${packetId}`;
  const item = state.retransCache.get(key);
  if (!item || item.retransmitted) {
    return;
  }

  const now = Date.now();
  const now32 = now & 0xffffffff;
  const estimatedRtt = state.cc.rttMs > 0 ? state.cc.rttMs : 80;
  const remainMs = remainingMsToDeadline32(deadlineMs >>> 0, now32 >>> 0);
  const remainGuardMs = item.isKeyframe ? 0 : DELTA_NACK_REMAIN_GUARD_MS;
  if (remainMs <= estimatedRtt + remainGuardMs) {
    return;
  }

  const copy = item.packet.slice();
  copy[1] = copy[1] | FLAG_RETRANS;
  const sent = await sendMediaBatch([copy], PACING_MIN_MS);
  if (!sent) {
    return;
  }

  item.retransmitted = true;
  item.sentAt = now;
  state.retransCache.set(key, item);
  log(`${item.isKeyframe ? "关键帧" : "delta 帧"}丢包重传 frame=${frameId} pid=${packetId}`, 0);
};

// 发送反馈探测请求。
const sendFeedbackReq = async () => {
  if (!state.mediaConnected) {
    return;
  }
  const reqTs = Date.now() & 0xffffffff;
  state.lastCcReqTs = reqTs;

  const seq = state.seq;
  state.seq = (state.seq + 1) >>> 0;

  const packet = buildPacket({
    kind: PKT_KIND_FEEDBACK_REQ,
    flags: 0,
    seq,
    frameId: 0,
    packetId: 0,
    packetCount: 0,
    timestampMs: reqTs,
    payload: new Uint8Array(0),
    aux: 0,
    aux2: 0,
  });

  await sendMediaBatch([packet], PACING_MIN_MS);
};

// 回复反馈包（带 jitter/loss）。
const sendFeedback = async (echoReqTs) => {
  if (!state.mediaConnected) {
    return;
  }

  const lossPermille = state.rxDeltaRecvPackets + state.rxDeltaLostPackets > 0
    ? Math.floor((state.rxDeltaLostPackets * 1000) / (state.rxDeltaRecvPackets + state.rxDeltaLostPackets))
    : 0;
  const jitterMs = Math.floor(state.rxJitterMs);

  const aux2 = ((lossPermille & 0xffff) << 16) | (jitterMs & 0xffff);

  const seq = state.seq;
  state.seq = (state.seq + 1) >>> 0;

  const packet = buildPacket({
    kind: PKT_KIND_FEEDBACK,
    flags: 0,
    seq,
    frameId: 0,
    packetId: 0,
    packetCount: 0,
    timestampMs: Date.now() & 0xffffffff,
    payload: new Uint8Array(0),
    aux: echoReqTs >>> 0,
    aux2,
  });

  await sendMediaBatch([packet], PACING_MIN_MS);

  state.rxDeltaRecvPackets = 0;
  state.rxDeltaLostPackets = 0;
};

// 更新最小 RTT 窗口，避免历史极小值长期锁死 queue_delay 基线。
const updateMinRttWindow = (rttMs, nowMs) => {
  const samples = state.cc.rttSamples;
  samples.push({ ts: nowMs, rttMs });

  const cutoff = nowMs - MIN_RTT_WINDOW_MS;
  while (samples.length > 0 && samples[0].ts < cutoff) {
    samples.shift();
  }

  if (samples.length === 0) {
    return rttMs;
  }

  let minRtt = samples[0].rttMs;
  for (let i = 1; i < samples.length; i += 1) {
    if (samples[i].rttMs < minRtt) {
      minRtt = samples[i].rttMs;
    }
  }
  return minRtt;
};

// 发送 NACK（关键帧可全量，delta 帧受限量策略约束）。
const sendNack = async (frameId, packetId, deadlineMs) => {
  if (!state.mediaConnected) {
    return;
  }

  const seq = state.seq;
  state.seq = (state.seq + 1) >>> 0;

  const packet = buildPacket({
    kind: PKT_KIND_NACK,
    flags: 0,
    seq,
    frameId,
    packetId,
    packetCount: 1,
    timestampMs: Date.now() & 0xffffffff,
    payload: new Uint8Array(0),
    aux: deadlineMs & 0xffffffff,
    aux2: 0,
  });

  await sendMediaBatch([packet], PACING_MIN_MS);
};

// 发送 PLI 请求关键帧。
const sendPli = async () => {
  if (!state.mediaConnected) {
    return;
  }

  const now = Date.now();
  if (now - state.rxPliLastSentAt < 180) {
    return;
  }
  state.rxPliLastSentAt = now;

  const seq = state.seq;
  state.seq = (state.seq + 1) >>> 0;

  const packet = buildPacket({
    kind: PKT_KIND_PLI,
    flags: 0,
    seq,
    frameId: state.rxLastCompleteFrameId,
    packetId: 0,
    packetCount: 0,
    timestampMs: now & 0xffffffff,
    payload: new Uint8Array(0),
    aux: 0,
    aux2: 0,
  });

  await sendMediaBatch([packet], PACING_MIN_MS);
  pushMetricTs(state.pliSentTs, now, 60_000);
};

// 重组并喂给解码器。
const tryAssembleFrame = async (frameId) => {
  const frameState = state.rxFrameBuffer.get(frameId);
  if (!frameState) {
    return;
  }

  if (frameState.packets.size !== frameState.packetCount) {
    return;
  }

  const merged = new Uint8Array(frameState.frameSize);
  let offset = 0;
  for (let i = 0; i < frameState.packetCount; i += 1) {
    const part = frameState.packets.get(i);
    if (!part) {
      return;
    }
    merged.set(part, offset);
    offset += part.length;
  }

  const bytes = merged.slice(0, frameState.frameSize);
  state.rxFramesCompletedSec += 1;
  state.rxCompletedFramePktTotalSec += frameState.packetCount;
  if (state.rxNeedKeyframe && !frameState.isKeyframe) {
    state.rxFrameBuffer.delete(frameId);
    return;
  }
  if (frameState.isKeyframe) {
    state.rxNeedKeyframe = false;
  }
  const chunk = new EncodedVideoChunk({
    type: frameState.isKeyframe ? "key" : "delta",
    timestamp: Number(frameState.timestampMs) * 1000,
    data: bytes,
  });

  try {
    await ensureDecoder();
    state.decoder.decode(chunk);
    state.rxLastCompleteFrameId = frameId;
    state.rxLastCompleteFrameAt = Date.now();
    state.rxConsecutiveDropFrames = 0;
    state.rxLastDropAt = 0;
    state.rxWindowBytes += bytes.byteLength;
  } catch (error) {
    log("解码输入失败", error, 0);
  } finally {
    state.rxFrameBuffer.delete(frameId);
  }
};
// 根据包到达情况更新抖动统计与接收计数。
const updateRxTransitStats = (packet) => {
  const now = Date.now();
  const transit = now - packet.timestampMs;
  if (Number.isFinite(transit)) {
    if (state.rxPrevTransitMs != null) {
      const delta = Math.abs(transit - state.rxPrevTransitMs);
      state.rxJitterMs = ewma(state.rxJitterMs, delta, 0.18);
    }
    state.rxPrevTransitMs = transit;
  }

  state.rxTargetDelayMs = clamp(
    Math.round(JITTER_MIN_MS + state.rxJitterMs),
    JITTER_MIN_MS,
    JITTER_MAX_MS,
  );
  state.rxDeltaRecvPackets += 1;
  state.rxDataPktsSec += 1;
};

// 计算 seq 相对 expected 的前向距离（0..2^32-1）。
const seqForwardDistance = (seq, expected) => (seq - expected) >>> 0;

// 每收到该帧的新包时，按 firstSeenAt + delay 刷新 deadline。
const refreshFrameDeadline = (frameState, now) => {
  const baseDelay = state.rxTargetDelayMs + RX_DEADLINE_SAFETY_MS;
  const arrivalBonus = Math.min(
    RX_DEADLINE_MAX_BONUS_MS,
    frameState.arrivalCount * RX_DEADLINE_BONUS_PER_PKT_MS,
  );
  const nextDeadline = frameState.firstSeenAt + baseDelay + arrivalBonus;
  frameState.deadlineAt = Math.max(frameState.deadlineAt, nextDeadline);
  frameState.lastPacketAt = now;
};

// 记录接收失败次数，仅连续多帧失败时进入关键帧恢复模式。
const noteRxFrameDrop = (now) => {
  if (now - state.rxLastDropAt > RX_NEED_KEYFRAME_DROP_WINDOW_MS) {
    state.rxConsecutiveDropFrames = 0;
  }
  state.rxConsecutiveDropFrames += 1;
  state.rxLastDropAt = now;
  if (state.rxConsecutiveDropFrames >= RX_NEED_KEYFRAME_DROP_THRESHOLD) {
    state.rxNeedKeyframe = true;
  }
};

// 连续长时间未出完整帧时请求关键帧。
const maybeRequestPliForStall = (now) => {
  const baseTs = state.rxLastCompleteFrameAt || state.rxStartAt;
  if (
    state.role !== "viewer" ||
    !state.startRequested ||
    baseTs <= 0 ||
    now - baseTs <= PLI_TIMEOUT_MS
  ) {
    return;
  }
  state.rxNeedKeyframe = true;
  sendPli().catch((error) => log("发送 PLI 失败", error, 0));
};

// 拉取 seq 连续的待处理包。
const flushContiguousPendingPackets = () => {
  const ready = [];
  while (state.rxExpectedSeq != null) {
    const queued = state.rxReorderPending.get(state.rxExpectedSeq);
    if (!queued) {
      break;
    }
    state.rxReorderPending.delete(state.rxExpectedSeq);
    ready.push(queued.packet);
    state.rxExpectedSeq = (state.rxExpectedSeq + 1) >>> 0;
  }
  return ready;
};

// 在乱序窗口超时后推进 expected，避免被单个丢包卡死。
const promotePendingPacketAfterTimeout = (now, force = false) => {
  if (state.rxExpectedSeq == null || state.rxReorderPending.size === 0) {
    return [];
  }

  let candidate = null;
  for (const [seq, item] of state.rxReorderPending.entries()) {
    const gap = seqForwardDistance(seq, state.rxExpectedSeq);
    if (gap === 0 || gap >= 0x80000000) {
      continue;
    }
    if (
      !candidate ||
      gap < candidate.gap ||
      (gap === candidate.gap && item.arrivalAt < candidate.arrivalAt)
    ) {
      candidate = { seq, gap, arrivalAt: item.arrivalAt };
    }
  }

  if (!candidate) {
    return [];
  }

  if (!force) {
    const ageMs = now - candidate.arrivalAt;
    if (ageMs < RX_SEQ_REORDER_HOLD_MS) {
      return [];
    }
  }

  state.rxDeltaLostPackets += candidate.gap;
  state.rxExpectedSeq = candidate.seq;
  return flushContiguousPendingPackets();
};

// 按 seq 做重排/补齐窗口，输出可以立即喂重组器的包。
const popReadyPacketsBySeq = (packet, now) => {
  if (state.rxExpectedSeq == null) {
    state.rxExpectedSeq = packet.seq;
  }

  const gap = seqForwardDistance(packet.seq, state.rxExpectedSeq);
  if (gap === 0) {
    state.rxExpectedSeq = (state.rxExpectedSeq + 1) >>> 0;
    return [packet, ...flushContiguousPendingPackets()];
  }

  if (gap < 0x80000000) {
    if (gap > RX_SEQ_REORDER_GAP_THRESHOLD) {
      if (!state.rxReorderPending.has(packet.seq)) {
        state.rxReorderPending.set(packet.seq, { packet, arrivalAt: now });
      }
      if (state.rxReorderPending.size > RX_SEQ_REORDER_MAX_PENDING) {
        return promotePendingPacketAfterTimeout(now, true);
      }
      return promotePendingPacketAfterTimeout(now, false);
    }

    state.rxDeltaLostPackets += gap;
    state.rxExpectedSeq = (packet.seq + 1) >>> 0;
    return [packet, ...flushContiguousPendingPackets()];
  }

  state.rxOutOfOrderPktsSec += 1;
  return [packet];
};

// 将有序包写入按帧缓存并尝试组帧。
const ingestOrderedDataPacket = async (packet, now) => {
  if (state.rxNeedKeyframe && !(packet.flags & FLAG_KEYFRAME)) {
    return;
  }

  const frameId = packet.frameId;
  let frameState = state.rxFrameBuffer.get(frameId);
  if (!frameState) {
    frameState = {
      isKeyframe: Boolean(packet.flags & FLAG_KEYFRAME),
      packetCount: packet.packetCount,
      frameSize: packet.aux,
      timestampMs: packet.timestampMs,
      firstSeenAt: now,
      deadlineAt: now + state.rxTargetDelayMs + RX_DEADLINE_SAFETY_MS,
      lastPacketAt: now,
      arrivalCount: 0,
      packets: new Map(),
      nackSent: new Set(),
      deltaNackRemaining: DELTA_NACK_MAX_PER_FRAME,
    };
    state.rxFrameBuffer.set(frameId, frameState);
  } else {
    frameState.isKeyframe = frameState.isKeyframe || Boolean(packet.flags & FLAG_KEYFRAME);
    frameState.packetCount = Math.max(frameState.packetCount, packet.packetCount);
    frameState.frameSize = Math.max(frameState.frameSize, packet.aux);
  }

  if (!frameState.packets.has(packet.packetId)) {
    frameState.packets.set(packet.packetId, packet.payload);
    frameState.arrivalCount += 1;
    refreshFrameDeadline(frameState, now);
  }

  await tryAssembleFrame(frameId);
};

// 处理 DATA 包。
const handleDataPacket = async (packet) => {
  const now = Date.now();
  updateRxTransitStats(packet);
  const readyPackets = popReadyPacketsBySeq(packet, now);
  for (const readyPacket of readyPackets) {
    await ingestOrderedDataPacket(readyPacket, now);
  }
};

// 处理 FEEDBACK 请求包。
const handleFeedbackReqPacket = async (packet) => {
  await sendFeedback(packet.timestampMs >>> 0);
};

// 处理 FEEDBACK 包并更新拥塞控制。
const handleFeedbackPacket = (packet) => {
  const nowWallMs = Date.now();
  const now = nowWallMs & 0xffffffff;
  const echoed = packet.aux >>> 0;
  let rtt = now - echoed;
  if (rtt < 0) {
    rtt += 0xffffffff;
  }
  rtt = clamp(rtt, 1, 2000);

  state.cc.rttMs = rtt;
  state.cc.minRttMs = updateMinRttWindow(rtt, nowWallMs);
  state.cc.queueDelayMs = Math.max(0, rtt - state.cc.minRttMs);

  const jitterMs = packet.aux2 & 0xffff;
  const lossPermille = (packet.aux2 >>> 16) & 0xffff;
  state.cc.lossPermille = lossPermille;

  let nextTarget = state.cc.targetBitrateBps;
  if (state.cc.queueDelayMs > 140) {
    nextTarget *= 0.93;
  } else if (state.cc.queueDelayMs > 100) {
    nextTarget *= 0.96;
  } else if (state.cc.queueDelayMs > 60) {
    nextTarget *= 0.98;
  } else if (state.cc.queueDelayMs > 30) {
    nextTarget *= 0.995;
  } else {
    nextTarget *= 1.02;
  }

  if (lossPermille > 120) {
    nextTarget *= 0.95;
  } else if (lossPermille > 80) {
    nextTarget *= 0.97;
  }

  const { profile } = getSelectedProfile();
  const minBps = 300_000;
  const maxBps = Math.max(600_000, profile.maxBitrateKbps * 1000);

  nextTarget = clamp(Math.floor(nextTarget), minBps, maxBps);
  state.cc.targetBitrateBps = nextTarget;
  state.cc.ewmaBitrateBps = Math.floor(ewma(state.cc.ewmaBitrateBps, nextTarget, 0.2));

  state.cc.currentFecRate = state.cc.queueDelayMs > 70 || jitterMs > 15
    ? FEC_MAX_RATE
    : FEC_MIN_RATE;

  refreshTargetFps();
};

// 处理 NACK 包。
const handleNackPacket = async (packet) => {
  if (state.role !== "share") {
    return;
  }
  state.nackRxSec += 1;
  await tryRetransmitPacket(packet.frameId, packet.packetId, packet.aux >>> 0);
};

// 处理 PLI 包。
const handlePliPacket = () => {
  if (state.role !== "share") {
    return;
  }
  pushMetricTs(state.pliRxTs, Date.now(), 60_000);
  state.forceNextKeyframe = true;
};

// 分发媒体数据包。
const handleIncomingMediaPacket = (bytes) => {
  state.rxPktsSec += 1;
  state.rxBytesSec += bytes.byteLength;
  const packet = parsePacket(bytes);
  if (!packet) {
    return;
  }

  if (packet.kind === PKT_KIND_DATA) {
    handleDataPacket(packet).catch((error) => log("处理 DATA 包失败", error, 0));
    return;
  }

  if (packet.kind === PKT_KIND_FEEDBACK_REQ) {
    handleFeedbackReqPacket(packet).catch((error) => log("处理 FEEDBACK_REQ 失败", error, 0));
    return;
  }

  if (packet.kind === PKT_KIND_FEEDBACK) {
    handleFeedbackPacket(packet);
    return;
  }

  if (packet.kind === PKT_KIND_NACK) {
    handleNackPacket(packet).catch((error) => log("处理 NACK 失败", error, 0));
    return;
  }

  if (packet.kind === PKT_KIND_PLI) {
    handlePliPacket();
  }
};

// 按 target_bitrate 与 min_bpf 计算 fps 档位。
const pickFpsByBitrate = () => {
  const { profile } = getSelectedProfile();
  const minBpf = profile.minBpf;
  const bitrate = state.cc.ewmaBitrateBps;

  let selected = FPS_LEVELS[0];
  for (const fps of FPS_LEVELS) {
    const bpf = bitrate / fps;
    if (bpf >= minBpf) {
      selected = fps;
    }
  }

  return selected;
};

// 刷新目标 fps（带冷却时间）。
const refreshTargetFps = () => {
  const now = Date.now();
  const targetFps = pickFpsByBitrate();

  if (targetFps === state.cc.currentFps) {
    return;
  }

  if (now - state.cc.lastFpsSwitchAt < FPS_COOLDOWN_MS) {
    return;
  }

  state.cc.currentFps = targetFps;
  state.cc.lastFpsSwitchAt = now;

  if (state.encoderConfigured) {
    ensureEncoder().catch((error) => log("编码器重配置失败", error, 0));
  }
};

// 检查接收健康状态，触发 NACK/PLI 与迟到丢帧。
const checkRxHealth = () => {
  const now = Date.now();
  const promotedPackets = promotePendingPacketAfterTimeout(now, false);
  for (const packet of promotedPackets) {
    ingestOrderedDataPacket(packet, now).catch((error) => {
      log("处理重排包失败", error, 0);
    });
  }

  for (const [frameId, frameState] of state.rxFrameBuffer.entries()) {
    const isComplete = frameState.packets.size === frameState.packetCount;
    if (isComplete) {
      continue;
    }

    if (now > frameState.deadlineAt) {
      state.rxDropDeadlineSec += 1;
      noteRxFrameDrop(now);
      state.rxFrameBuffer.delete(frameId);
      continue;
    }

    const estimatedRtt = state.cc.rttMs > 0 ? state.cc.rttMs : 80;
    const missingCount = frameState.packetCount - frameState.packets.size;
    if (missingCount <= 0) {
      continue;
    }

    if (!frameState.isKeyframe) {
      if (missingCount > DELTA_NACK_MAX_MISSING || frameState.deltaNackRemaining <= 0) {
        continue;
      }
    }

    for (let i = 0; i < frameState.packetCount; i += 1) {
      if (frameState.packets.has(i)) {
        continue;
      }
      if (frameState.nackSent.has(i)) {
        continue;
      }

      const remain = frameState.deadlineAt - now;
      const remainGuardMs = frameState.isKeyframe ? 0 : DELTA_NACK_REMAIN_GUARD_MS;
      if (remain <= estimatedRtt + remainGuardMs) {
        continue;
      }

      frameState.nackSent.add(i);
      if (!frameState.isKeyframe) {
        frameState.deltaNackRemaining -= 1;
      }
      sendNack(frameId, i, frameState.deadlineAt).catch((error) => {
        log("发送 NACK 失败", error, 0);
      });

      if (!frameState.isKeyframe && frameState.deltaNackRemaining <= 0) {
        break;
      }
    }
  }

  maybeRequestPliForStall(now);
};

// 初始化共享采集流。
const ensureShareStream = async () => {
  if (state.localStream) {
    return;
  }

  const { profile } = getSelectedProfile();
  const maxCaptureFps = FPS_LEVELS[FPS_LEVELS.length - 1];

  state.localStream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      width: { ideal: profile.width, max: profile.width },
      height: { ideal: profile.height, max: profile.height },
      frameRate: { ideal: maxCaptureFps, max: maxCaptureFps },
    },
    audio: false,
  });

  const track = state.localStream.getVideoTracks()[0];
  if (!track) {
    throw new Error("屏幕共享没有视频轨道");
  }

  track.contentHint = "detail";
  track.onended = () => {
    log("屏幕共享已结束");
    state.startRequested = false;
    stopSharePipeline().catch((error) => log("停止共享管线失败", error, 0));
  };

  ui.local_video.srcObject = state.localStream;
  updateMergedVideoView();
};

// 启动共享编码发送循环。
const startSharePipeline = async () => {
  await ensureShareStream();
  await ensureEncoder();

  if (state.captureTimer) {
    clearInterval(state.captureTimer);
  }

  state.captureTimer = setInterval(async () => {
    if (!state.startRequested || !state.localStream || !state.mediaConnected) {
      return;
    }
    if (state.captureBusy) {
      return;
    }

    const now = Date.now();
    const frameInterval = 1000 / Math.max(1, state.cc.currentFps);
    if (now - state.lastCaptureAt < frameInterval) {
      return;
    }

    const video = ui.local_video;
    if (!video || video.readyState < 2) {
      return;
    }

    state.captureBusy = true;
    try {
      const forceKey =
        state.forceNextKeyframe ||
        now - state.lastKeyframeAt >= KEYFRAME_INTERVAL_MS;

      const frame = new VideoFrame(video, { timestamp: now * 1000 });
      state.encoder.encode(frame, { keyFrame: forceKey });
      frame.close();

      if (forceKey) {
        state.forceNextKeyframe = false;
      }
      state.lastCaptureAt = now;
    } catch (error) {
      log("编码输入失败", error, 0);
    } finally {
      state.captureBusy = false;
    }
  }, 4);
};

// 停止共享编码发送循环。
const stopSharePipeline = async () => {
  await closeEncoder();
  if (state.localStream) {
    state.localStream.getTracks().forEach((track) => track.stop());
    state.localStream = null;
  }
  ui.local_video.srcObject = null;
};

// 停止观看端解码管线。
const stopViewerPipeline = () => {
  closeDecoder();
  const canvas = ui.remote_canvas;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width || 1, canvas.height || 1);
  state.rxLastCompleteFrameAt = 0;
  state.rxLastCompleteFrameId = 0;
  state.rxNeedKeyframe = true;
  state.rxStartAt = 0;
  state.rxFrameBuffer.clear();
  state.rxConsecutiveDropFrames = 0;
  state.rxLastDropAt = 0;
  state.rxExpectedSeq = null;
  state.rxReorderPending.clear();
};
// 启动拥塞控制探测定时器。
const startCcTimer = () => {
  if (state.ccTimer) {
    return;
  }

  state.ccTimer = setInterval(() => {
    sendFeedbackReq().catch((error) => log("发送 FEEDBACK_REQ 失败", error, 0));
  }, CC_INTERVAL_MS);
};

// 停止拥塞控制探测定时器。
const stopCcTimer = () => {
  if (state.ccTimer) {
    clearInterval(state.ccTimer);
    state.ccTimer = null;
  }
};

// 复位拥塞控制运行态，避免跨会话残留历史 RTT 基线。
const resetCcRuntime = () => {
  state.cc.minRttMs = Infinity;
  state.cc.rttMs = 0;
  state.cc.queueDelayMs = 0;
  state.cc.lossPermille = 0;
  state.cc.rttSamples = [];
};

// 处理信令业务消息。
const handleSignalMessage = async (msg) => {
  log(
    `recv signal type=${msg?.type || "?"} client_id=${msg?.client_id || "?"} role=${msg?.role || "?"}`,
    0,
  );

  if (!msg || msg.client_id === state.client_id) {
    return;
  }

  if (msg.client_id) {
    state.peerTargetId = msg.client_id;
  }

  if (msg.type === "join") {
    state.peerReady = true;

    if (state.role === "share" && msg.role === "viewer") {
      sendSignal({ type: "join", role: "share", target: state.peerTargetId || undefined });
      return;
    }

    if (state.role === "viewer" && msg.role === "share" && state.startRequested) {
      startCcTimer();
      await sendFeedbackReq();
    }
    return;
  }

  if (msg.type === "ping") {
    sendSignal({ type: "pong", role: state.role, target: msg.client_id || undefined, ts: msg.ts });
  }
};

// 处理信令系统消息。
const handleSignalSystem = async (sysMsg) => {
  const event = sysMsg.__sys;
  const message = sysMsg.message || "";
  log(`signal sys: ${event}${message ? ` | ${message}` : ""}`, 0);
  logTrace("signal sys", `event=${event}${message ? `, message=${message}` : ""}`);

  if (event === "listener_started") {
    state.signalListening = true;
    if (state.role === "share") {
      updateStatus("信令监听中", "#f6c177");
    }
    return;
  }

  if (event === "listener_stopped") {
    state.signalListening = false;
    state.signalConnected = false;
    if (!state.transportResetting) {
      scheduleSignalReconnect("signal-listener-stopped");
    }
    return;
  }

  if (event === "connected") {
    state.signalConnected = true;
    state.reconnectAttempts = 0;
    clearReconnectTimer();
    try {
      await syncMediaPeerFromSignal(message);
    } catch (error) {
      log("同步媒体对端失败", error, 0);
    }

    sendSignal({ type: "join", role: state.role, target: state.peerTargetId || undefined, ts: Date.now() });

    if (state.role === "viewer" && state.startRequested) {
      startCcTimer();
      await sendFeedbackReq();
    }

    if (state.mediaConnected) {
      updateStatus("已连接", "#7ee787");
    } else {
      updateStatus("信令已连接", "#7ee787");
    }
    return;
  }

  if (event === "disconnected") {
    state.signalConnected = false;
    if (!state.transportResetting && (state.role === "viewer" || !state.signalListening)) {
      scheduleSignalReconnect("signal-disconnected");
    }
    return;
  }

  if (event === "error" && !state.transportResetting) {
    scheduleSignalReconnect("signal-error");
  }
};

// 建立通道。
const connectChannels = async ({ isReconnect = false, expectedReconnectEpoch = null } = {}) => {
  if (!isTauri()) {
    throw new Error("当前不是 Tauri 环境，无法使用 libzt 通道");
  }
  if (state.connecting) {
    throw new Error("通道连接中，请稍后");
  }
  if (isReconnect && (state.manualDisconnect || !state.autoReconnectEnabled)) {
    return;
  }
  if (
    typeof expectedReconnectEpoch === "number" &&
    expectedReconnectEpoch !== state.reconnectEpoch
  ) {
    return;
  }
  if (!isReconnect) {
    state.reconnectEpoch += 1;
  }
  const connectEpoch = state.reconnectEpoch;

  state.connecting = true;
  setButtonsBusy(true);
  let reconnectAfterFailure = false;
  state.transportResetting = true;

  try {
    clearReconnectTimer();

    if (!isReconnect) {
      state.manualDisconnect = false;
      state.autoReconnectEnabled = true;
      state.reconnectAttempts = 0;
    }

    state.role = ui.role_select.value;

    reportConnectStage("关闭旧通道");
    await closeTransports();
    if (isConnectFlowCancelled(connectEpoch)) {
      return;
    }
    reportConnectStage("启动 libzt...");
    await ensureLibztStarted();
    if (isConnectFlowCancelled(connectEpoch)) {
      return;
    }
    reportConnectStage("等待 ZeroTier 就绪");
    const libztReady = await waitForLibztReady(LIBZT_READY_GRACE_MS, (elapsedSec) => {
      reportConnectStage(
        `等待 ZeroTier 就绪(${elapsedSec}s)`,
        `nodeOnline=${state.libztNodeOnline}, networkReady=${state.libztNetworkReady}`,
      );
    });
    if (isConnectFlowCancelled(connectEpoch)) {
      return;
    }

    const signalPort = getSignalPort();
    const mediaPort = getMediaPort();

    if (!libztReady) {
      const ip = ui.host_ip?.value || "";
      throw new Error(
        `ZeroTier 尚未就绪，稍后重试（nodeOnline=${state.libztNodeOnline}, networkReady=${state.libztNetworkReady}, ip=${ip || "none"}）`,
      );
    }

    if (state.role === "share") {
      reportConnectStage("启动共享监听");
      await invoke("zt_signal_listen", { port: signalPort });
      await invoke("zt_media_listen", { port: mediaPort });
      state.signalListening = true;
      state.signalConnected = false;
      state.mediaConnected = true;
      state.mediaPeerKnown = false;
      state.mediaPeerUnknownNotified = false;
      updateStatus("监听中", "#f6c177");
      log(`已监听：signal=${signalPort}, media(udp)=${mediaPort}`);
    } else {
      const peerIp = ui.peer_ip.value.trim();
      if (!peerIp) {
        throw new Error("观看端必须填写对方 IP");
      }

      await connectViewerWithRetry({
        peerIp,
        signalPort,
        mediaPort,
        connectEpoch,
      });
      if (isConnectFlowCancelled(connectEpoch)) {
        return;
      }
      state.signalConnected = true;
      state.signalListening = false;
      state.mediaConnected = true;
      state.mediaPeerKnown = true;
      state.mediaPeerUnknownNotified = false;
      updateStatus("已连接", "#7ee787");
      log(`已连接：${peerIp} signal=${signalPort}, media(udp)=${mediaPort}`);

      sendSignal({ type: "join", role: "viewer", ts: Date.now() });
    }

    startSignalPump();
    startMediaPump();

    state.reconnectAttempts = 0;
    clearReconnectTimer();
    logTrace("connectChannels success", `isReconnect=${isReconnect}`);
  } catch (error) {
    await closeTransports();
    if (state.manualDisconnect || connectEpoch !== state.reconnectEpoch) {
      logTrace("connectChannels aborted", `isReconnect=${isReconnect}, epoch=${connectEpoch}`);
      return;
    }

    const message =
      error && typeof error.message === "string"
        ? error.message
        : String(error || "");
    const isInputValidationError =
      (state.role === "viewer" && message.includes("观看端必须填写对方 IP")) ||
      message.includes("Network 为空");
    const shouldRetry =
      state.autoReconnectEnabled &&
      !state.manualDisconnect &&
      !isInputValidationError;
    if (shouldRetry) {
      reconnectAfterFailure = true;
      updateStatus("等待对端就绪，自动重试中", "#f6c177");
      log("通道尚未就绪，已切换为自动重试模式", error);
      return;
    }

    throw error;
  } finally {
    state.transportResetting = false;
    state.connecting = false;
    setButtonsBusy(false);
    if (reconnectAfterFailure && !state.manualDisconnect && connectEpoch === state.reconnectEpoch) {
      scheduleSignalReconnect(isReconnect ? "reconnect-attempt-failed" : "initial-connect-failed");
    }
  }
};

// 开始共享或观看。
const startShareOrView = async () => {
  state.startRequested = true;
  state.role = ui.role_select.value;
  resetCcRuntime();
  logTrace("startShareOrView", `role=${state.role}`);

  if (state.role === "viewer") {
    if (!state.signalConnected || !state.mediaConnected) {
      log("观看端请先建立通道");
      return;
    }

    await ensureDecoder();
    state.rxNeedKeyframe = true;
    state.rxStartAt = Date.now();
    state.rxLastCompleteFrameAt = 0;
    state.rxConsecutiveDropFrames = 0;
    state.rxLastDropAt = 0;
    state.rxExpectedSeq = null;
    state.rxReorderPending.clear();
    startCcTimer();
    await sendFeedbackReq();
    updateStatus("已连接，等待远端画面", "#7ee787");
    sendSignal({ type: "join", role: "viewer", target: state.peerTargetId || undefined });
    return;
  }

  if (!state.signalListening || !state.mediaConnected) {
    log("共享端请先建立监听");
    return;
  }

  try {
    if (!state.session_id) {
      state.session_id = crypto.randomUUID();
    }

    state.cc.targetBitrateBps = getSelectedProfile().profile.maxBitrateKbps * 1000;
    state.cc.ewmaBitrateBps = state.cc.targetBitrateBps;
    state.cc.currentFps = pickFpsByBitrate();
    state.cc.lastFpsSwitchAt = 0;

    await startSharePipeline();
    startCcTimer();

    const { profileKey, profile } = getSelectedProfile();
    log(
      `共享端已开始：H.264 UDP ${profileKey}${state.cc.currentFps}（目标 ${profile.maxBitrateKbps}kbps）`,
    );
    sendSignal({ type: "join", role: "share", target: state.peerTargetId || undefined });
  } catch (error) {
    log("无法开始共享", error);
  }
};

// 快速观看入口。
const quickViewByIp = async () => {
  const ip = ui.peer_ip.value.trim();
  if (!ip) {
    log("请填写对方 IP");
    return;
  }

  ui.role_select.value = "viewer";
  state.peerTargetId = "";
  refreshMuteButton();

  await connectChannels();
  await startShareOrView();
};

// 打开日志目录。
const openLogFolder = async () => {
  if (!isTauri()) {
    log("当前环境不支持打开日志目录");
    return;
  }

  await invoke("open_log_dir");
};

// 断开所有连接并复位。
const disconnectAll = async () => {
  logTrace("disconnectAll begin");

  state.reconnectEpoch += 1;
  state.manualDisconnect = true;
  state.autoReconnectEnabled = false;
  state.transportResetting = true;
  clearReconnectTimer();
  clearOfflineTimer();

  stopCcTimer();
  await stopSharePipeline();
  stopViewerPipeline();
  resetCcRuntime();

  await closeTransports();
  await stopLibzt();

  state.startRequested = false;
  state.peerReady = false;
  state.peerTargetId = "";
  state.session_id = "";
  state.reconnectAttempts = 0;
  state.transportResetting = false;
  state.mediaConnected = false;
  state.mediaPeerKnown = false;
  state.mediaPeerUnknownNotified = false;

  updateMergedVideoView();
  updateStatus("未连接", "#b1b1b1");
  logTrace("disconnectAll complete");
};

// 启动统计监控。
const startStatsMonitor = () => {
  if (state.statsTimer) {
    clearInterval(state.statsTimer);
  }

  state.statsTimer = setInterval(() => {
    const txKbps = (state.txWindowBytes * 8) / 1000 / (STATS_INTERVAL_MS / 1000);
    const rxKbps = (state.rxWindowBytes * 8) / 1000 / (STATS_INTERVAL_MS / 1000);
    const txFps = state.txWindowFrames / (STATS_INTERVAL_MS / 1000);
    const rxFps = state.rxWindowFrames / (STATS_INTERVAL_MS / 1000);

    if (state.role === "share") {
      updateRemoteStats(
        `TX ${txKbps.toFixed(0)} kbps | FPS ${txFps.toFixed(1)} | RTT ${state.cc.rttMs.toFixed(0)} ms | QD ${state.cc.queueDelayMs.toFixed(0)} ms | FEC ${(state.cc.currentFecRate * 100).toFixed(0)}%`,
      );
    } else {
      updateRemoteStats(
        `RX ${rxKbps.toFixed(0)} kbps | FPS ${rxFps.toFixed(1)} | Jitter ${state.rxJitterMs.toFixed(1)} ms | Delay ${state.rxTargetDelayMs.toFixed(0)} ms`,
      );
    }

    state.txWindowBytes = 0;
    state.txWindowFrames = 0;
    state.rxWindowBytes = 0;
    state.rxWindowFrames = 0;
  }, STATS_INTERVAL_MS);
};

// 每秒写入一行收发核心指标到日志文件（不写 UI）。
const startMetricsLogger = () => {
  if (state.metricsLogTimer) {
    clearInterval(state.metricsLogTimer);
  }
  resetSecondMetrics();

  state.metricsLogTimer = setInterval(() => {
    const now = Date.now();
    const pliPerMin = countMetricTs(state.pliSentTs, now, 60_000);
    const pliRxPerMin = countMetricTs(state.pliRxTs, now, 60_000);

    if (state.role === "viewer" && state.startRequested) {
      const hasViewerTraffic =
        state.rxPktsSec > 0 ||
        state.rxFramesCompletedSec > 0 ||
        state.rxFramesPlayedSec > 0 ||
        state.rxDropDeadlineSec > 0;
      if (!hasViewerTraffic) {
        resetSecondMetrics();
        return;
      }

      const avgPktCntPerFrame = state.rxFramesCompletedSec > 0
        ? state.rxCompletedFramePktTotalSec / state.rxFramesCompletedSec
        : 0;
      const outOfOrderRate = state.rxDataPktsSec > 0
        ? state.rxOutOfOrderPktsSec / state.rxDataPktsSec
        : 0;
      const rxKbps = (state.rxBytesSec * 8) / 1000;

      log(
        `[viewer-metrics] rx_pkts/s=${state.rxPktsSec} rx_kbps=${rxKbps.toFixed(1)} frames_completed/s=${state.rxFramesCompletedSec} frames_played/s=${state.rxFramesPlayedSec} drop_deadline/s=${state.rxDropDeadlineSec} avg_pkt_cnt_per_frame=${avgPktCntPerFrame.toFixed(2)} out_of_order_rate=${(outOfOrderRate * 100).toFixed(2)}% pli/min=${pliPerMin} target_delay_ms=${Math.round(state.rxTargetDelayMs)}`,
        0,
      );
    } else if (state.role === "share" && state.startRequested) {
      const hasSenderTraffic =
        state.txPktsSec > 0 ||
        state.txFramesSentSec > 0 ||
        state.nackRxSec > 0;
      if (!hasSenderTraffic) {
        resetSecondMetrics();
        return;
      }

      const avgPktCntPerFrame = state.txFramesSentSec > 0
        ? state.txFramePktTotalSec / state.txFramesSentSec
        : 0;
      const txKbps = (state.txBytesSec * 8) / 1000;

      log(
        `[sender-metrics] tx_pkts/s=${state.txPktsSec} tx_kbps=${txKbps.toFixed(1)} frames_sent/s=${state.txFramesSentSec} keyframes/s=${state.txKeyframesSec} avg_pkt_cnt_per_frame=${avgPktCntPerFrame.toFixed(2)} nack_rx/s=${state.nackRxSec} pli_rx/min=${pliRxPerMin} target_bitrate_kbps=${Math.round(state.cc.targetBitrateBps / 1000)} fps=${state.cc.currentFps} queue_delay_ms=${Math.round(state.cc.queueDelayMs)} rtt_ms=${Math.round(state.cc.rttMs)} fec_rate=${Math.round(state.cc.currentFecRate * 100)}%`,
        0,
      );
    }

    resetSecondMetrics();
  }, METRICS_LOG_INTERVAL_MS);
};

// 初始化表单与首屏状态。
const initForm = () => {
  ui.host_ip.value = "";
  ui.port.value = String(config.signaling.defaultPort || 34157);
  ui.network_input.value =
    config.signaling.network || config.user.defaultNetwork || "";
  ui.role_select.value = config.user.defaultRole || "share";
  ui.peer_ip.value = "";

  if (ui.quality_select) {
    ui.quality_select.value = DEFAULT_QUALITY;
  }

  ui.local_video.srcObject = null;
  const canvas = ui.remote_canvas;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width || 1, canvas.height || 1);

  refreshMuteButton();
  updateMergedVideoView();
  updateRemoteStats("Bitrate: - kbps | FPS: -");
  startStatsMonitor();
  startMetricsLogger();
};

ui.connect_btn.addEventListener("click", () => {
  connectChannels().catch((error) => log("建立通道失败", error));
});

ui.role_select.addEventListener("change", () => {
  refreshMuteButton();
});

ui.start_btn.addEventListener("click", () => {
  startShareOrView().catch((error) => log("开始共享/观看失败", error));
});

ui.quickViewBtn.addEventListener("click", () => {
  quickViewByIp().catch((error) => log("输入 IP 观看失败", error));
});

ui.mute_remote_btn.addEventListener("click", () => {
  log("当前模式无音频流");
});

ui.open_log_btn.addEventListener("click", () => {
  openLogFolder().catch((error) => log("打开日志目录失败", error));
});

ui.stop_btn.addEventListener("click", () => {
  disconnectAll().catch((error) => log("断开失败", error));
});

initForm();
updateStatus("未连接", "#b1b1b1");
log("应用已就绪（纯 ZeroTier UDP H.264 模式）");
