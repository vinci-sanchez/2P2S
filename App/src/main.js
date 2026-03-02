import { invoke } from "@tauri-apps/api/tauri";
import config from "../config.js";

const SHARE_PROFILES = {
  "360p": { width: 640, height: 360, maxBitrateKbps: 800, jpegQuality: 0.6 },
  "480p": { width: 854, height: 480, maxBitrateKbps: 1200, jpegQuality: 0.66 },
  "720p": { width: 1280, height: 720, maxBitrateKbps: 2500, jpegQuality: 0.74 },
  "1080p": { width: 1920, height: 1080, maxBitrateKbps: 5000, jpegQuality: 0.8 },
};

const DEFAULT_QUALITY = "720p";
const DEFAULT_FPS = 30;
const SIGNAL_POLL_INTERVAL_MS = 120;
const MEDIA_POLL_INTERVAL_MS = 20;
const LIBZT_EVENT_POLL_INTERVAL_MS = 500;
const STATS_INTERVAL_MS = 1000;
const OFFLINE_DEBOUNCE_MS = 3000;
const LIBZT_READY_GRACE_MS = 5000;
const LIBZT_READY_POLL_MS = 150;
const SIGNAL_RECONNECT_DELAYS_MS = [1000, 2000, 5000, 8000, 12000];
const MAX_UI_LOG_ITEMS = 300;
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
  mediaConnected: false,
  mediaListening: false,

  signalPumpTimer: null,
  signalPollBusy: false,
  mediaPumpTimer: null,
  mediaPollBusy: false,
  libztEventPumpTimer: null,
  libztEventPollBusy: false,

  startRequested: false,
  peerReady: false,
  peerTargetId: "",

  localStream: null,
  captureCanvas: null,
  captureCtx: null,
  captureTimer: null,
  captureInFlight: false,
  frameSeq: 0,
  remoteFrameActive: false,
  remoteDecodeBusy: false,
  pendingRemoteFrame: null,

  statsTimer: null,
  txWindowBytes: 0,
  txWindowFrames: 0,
  rxWindowBytes: 0,
  rxWindowFrames: 0,
};

const qs = (selector) => document.querySelector(selector);
const ui = {
  host_ip: qs("#host_ip"),
  port: qs("#port"),
  network_input: qs("#network_input"),
  role_select: qs("#role_select"),
  peer_ip: qs("#peer_ip"),
  quality_select: qs("#quality_select"),
  fps_select: qs("#fps_select"),
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

const isTauri = () => Boolean(window.__TAURI__) && typeof invoke === "function";

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

const writeLogToFile = async (entry) => {
  if (!isTauri()) {
    return;
  }
  try {
    await invoke("append_log", { message: entry });
  } catch {
    // ignore log write failures
  }
};

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

const summarizeState = () =>
  `role=${state.role} ztOnline=${state.libztNodeOnline} netReady=${state.libztNetworkReady} signal=${state.signalConnected}/${state.signalListening} media=${state.mediaConnected}/${state.mediaListening} startRequested=${state.startRequested} peerReady=${state.peerReady} target=${state.peerTargetId || "-"} reconnectAttempts=${state.reconnectAttempts}`;

const logTrace = (title, detail = "", channel = 0) => {
  const body = detail ? `${title} | ${detail}` : title;
  log(`[trace] ${body} | ${summarizeState()}`, channel);
};

const updateStatus = (text, color) => {
  ui.status_Text.textContent = text;
  ui.status_point.style.background = color;
  log(`状态更新：${text}`);
};

const updateRemoteStats = (text) => {
  if (ui.remote_stats) {
    ui.remote_stats.textContent = text;
  }
};

const updateMergedVideoView = () => {
  const showRemote = state.remoteFrameActive;
  const showLocal = !showRemote && Boolean(ui.local_video.srcObject);

  ui.remote_canvas.classList.toggle("video-hidden", !showRemote);
  ui.local_video.classList.toggle("video-hidden", !showLocal);

  if (ui.video_source_tag) {
    if (showRemote) {
      ui.video_source_tag.textContent = "远端画面";
    } else if (showLocal) {
      ui.video_source_tag.textContent = "本地预览";
    } else {
      ui.video_source_tag.textContent = "无信号";
    }
  }
};

const setButtonsBusy = (busy) => {
  if (ui.connect_btn) {
    ui.connect_btn.disabled = busy;
  }
};

const getSignalPort = () => {
  const input = Number(ui.port.value);
  if (Number.isFinite(input) && input > 0 && input <= 65535) {
    return input;
  }
  return Number(config.signaling.defaultPort) || 34157;
};

const getMediaPort = () => {
  const base = getSignalPort();
  if (base >= 65535) {
    return 65535;
  }
  return base + 1;
};

const getSelectedFps = () => {
  const raw = Number(ui.fps_select?.value);
  if (Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  return DEFAULT_FPS;
};

const getSelectedProfile = () => {
  const profileKey = ui.quality_select?.value || DEFAULT_QUALITY;
  const profile = SHARE_PROFILES[profileKey] || SHARE_PROFILES[DEFAULT_QUALITY];
  return { profileKey, profile };
};

const refreshMuteButton = () => {
  ui.mute_remote_btn.disabled = true;
  ui.mute_remote_btn.textContent = "无音频（保留）";
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const hasLibztReady = () => {
  const hasIp = Boolean(ui.host_ip && ui.host_ip.value && ui.host_ip.value !== "0.0.0.0");
  // Match libzt docs more closely: socket traffic should start only after node
  // is online and the network transport/address is ready.
  return state.libztNodeOnline && (state.libztNetworkReady || hasIp);
};

const clearReconnectTimer = () => {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
};

const clearOfflineTimer = () => {
  if (state.libztOfflineTimer) {
    clearTimeout(state.libztOfflineTimer);
    state.libztOfflineTimer = null;
  }
};

const stopSignalPump = () => {
  if (state.signalPumpTimer) {
    clearInterval(state.signalPumpTimer);
    state.signalPumpTimer = null;
  }
  state.signalPollBusy = false;
};

const stopMediaPump = () => {
  if (state.mediaPumpTimer) {
    clearInterval(state.mediaPumpTimer);
    state.mediaPumpTimer = null;
  }
  state.mediaPollBusy = false;
};

const stopLibztEventPump = () => {
  if (state.libztEventPumpTimer) {
    clearInterval(state.libztEventPumpTimer);
    state.libztEventPumpTimer = null;
  }
  state.libztEventPollBusy = false;
};

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

const closeMediaTransport = async () => {
  stopMediaPump();
  state.mediaConnected = false;
  state.mediaListening = false;
  if (!isTauri()) {
    return;
  }
  try {
    await invoke("zt_media_close");
  } catch (error) {
    log("关闭媒体通道失败", error, 0);
  }
};

const closeTransports = async () => {
  await closeSignalTransport();
  await closeMediaTransport();
};

const shouldScheduleReconnect = () => {
  if (state.role === "viewer") {
    return true;
  }

  // In share mode, if both listeners are alive, reconnecting channels is harmful:
  // it tears down active sockets and causes viewers to be disconnected.
  const listenersHealthy = state.signalListening && state.mediaListening;
  return !listenersHealthy;
};

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

  const idx = Math.min(
    state.reconnectAttempts,
    SIGNAL_RECONNECT_DELAYS_MS.length - 1,
  );
  const delay = SIGNAL_RECONNECT_DELAYS_MS[idx];
  state.reconnectAttempts += 1;

  updateStatus(`重连中(${state.reconnectAttempts})`, "#f6c177");
  log(
    `libzt 通道重连调度：${delay}ms 后重连，reason=${reason}, role=${state.role}`,
  );
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
    } catch (error) {
      log("libzt 通道重连失败", error);
      scheduleSignalReconnect("retry-failed");
    }
  }, delay);
};

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

const sendMedia = async (payload) => {
  if (!state.mediaConnected) {
    return false;
  }

  const wire = JSON.stringify({
    ...payload,
    client_id: state.client_id,
    session_id: state.session_id,
  });

  try {
    await invoke("zt_media_send", { payload: wire });
    return true;
  } catch (error) {
    state.mediaConnected = false;
    log("媒体发送失败", error);
    if (state.role === "viewer") {
      scheduleSignalReconnect("media-send-failed");
    }
    return false;
  }
};

const uint8ToBase64 = (bytes) => {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
};

const base64ToBlob = (base64, mime = "image/jpeg") => {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
};

const stopCaptureLoop = () => {
  if (state.captureTimer) {
    clearInterval(state.captureTimer);
    state.captureTimer = null;
  }
  state.captureInFlight = false;
};

const stopLocalStream = () => {
  stopCaptureLoop();
  if (state.localStream) {
    state.localStream.getTracks().forEach((track) => track.stop());
    state.localStream = null;
  }
  ui.local_video.srcObject = null;
};

const resetRemoteCanvas = () => {
  const canvas = ui.remote_canvas;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width || 1, canvas.height || 1);
  state.remoteFrameActive = false;
  state.pendingRemoteFrame = null;
  state.remoteDecodeBusy = false;
};

const resetStatsWindow = () => {
  state.txWindowBytes = 0;
  state.txWindowFrames = 0;
  state.rxWindowBytes = 0;
  state.rxWindowFrames = 0;
};

const startStatsMonitor = () => {
  if (state.statsTimer) {
    clearInterval(state.statsTimer);
  }

  state.statsTimer = setInterval(() => {
    const txKbps = (state.txWindowBytes * 8) / 1000;
    const rxKbps = (state.rxWindowBytes * 8) / 1000;
    const txFps = state.txWindowFrames;
    const rxFps = state.rxWindowFrames;

    if (state.role === "share") {
      updateRemoteStats(
        `TX ${txKbps.toFixed(0)} kbps | FPS ${txFps.toFixed(1)} | Media ${state.mediaConnected ? "on" : "off"} | Signal ${state.signalConnected ? "on" : "off"}`,
      );
    } else {
      updateRemoteStats(
        `RX ${rxKbps.toFixed(0)} kbps | FPS ${rxFps.toFixed(1)} | Media ${state.mediaConnected ? "on" : "off"} | Signal ${state.signalConnected ? "on" : "off"}`,
      );
    }

    resetStatsWindow();
  }, STATS_INTERVAL_MS);
};

const renderRemoteFrame = async (frame) => {
  if (!frame || !frame.data) {
    return;
  }

  const canvas = ui.remote_canvas;
  const ctx = canvas.getContext("2d");
  const width = Number(frame.width) || canvas.width || 640;
  const height = Number(frame.height) || canvas.height || 360;

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const blob = base64ToBlob(frame.data, "image/jpeg");
  const bitmap = await createImageBitmap(blob);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  state.remoteFrameActive = true;
  updateMergedVideoView();

  const bytes = Number(frame.byte_len) || Math.floor((frame.data.length * 3) / 4);
  state.rxWindowBytes += Math.max(0, bytes);
  state.rxWindowFrames += 1;
};

const drainRemoteFrames = async () => {
  if (state.remoteDecodeBusy) {
    return;
  }
  const next = state.pendingRemoteFrame;
  if (!next) {
    return;
  }

  state.pendingRemoteFrame = null;
  state.remoteDecodeBusy = true;
  try {
    await renderRemoteFrame(next);
  } catch (error) {
    log("远端帧解码失败", error, 0);
  } finally {
    state.remoteDecodeBusy = false;
    if (state.pendingRemoteFrame) {
      drainRemoteFrames().catch((error) => log("远端帧队列处理失败", error, 0));
    }
  }
};

const queueRemoteFrame = (frame) => {
  state.pendingRemoteFrame = frame;
  drainRemoteFrames().catch((error) => log("远端帧渲染失败", error, 0));
};

const captureAndSendFrame = async () => {
  if (!state.localStream || !state.mediaConnected || state.captureInFlight) {
    return;
  }

  const video = ui.local_video;
  if (!video || video.readyState < 2) {
    return;
  }

  state.captureInFlight = true;

  try {
    const { profileKey, profile } = getSelectedProfile();
    if (!state.captureCanvas) {
      state.captureCanvas = document.createElement("canvas");
      state.captureCtx = state.captureCanvas.getContext("2d", { alpha: false });
    }

    state.captureCanvas.width = profile.width;
    state.captureCanvas.height = profile.height;
    state.captureCtx.drawImage(video, 0, 0, profile.width, profile.height);

    const blob = await new Promise((resolve) => {
      state.captureCanvas.toBlob(
        resolve,
        "image/jpeg",
        profile.jpegQuality,
      );
    });

    if (!blob) {
      return;
    }

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const data = uint8ToBase64(bytes);
    state.frameSeq += 1;

    const ok = await sendMedia({
      type: "frame",
      seq: state.frameSeq,
      width: profile.width,
      height: profile.height,
      profile: profileKey,
      fps: getSelectedFps(),
      ts: Date.now(),
      key: state.frameSeq % Math.max(1, getSelectedFps()) === 0,
      byte_len: bytes.byteLength,
      data,
      target: state.peerTargetId || undefined,
    });

    if (ok) {
      state.txWindowBytes += bytes.byteLength;
      state.txWindowFrames += 1;
    }
  } catch (error) {
    log("采集并发送帧失败", error, 0);
  } finally {
    state.captureInFlight = false;
  }
};

const startCaptureLoop = () => {
  stopCaptureLoop();
  const fps = getSelectedFps();
  const interval = Math.max(16, Math.floor(1000 / fps));
  state.captureTimer = setInterval(() => {
    captureAndSendFrame().catch((error) => log("发送帧异常", error, 0));
  }, interval);
};

const ensureShareStream = async () => {
  if (state.localStream) {
    return;
  }

  const { profile } = getSelectedProfile();
  const fps = getSelectedFps();

  state.localStream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      width: { ideal: profile.width, max: profile.width },
      height: { ideal: profile.height, max: profile.height },
      frameRate: { ideal: fps, max: fps },
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
    stopCaptureLoop();
  };

  ui.local_video.srcObject = state.localStream;
  updateMergedVideoView();
};

const handleSignalMessage = async (msg) => {
  log(
    `recv signal type=${msg.type || "?"} client_id=${msg.client_id || "?"} role=${msg.role || "?"}`,
    0,
  );

  if (!msg || msg.client_id === state.client_id) {
    return;
  }

  if (msg.type === "join") {
    if (msg.client_id) {
      state.peerTargetId = msg.client_id;
      state.peerReady = true;
    }

    if (state.role === "share" && msg.role === "viewer") {
      sendSignal({ type: "join", role: "share", target: state.peerTargetId || undefined });
      if (state.startRequested) {
        sendSignal({ type: "start", role: "share", target: state.peerTargetId || undefined });
      }
      log("收到 viewer join，已回发 share join/start", 0);
      return;
    }

    if (state.role === "viewer" && msg.role === "share") {
      log("收到 share join", 0);
      if (state.startRequested) {
        updateStatus("已连接，等待远端帧", "#7ee787");
      }
    }
    return;
  }

  if (msg.type === "start" && state.role === "viewer") {
    updateStatus("正在接收远端帧", "#7ee787");
    log("收到 start 信号，等待远端画面", 0);
    return;
  }

  if (msg.type === "ping") {
    sendSignal({ type: "pong", role: state.role, target: msg.client_id || undefined, ts: msg.ts });
    return;
  }
};

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

    sendSignal({
      type: "join",
      role: state.role,
      target: state.peerTargetId || undefined,
      ts: Date.now(),
    });

    if (state.role === "share" && state.startRequested) {
      sendSignal({ type: "start", role: "share", target: state.peerTargetId || undefined });
    }

    if (state.mediaConnected) {
      updateStatus("已连接", "#7ee787");
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

  if (event === "error") {
    if (!state.transportResetting) {
      scheduleSignalReconnect("signal-error");
    }
  }
};

const handleMediaSystem = async (sysMsg) => {
  const event = sysMsg.__sys;
  const message = sysMsg.message || "";
  log(`media sys: ${event}${message ? ` | ${message}` : ""}`, 0);
  logTrace("media sys", `event=${event}${message ? `, message=${message}` : ""}`);

  if (event === "listener_started") {
    state.mediaListening = true;
    if (state.role === "share" && state.signalListening) {
      updateStatus("监听中", "#f6c177");
    }
    return;
  }

  if (event === "listener_stopped") {
    state.mediaListening = false;
    state.mediaConnected = false;
    if (!state.transportResetting) {
      scheduleSignalReconnect("media-listener-stopped");
    }
    return;
  }

  if (event === "connected") {
    state.mediaConnected = true;
    state.reconnectAttempts = 0;
    clearReconnectTimer();

    if (state.signalConnected) {
      updateStatus("已连接", "#7ee787");
    }

    if (state.role === "share" && state.startRequested) {
      startCaptureLoop();
      sendSignal({ type: "start", role: "share", target: state.peerTargetId || undefined });
    }
    return;
  }

  if (event === "disconnected") {
    state.mediaConnected = false;
    if (!state.transportResetting && (state.role === "viewer" || !state.mediaListening)) {
      scheduleSignalReconnect("media-disconnected");
    }
    return;
  }

  if (event === "error") {
    if (!state.transportResetting) {
      scheduleSignalReconnect("media-error");
    }
  }
};

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

const pollMediaMessages = async () => {
  if (state.mediaPollBusy || !isTauri()) {
    return;
  }
  state.mediaPollBusy = true;

  try {
    const lines = await invoke("zt_media_poll");
    if (!Array.isArray(lines) || lines.length === 0) {
      return;
    }

    for (const line of lines) {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (error) {
        log(`媒体消息解析失败`, error, 0);
        continue;
      }

      if (msg && msg.__sys) {
        await handleMediaSystem(msg);
      } else if (msg?.type === "frame" && state.role === "viewer") {
        queueRemoteFrame(msg);
      }
    }
  } catch (error) {
    log("轮询媒体失败", error, 0);
  } finally {
    state.mediaPollBusy = false;
  }
};

const startSignalPump = () => {
  if (state.signalPumpTimer) {
    return;
  }
  state.signalPumpTimer = setInterval(() => {
    pollSignalMessages().catch((error) => log("signal pump error", error, 0));
  }, SIGNAL_POLL_INTERVAL_MS);
};

const startMediaPump = () => {
  if (state.mediaPumpTimer) {
    return;
  }
  state.mediaPumpTimer = setInterval(() => {
    pollMediaMessages().catch((error) => log("media pump error", error, 0));
  }, MEDIA_POLL_INTERVAL_MS);
};

const handleLibztOffline = async () => {
  clearOfflineTimer();
  state.libztOfflineTimer = setTimeout(async () => {
    if (state.libztNodeOnline) {
      return;
    }

    const hadSession =
      state.signalConnected ||
      state.mediaConnected ||
      state.signalListening ||
      state.mediaListening;
    state.libztNeedRestore = hadSession;
    logTrace("libzt offline debounced", `hadSession=${hadSession}`);

    if (hadSession && state.autoReconnectEnabled && !state.manualDisconnect) {
      // Keep existing transport running; libzt data plane may stay alive after NODE_OFFLINE.
      // We only mark restore intent and wait for explicit disconnect signals.
      updateStatus("ZeroTier 离线，保持现有通道", "#ffb4a2");
    }
  }, OFFLINE_DEBOUNCE_MS);
};

const handleLibztOnline = () => {
  const needRestore = state.libztNeedRestore;
  state.libztNodeOnline = true;
  const hasActiveSession =
    state.signalConnected ||
    state.mediaConnected ||
    state.signalListening ||
    state.mediaListening;
  if (needRestore && !hasActiveSession && !state.manualDisconnect && state.autoReconnectEnabled) {
    state.libztNeedRestore = false;
    scheduleSignalReconnect("libzt-online-restore");
  }
};

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
        // Keep libzt internals out of the live DOM log to avoid UI stalls.
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

const startLibztEventPump = () => {
  if (state.libztEventPumpTimer) {
    return;
  }
  state.libztEventPumpTimer = setInterval(() => {
    pollLibztEvents().catch((error) => log("libzt event pump error", error, 0));
  }, LIBZT_EVENT_POLL_INTERVAL_MS);
};

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

const waitForLibztReady = async (timeoutMs = LIBZT_READY_GRACE_MS) => {
  if (hasLibztReady()) {
    return true;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await pollLibztEvents();
    await syncLocalVirtualIp();
    if (hasLibztReady()) {
      return true;
    }
    await sleep(LIBZT_READY_POLL_MS);
  }

  return hasLibztReady();
};

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

  state.connecting = true;
  setButtonsBusy(true);
  let reconnectAfterFailure = false;
  state.transportResetting = true;

  try {
    clearReconnectTimer();

    if (!isReconnect) {
      state.manualDisconnect = false;
      state.autoReconnectEnabled = true;
    }

    state.role = ui.role_select.value;

    await closeTransports();
    updateStatus("启动 libzt...", "#f6c177");
    await ensureLibztStarted();
    const libztReady = await waitForLibztReady();

    const signalPort = getSignalPort();
    const mediaPort = getMediaPort();

    if (!libztReady) {
      throw new Error("ZeroTier 尚未就绪，稍后重试");
    }

    if (state.role === "share") {
      await Promise.all([
        invoke("zt_signal_listen", { port: signalPort }),
        invoke("zt_media_listen", { port: mediaPort }),
      ]);
      state.signalListening = true;
      state.mediaListening = true;
      state.signalConnected = false;
      state.mediaConnected = false;
      updateStatus("监听中", "#f6c177");
      log(`已监听：signal=${signalPort}, media=${mediaPort}`);
    } else {
      const peerIp = ui.peer_ip.value.trim();
      if (!peerIp) {
        throw new Error("观看端必须填写对方 IP");
      }

      await Promise.all([
        invoke("zt_signal_connect", { peerIp, port: signalPort }),
        invoke("zt_media_connect", { peerIp, port: mediaPort }),
      ]);
      state.signalConnected = true;
      state.mediaConnected = true;
      state.signalListening = false;
      state.mediaListening = false;
      updateStatus("已连接", "#7ee787");
      log(`已连接：${peerIp} signal=${signalPort}, media=${mediaPort}`);

      sendSignal({ type: "join", role: "viewer", ts: Date.now() });
      if (state.startRequested) {
        sendSignal({ type: "start", role: "viewer", ts: Date.now() });
      }
    }

    startSignalPump();
    startMediaPump();

    state.reconnectAttempts = 0;
    clearReconnectTimer();
    logTrace("connectChannels success", `isReconnect=${isReconnect}`);
  } catch (error) {
    await closeTransports();

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
    if (reconnectAfterFailure) {
      scheduleSignalReconnect(isReconnect ? "reconnect-attempt-failed" : "initial-connect-failed");
    }
  }
};

const startShareOrView = async () => {
  state.startRequested = true;
  state.role = ui.role_select.value;
  logTrace("startShareOrView", `role=${state.role}`);

  if (state.role === "viewer") {
    if (!state.signalConnected || !state.mediaConnected) {
      log("观看端请先建立 libzt 通道");
      return;
    }

    sendSignal({ type: "join", role: "viewer", target: state.peerTargetId || undefined });
    updateStatus("已连接，等待远端帧", "#7ee787");
    log("观看端已就绪，等待远端帧");
    return;
  }

  if (!state.signalListening || !state.mediaListening) {
    log("共享端请先建立 libzt 监听");
    return;
  }

  try {
    if (!state.session_id) {
      state.session_id = crypto.randomUUID();
    }

    await ensureShareStream();
    startCaptureLoop();

    const { profileKey, profile } = getSelectedProfile();
    log(
      `共享端已开始采集：JPEG ${profileKey}${getSelectedFps()}（目标 ${profile.maxBitrateKbps}kbps）`,
    );

    if (state.signalConnected) {
      sendSignal({ type: "join", role: "share", target: state.peerTargetId || undefined });
      sendSignal({ type: "start", role: "share", target: state.peerTargetId || undefined });
    }
  } catch (error) {
    log("无法获取屏幕共享权限", error);
  }
};

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

const openLogFolder = async () => {
  if (!isTauri()) {
    log("当前环境不支持打开日志目录");
    return;
  }

  await invoke("open_log_dir");
};

const disconnectAll = async () => {
  logTrace("disconnectAll begin");

  state.reconnectEpoch += 1;
  state.manualDisconnect = true;
  state.autoReconnectEnabled = false;
  state.transportResetting = true;
  clearReconnectTimer();
  clearOfflineTimer();

  stopLocalStream();
  resetRemoteCanvas();

  await closeTransports();
  await stopLibzt();

  state.startRequested = false;
  state.peerReady = false;
  state.peerTargetId = "";
  state.session_id = "";
  state.reconnectAttempts = 0;
  state.transportResetting = false;

  updateMergedVideoView();
  updateStatus("未连接", "#b1b1b1");
  logTrace("disconnectAll complete");
};

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

  if (ui.fps_select) {
    const defaultFps =
      Number(config.media?.video?.frameRate) > 0
        ? Number(config.media.video.frameRate)
        : DEFAULT_FPS;
    ui.fps_select.value = String(defaultFps);
  }

  ui.local_video.srcObject = null;
  resetRemoteCanvas();
  updateMergedVideoView();
  refreshMuteButton();
  updateRemoteStats("Bitrate: - kbps | FPS: -");
  startStatsMonitor();
};

ui.connect_btn.addEventListener("click", () => {
  connectChannels().catch((error) => log("建立 libzt 通道失败", error));
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
log("应用已就绪（纯 libzt 双通道模式）");
