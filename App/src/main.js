import { invoke } from "@tauri-apps/api/tauri";
import config from "../config.js";

//目前不知道干什么
const SIGNALING_PATH = "/ws";
const LOOKUP_PATH = "/lookup";

const state = {
  ws: null,
  pc: null,
  local_stream: null,
  role: "share",
  client_id: crypto.randomUUID(),
  signalingUrl: "",
  peerReady: false,
  peerTargetId: "",
};

//选择DOM
const qs = (selector) => document.querySelector(selector);
const ui = {
  host_ip: qs("#host_ip"),
  port: qs("#port"),
  network_input: qs("#network_input"),
  role_select: qs("#role_select"),
  peer_ip: qs("#peer_ip"),
  connect_btn: qs("#connect_btn"),
  start_btn: qs("#start_btn"),
  quickViewBtn: qs("#quickViewBtn"),
  open_log_btn: qs("#open_log_btn"),
  stop_btn: qs("#stop_btn"),
  status_point: qs("#status_point"),
  status_Text: qs("#status_Text"),
  local_video: qs("#local_video"),
  remote_video: qs("#remote_video"),
  log_list: qs("#log_list"),
};
//log
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
  switch (channel) {
    case 0: {
      //写入日志文件
      writeLogToFile(entry);
      break;
    }
    case 1: {
      //写入日志文件和前端
      const item = document.createElement("div");
      item.className = "log-item";
      item.textContent = entry;
      ui.log_list.prepend(item);
      writeLogToFile(entry);
      break;
    }
  }
};

const writeLogToFile = async (entry) => {
  if (!window.__TAURI__ || typeof invoke !== "function") {
    return;
  }
  try {
    await invoke("append_log", { message: entry });
  } catch (error) {
    // ignore log write failures
  }
};
//打开日志文件夹
const openLogFolder = async () => {
  if (!window.__TAURI__ || typeof invoke !== "function") {
    log("当前环境不支持打开日志文件夹");
    return;
  }
  try {
    await invoke("open_log_dir");
  } catch (error) {
    log("打开日志文件夹失败", error);
  }
};
//更新链接信令状态
const updateStatus = (text, color) => {
  ui.status_Text.textContent = text;
  ui.status_point.style.background = color;
  log(`状态更新：${text}`);
};
//获取信令服务器地址
const getSignalingUrl = () => {
  const host = ui.host_ip.value.trim();
  const port = ui.port.value.trim();
  const protocol = config.signaling.secure ? "wss" : "ws";
  log(`使用信令服务器 ${protocol}://${host}:${port}`, 0);
  return `${protocol}://${host}:${port}${SIGNALING_PATH}`;
};
//获取查询分享者的地址
const getLookupUrl = () => {
  const host = ui.host_ip.value.trim();
  const port = ui.port.value.trim();
  const protocol = config.signaling.secure ? "https" : "http";
  log(`查询地址到地址 ${protocol}://${host}:${port}`, 0);
  return `${protocol}://${host}:${port}${LOOKUP_PATH}`;
};
//发送信令消息
const sendSignal = (payload) => {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    log("无法发送信令消息，WebSocket 未连接");
    return;
  }
  state.ws.send(JSON.stringify({ ...payload, client_id: state.client_id }));
  log(`已发送信令消息：${payload.type}`);
};
//确保 PeerConnection 已创建
const ensurePeerConnection = () => {
  if (state.pc) {
    return state.pc;
  }

  const pc = new RTCPeerConnection({ iceServers: config.rtc.iceServers });
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignal({
        type: "ice",
        candidate: event.candidate,
        target: state.peerTargetId || undefined,
      });
    }
  };

  pc.ontrack = (event) => {
    const [stream] = event.streams;
    if (stream) {
      ui.remote_video.srcObject = stream;
      log("已接收到远端视频流");
    }
  };

  pc.onconnectionstatechange = () => {
    log(`连接状态：${pc.connectionState}`);
  };

  state.pc = pc;
  return pc;
};
//取消链接关闭 PeerConnection 和本地媒体流
const clearPeer = (resetSignalState = true) => {
  try {
    if (state.pc) {
      state.pc.close();
      state.pc = null;
    }
    if (state.local_stream) {
      state.local_stream.getTracks().forEach((track) => track.stop());
      state.local_stream = null;
    }
    ui.local_video.srcObject = null;
    ui.remote_video.srcObject = null;
    if (resetSignalState) {
      state.peerReady = false;
      state.peerTargetId = "";
    }
    log("已清除 PeerConnection 和本地媒体流");
  } catch (error) {
    log("清除 PeerConnection 时发生错误", error);
  }
};
//链接信令
const connectSignaling = () => {
  if (state.ws) {
    state.ws.close();
    state.ws = null;
  }

  state.signalingUrl = getSignalingUrl();
  state.role = ui.role_select.value;
  if (state.role === "share") {
    state.peerTargetId = "";
  }


  updateStatus("连接中", "#f6c177");
  log(`连接信令服务器：${state.signalingUrl}`);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(state.signalingUrl);
    state.ws = ws;
    let settled = false;

    ws.onopen = () => {
      updateStatus("已连接", "#7ee787");
      log(`send join role=${state.role} target=${state.peerTargetId || "-"}`);
      sendSignal({
        type: "join",
        role: state.role,
        target: state.peerTargetId || undefined,
      });
      log("已加入信令通道");
      settled = true;
      resolve();
    };

    ws.onclose = () => {
      updateStatus("已断开", "#ffb4a2");
      log("信令连接已关闭");
      if (!settled) {
        settled = true;
        reject(new Error("connection closed"));
      }
    };

    ws.onerror = () => {
      updateStatus("连接异常", "#ffb4a2");
      log("信令连接异常");
      if (!settled) {
        settled = true;
        reject(new Error("connection error"));
      }
    };

    ws.onmessage = async (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (error) {
        log("收到无法解析的消息", error);
        return;
      }
      log(
        `recv type=${msg.type || "?"} client_id=${msg.client_id || "?"} role=${msg.role || "?"}`,
      );

      if (msg.client_id === state.client_id) {
        return;
      }

      if (msg.type === "join") {
        if (state.role === "share" && msg.role === "viewer") {
          state.peerReady = true;
          state.peerTargetId = msg.client_id || state.peerTargetId;
          log("Viewer joined");
          await makeOffer(msg.client_id);
        }
        if (state.role === "viewer" && msg.role === "share") {
          if (!state.peerTargetId && msg.client_id) {
            state.peerTargetId = msg.client_id;
          }
          log("Sharer online");
          if (state.peerTargetId) {
            sendSignal({
              type: "join",
              role: state.role,
              target: state.peerTargetId,
            });
            log(`viewer join re-announce target=${state.peerTargetId}`);
          }
        }
        return;
      }

      if (msg.type === "offer" && state.role === "viewer") {
        const pc = ensurePeerConnection();
        if (!state.peerTargetId && msg.client_id) {
          state.peerTargetId = msg.client_id;
        }
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal({
          type: "answer",
          sdp: pc.localDescription,
          target: state.peerTargetId || undefined,
        });
        log("已发送 Answer");
        return;
      }

      if (msg.type === "answer" && state.role === "share") {
        const pc = ensurePeerConnection();
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        log("已收到 Answer");
        return;
      }

      if (msg.type === "ice") {
        const pc = ensurePeerConnection();
        try {
          await pc.addIceCandidate(msg.candidate);
        } catch (error) {
          log("ICE 添加失败", error);
        }
      }
    };
  });
};
//根据 IP 查询分享者信息
const lookupShareByIp = async (ip) => {
  const url = `${getLookupUrl()}?ip=${encodeURIComponent(ip)}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      log("查询分享者失败");
      return null;
    }
    const data = await resp.json();
    if (!data.found) {
      log("未找到该 IP 对应的分享者");
      return null;
    }
    log(`Found sharer (client_id: ${data.client_id})`);
    log(`data: ${JSON.stringify(data)}`, 0);
    return data;
  } catch (error) {
    log("查询分享者异常", error);
    return null;
  }
};
//发起 Offer
const makeOffer = async (targetId) => {
  if (state.role !== "share") {
    return;
  }
  const pc = ensurePeerConnection();

  if (!state.local_stream) {
    log("请先开始屏幕共享");
    return;
  }

  if (targetId) {
    state.peerTargetId = targetId;
  }

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendSignal({
    type: "offer",
    sdp: pc.localDescription,
    target: state.peerTargetId || undefined,
  });
  log("已发送 Offer");
};
//开始共享或观看
const startShareOrView = async () => {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    log("请先连接信令服务器");
    return;
  }

  state.role = ui.role_select.value;
  clearPeer(false);

  const pc = ensurePeerConnection();

  if (state.role === "share") {
    try {
      state.local_stream = await navigator.mediaDevices.getDisplayMedia({
        video: config.media.video,
        audio: config.media.audio,
      });
      state.local_stream
        .getTracks()
        .forEach((track) => pc.addTrack(track, state.local_stream));
      ui.local_video.srcObject = state.local_stream;
      log("已开始屏幕共享，等待观看者进入");
      if (state.peerReady && state.peerTargetId) {
        await makeOffer(state.peerTargetId);
      }
    } catch (error) {
      log("无法获取屏幕共享权限", error);
    }
  } else {
    log("等待分享者发送 Offer");
  }
};
//输入 IP 快速观看
const quickViewByIp = async () => {
  const ip = ui.peer_ip.value.trim();
  if (!ip) {
    log("请填写对方 IP");
    return;
  }

  ui.role_select.value = "viewer";
  const data = await lookupShareByIp(ip);
  if (!data || !data.client_id) {
    return;
  }

  state.peerTargetId = data.client_id;

  try {
    await connectSignaling();
  } catch (error) {
    return;
  }

  await startShareOrView();
};
//断开连接
const disconnectAll = () => {
  if (state.ws) {
    sendSignal({ type: "leave", target: state.peerTargetId || undefined });
    state.ws.close();
    state.ws = null;
  }
  clearPeer();
};
//初始化表单
const initForm = () => {
  ui.host_ip.value = config.signaling.defaultHost;
  ui.port.value = String(config.signaling.defaultPort);
  ui.network_input.value = config.user.defaultNetwork;
  ui.role_select.value = config.user.defaultRole;
  ui.peer_ip.value = "";
};

ui.connect_btn.addEventListener("click", () => {
  connectSignaling().catch(() => {});
});
ui.start_btn.addEventListener("click", startShareOrView);
ui.quickViewBtn.addEventListener("click", quickViewByIp);
ui.open_log_btn.addEventListener("click", openLogFolder);
ui.stop_btn.addEventListener("click", disconnectAll);

initForm();
updateStatus("未连接", "#b1b1b1");
log("应用已就绪");
