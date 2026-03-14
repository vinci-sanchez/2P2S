import { invoke } from "@tauri-apps/api/tauri";
import { SHARE_PROFILES, PACKET_MAX_BYTES, PACKET_HEADER_BYTES, PACKET_PAYLOAD_BYTES, PACING_MIN_MS, PACING_MAX_MS, JITTER_MIN_MS, JITTER_MAX_MS, RX_DEADLINE_SAFETY_MS, RX_DEADLINE_BONUS_PER_PKT_MS, RX_DEADLINE_MAX_BONUS_MS, RX_TARGET_DELAY_FLOOR_MS, RX_TARGET_DELAY_BAD_LINK_FLOOR_MS, RX_TARGET_DELAY_DROP_PENALTY_MS, RX_TARGET_DELAY_MISSING_PKT_PENALTY_MS, RX_TARGET_DELAY_NACK_ROUND_PENALTY_MS, RX_NEED_KEYFRAME_DROP_THRESHOLD, RX_NEED_KEYFRAME_DROP_WINDOW_MS, RX_SEQ_REORDER_GAP_THRESHOLD, RX_SEQ_REORDER_HOLD_MS, RX_SEQ_REORDER_MAX_PENDING, RX_REORDER_ADAPTIVE_MAX_GAP, RX_REORDER_ADAPTIVE_MAX_HOLD_MS, DELTA_NACK_MAX_PER_FRAME, DELTA_NACK_MAX_MISSING, DELTA_NACK_MAX_ROUNDS, DELTA_NACK_REMAIN_GUARD_MS, RX_REPAIR_SLACK_MS, RX_REPAIR_SLACK_KEYFRAME_MS, RX_REPAIR_SLACK_BAD_LINK_MS, RX_REPAIR_SLACK_BAD_LINK_KEYFRAME_MS, NACK_GAP_IMMEDIATE_RUN_THRESHOLD, NACK_GAP_DELAY_STRONG_MS, NACK_GAP_DELAY_WEAK_MS, NACK_FLUSH_BATCH_MS, NACK_RETRY_MIN_INTERVAL_MS, NACK_UNKNOWN_RTT_MS, NACK_KEYFRAME_MAX_MISSING, NACK_KEYFRAME_MAX_ROUNDS, RX_GLOBAL_NACK_PACKET_BUDGET, RX_GLOBAL_NACK_FRAME_BUDGET, RX_GLOBAL_NACK_BAD_LINK_PACKET_BUDGET, RX_GLOBAL_NACK_BAD_LINK_FRAME_BUDGET, FEC_MIN_RATE, FEC_MAX_RATE, FEC_HYSTERESIS_UP_STEP, FEC_HYSTERESIS_DOWN_STEP, FEC_HYSTERESIS_HOLD_MS, RELAY_PROFILE_KEY, RELAY_MAX_FPS, RELAY_FEC_FLOOR, RELAY_BITRATE_CAP_BPS, BAD_LINK_PROFILE_KEY, BAD_LINK_MAX_FPS, BAD_LINK_FEC_FLOOR, BAD_LINK_BITRATE_CAP_BPS, BAD_LINK_HOLD_MS, BAD_LINK_WARMUP_MS, BAD_LINK_SIGNAL_INTERVAL_MS, BAD_LINK_EXTRA_REORDER_GAP, BAD_LINK_EXTRA_REORDER_HOLD_MS, BAD_LINK_EXTRA_DEADLINE_MS, BAD_LINK_EXTRA_TARGET_DELAY_MS, BAD_LINK_TRIGGER_OUT_OF_ORDER_RATE, BAD_LINK_TRIGGER_MIN_REORDER_PKTS, BAD_LINK_TRIGGER_LATE_PKTS_PER_SEC, BAD_LINK_TRIGGER_DROP_FRAMES_PER_SEC, BAD_LINK_TRIGGER_DROP_FRAME_RATIO, BAD_LINK_TRIGGER_MIN_FRAME_OUTCOMES, BAD_LINK_TRIGGER_MISSING_PKTS_PER_SEC, BAD_LINK_TRIGGER_MISSING_PKT_RATIO, BAD_LINK_TRIGGER_MIN_RX_DATA_PKTS, BAD_LINK_TRIGGER_NACK_SKIP_ROUNDS_PER_SEC, BAD_LINK_TRIGGER_NACK_SKIP_ROUND_FRAME_RATIO, BAD_LINK_TRIGGER_MIN_NACK_FRAMES, BAD_LINK_TRIGGER_CONSECUTIVE_HITS, BAD_LINK_TRIGGER_IMMEDIATE_DROP_FRAMES_PER_SEC, BAD_LINK_TRIGGER_IMMEDIATE_NACK_SKIP_ROUNDS_PER_SEC, UNKNOWN_PROFILE_KEY, UNKNOWN_MAX_FPS, UNKNOWN_FEC_FLOOR, LINK_POLICY_DIRECT_STABLE_MS, LINK_POLICY_SWITCH_COOLDOWN_MS, PROFILE_UPGRADE_TARGET_RATIO, TRACK_PROCESSOR_FAILURE_THRESHOLD, ENCODER_RECONFIGURE_COOLDOWN_MS, ENCODER_BITRATE_BUCKET_STEP_BPS, KEYFRAME_CACHE_KEEP_MS, DELTA_CACHE_KEEP_MS, RETRANS_CACHE_MAX_ITEMS, MIN_RTT_WINDOW_MS, PKT_KIND_DATA, PKT_KIND_FEEDBACK_REQ, PKT_KIND_FEEDBACK, PKT_KIND_NACK, PKT_KIND_PLI, FLAG_KEYFRAME, FLAG_FEC, FLAG_RETRANS, FLAG_CODEC_VP8, KEYFRAME_INTERVAL_MS, PLI_TIMEOUT_MS, PLI_MIN_INTERVAL_MS, MIN_KEYFRAME_GAP_MS, RX_SMALL_GAP_GRACE_MS, RX_FRAME_HARD_DEADLINE_DELTA_MS, RX_FRAME_HARD_DEADLINE_KEYFRAME_MS, RX_FRAME_HARD_DEADLINE_BAD_LINK_DELTA_MS, RX_FRAME_HARD_DEADLINE_BAD_LINK_KEYFRAME_MS, FPS_COOLDOWN_MS, FPS_LEVELS, CC_INTERVAL_MS } from "./constants.js";
import { state } from "./state.js";
import { ui } from "./ui.js";
import { log, update_status, update_merged_video_view } from "./logger.js";

// 处理 clamp 相关逻辑。
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// 处理 ewma 相关逻辑。
function ewma(prev, next, alpha) {
  return prev + alpha * (next - prev);
}
const CC_PROBE_TIMEOUT_MS = Math.max(CC_INTERVAL_MS * 4, 1000);
const VIDEO_CODEC_H264 = "h264";
const VIDEO_CODEC_VP8 = "vp8";
const DIRECT_MAX_FPS = 30;
const MOTION_SAMPLE_WIDTH = 32;
const MOTION_SAMPLE_HEIGHT = 18;
const MOTION_STATIC_THRESHOLD = 0.45;
const MOTION_LOW_THRESHOLD = 2.4;
const MOTION_STATIC_FPS = DIRECT_MAX_FPS;
const MOTION_LOW_MIN_FPS = DIRECT_MAX_FPS;
const MOTION_LOW_INTERVAL_SCALE = 1;

// 写入Metric Ts。
function push_metric_ts(arr, now, window_ms) {
  arr.push(now);
  const deadline = now - window_ms;
  while (arr.length > 0 && arr[0] < deadline) {
    arr.shift();
  }
}

// 创建媒体处理模块。
function create_media_module({
  send_media_batch,
  get_selected_profile
}) {
  const pending_nacks = new Map();
  let nack_flush_timer = null;

  // 处理 xor Into 相关逻辑。
  function xor_into(target, source) {
    const len = Math.min(target.length, source.length);
    for (let i = 0; i < len; i += 1) {
      target[i] ^= source[i];
    }
  }

  // 生成Prng。
  function make_prng(seed) {
    let s = seed >>> 0 || 0x1a2b3c4d;
    return () => {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return s >>> 0;
    };
  }

  // Deterministic sparse coding row (RS/RaptorQ-like linear erasure coding over GF(2)).
  function make_fec_row_indices(frame_id, parity_index, data_count) {
    if (data_count <= 1) {
      return [0];
    }
    const seed = (frame_id >>> 0 ^ (parity_index + 1) * 0x9e3779b1 >>> 0) >>> 0;
    const rnd = make_prng(seed);
    const min_degree = Math.min(2, data_count);
    const max_degree = Math.min(8, data_count);
    const degree = min_degree + rnd() % (max_degree - min_degree + 1);
    const picks = new Set([parity_index % data_count]);
    while (picks.size < degree) {
      picks.add(rnd() % data_count);
    }
    return Array.from(picks).sort((a, b) => a - b);
  }

  // 构建Packet。
  function build_packet({
    kind,
    flags = 0,
    seq,
    frameId: frame_id = 0,
    packetId: packet_id = 0,
    packetCount: packet_count = 0,
    timestampMs: timestamp_ms,
    payload,
    aux = 0,
    aux2 = 0
  }) {
    const payload_bytes = payload || new Uint8Array(0);
    const buffer = new Uint8Array(PACKET_HEADER_BYTES + payload_bytes.length);
    const view = new DataView(buffer.buffer);
    view.setUint8(0, kind);
    view.setUint8(1, flags);
    view.setUint16(2, PACKET_HEADER_BYTES, true);
    view.setUint32(4, seq >>> 0, true);
    view.setUint32(8, frame_id >>> 0, true);
    view.setUint16(12, packet_id >>> 0, true);
    view.setUint16(14, packet_count >>> 0, true);
    view.setUint32(16, timestamp_ms >>> 0, true);
    view.setUint16(20, payload_bytes.length >>> 0, true);
    view.setUint16(22, 0, true);
    view.setUint32(24, aux >>> 0, true);
    view.setUint32(28, aux2 >>> 0, true);
    if (payload_bytes.length > 0) {
      buffer.set(payload_bytes, PACKET_HEADER_BYTES);
    }
    return buffer;
  }

  // 构建Cc Probe Payload。
  function build_cc_probe_payload(probe_id) {
    const payload = new Uint8Array(4);
    new DataView(payload.buffer).setUint32(0, probe_id >>> 0, true);
    return payload;
  }

  // 解析Cc Probe Id。
  function parse_cc_probe_id(payload) {
    if (!(payload instanceof Uint8Array) || payload.length < 4) {
      return null;
    }
    return new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, true);
  }

  // 构建Feedback Payload。
  function build_feedback_payload(burst_level, probe_id) {
    const payload = new Uint8Array(6);
    const view = new DataView(payload.buffer);
    view.setUint16(0, burst_level & 0xffff, true);
    view.setUint32(2, probe_id >>> 0, true);
    return payload;
  }

  // 解析Feedback Payload。
  function parse_feedback_payload(payload) {
    if (!(payload instanceof Uint8Array) || payload.length < 6) {
      return {
        burstLevel: 0,
        probeId: null
      };
    }
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    return {
      burstLevel: view.getUint16(0, true),
      probeId: view.getUint32(2, true)
    };
  }

  // 获取Current Out Of Order Rate。
  function get_current_out_of_order_rate() {
    return state.rx_data_pkts_sec > 0 ? state.rx_out_of_order_pkts_sec / state.rx_data_pkts_sec : 0;
  }

  // 发送Bad Link Signal。
  function send_bad_link_signal(active, reason = "", force = false) {
    if (!state.signal_connected) {
      return;
    }
    const next_state = active ? "on" : "off";
    if (!force && state.bad_link_signal_state === next_state) {
      return;
    }
    state.bad_link_signal_state = next_state;
    invoke("zt_signal_send", {
      payload: JSON.stringify({
        type: active ? "bad-link" : "bad-link-clear",
        role: state.role,
        target: state.peer_target_id || undefined,
        reason: reason || undefined,
        ts: Date.now(),
        client_id: state.client_id,
        session_id: state.session_id || undefined
      })
    }).catch(error => log(`send ${active ? "bad-link" : "bad-link-clear"} failed`, error, 0));
  }

  // 停止Bad Link Signal Heartbeat。
  function stop_bad_link_signal_heartbeat() {
    if (state.bad_link_signal_timer) {
      clearInterval(state.bad_link_signal_timer);
      state.bad_link_signal_timer = null;
    }
  }

  // 确保Bad Link Signal Heartbeat。
  function ensure_bad_link_signal_heartbeat() {
    if (state.bad_link_signal_timer || state.role !== "viewer") {
      return;
    }
    state.bad_link_signal_timer = setInterval(() => {
      if (!state.bad_link_mode || !state.start_requested || state.role !== "viewer") {
        stop_bad_link_signal_heartbeat();
        return;
      }
      send_bad_link_signal(true, state.bad_link_last_reason || "heartbeat", true);
    }, BAD_LINK_SIGNAL_INTERVAL_MS);
  }

  // 设置Bad Link Mode。
  function set_bad_link_mode(active, reason = "", source = "local") {
    const now = Date.now();
    const was_active = state.bad_link_mode;
    if (active) {
      state.bad_link_mode = true;
      state.bad_link_until = Math.max(state.bad_link_until || 0, now + BAD_LINK_HOLD_MS);
      state.bad_link_last_trigger_at = now;
      if (!was_active) {
        log(`bad link mode enabled | source=${source} reason=${reason}`, 0);
        if (source === "viewer") {
          send_bad_link_signal(true, reason);
        }
      }
      if (source === "viewer") {
        ensure_bad_link_signal_heartbeat();
      }
      state.bad_link_last_reason = reason || state.bad_link_last_reason;
      return;
    }
    if (!state.bad_link_mode || now < state.bad_link_until) {
      return;
    }
    state.bad_link_mode = false;
    state.bad_link_until = 0;
    if (was_active) {
      log(`bad link mode cleared | source=${source}`, 0);
      if (source === "viewer") {
        stop_bad_link_signal_heartbeat();
        send_bad_link_signal(false);
      }
    }
    state.bad_link_last_reason = "";
  }

  // 处理 evaluate Bad Link Mode 相关逻辑。
  function evaluate_bad_link_mode(now) {
    if (state.role !== "viewer" || !state.start_requested) {
      state.bad_link_trigger_streak = 0;
      state.bad_link_trigger_reason = "";
      set_bad_link_mode(false, "", "viewer");
      return;
    }
    if (!state.bad_link_mode) {
      if (state.rx_first_media_packet_at <= 0) {
        state.bad_link_trigger_streak = 0;
        state.bad_link_trigger_reason = "";
        return;
      }
      if (now - state.rx_first_media_packet_at < BAD_LINK_WARMUP_MS) {
        state.bad_link_trigger_streak = 0;
        state.bad_link_trigger_reason = "";
        return;
      }
    }
    const out_of_order_rate = get_current_out_of_order_rate();
    const total_frame_outcomes = state.rx_frames_completed_sec + state.rx_drop_deadline_sec;
    const total_nack_frames = state.rx_nack_active_frames_sec;
    const has_reorder_sample = state.rx_data_pkts_sec >= BAD_LINK_TRIGGER_MIN_REORDER_PKTS;
    const has_drop_sample = total_frame_outcomes >= BAD_LINK_TRIGGER_MIN_FRAME_OUTCOMES;
    const has_missing_sample = state.rx_data_pkts_sec >= BAD_LINK_TRIGGER_MIN_RX_DATA_PKTS;
    const has_nack_sample = total_nack_frames >= BAD_LINK_TRIGGER_MIN_NACK_FRAMES;
    const drop_frame_ratio = total_frame_outcomes > 0 ? state.rx_drop_deadline_sec / total_frame_outcomes : 0;
    const missing_pkt_ratio = state.rx_data_pkts_sec > 0 ? state.rx_missing_on_deadline_pkts_sec / state.rx_data_pkts_sec : 0;
    const nack_round_frame_ratio = total_nack_frames > 0 ? state.rx_nack_skipped_rounds_sec / total_nack_frames : 0;
    const reasons = [];
    let immediate_trigger = false;
    if (has_reorder_sample && out_of_order_rate >= BAD_LINK_TRIGGER_OUT_OF_ORDER_RATE) {
      reasons.push(`reorder=${(out_of_order_rate * 100).toFixed(1)}%`);
    }
    if (state.rx_late_after_deadline_pkts_sec >= BAD_LINK_TRIGGER_LATE_PKTS_PER_SEC) {
      reasons.push(`late=${state.rx_late_after_deadline_pkts_sec}`);
    }
    if (state.rx_drop_deadline_sec >= BAD_LINK_TRIGGER_DROP_FRAMES_PER_SEC && has_drop_sample && drop_frame_ratio >= BAD_LINK_TRIGGER_DROP_FRAME_RATIO) {
      reasons.push(`drop=${state.rx_drop_deadline_sec}/${total_frame_outcomes}(${(drop_frame_ratio * 100).toFixed(0)}%)`);
      if (state.rx_drop_deadline_sec >= BAD_LINK_TRIGGER_IMMEDIATE_DROP_FRAMES_PER_SEC) {
        immediate_trigger = true;
      }
    }
    if (state.rx_missing_on_deadline_pkts_sec >= BAD_LINK_TRIGGER_MISSING_PKTS_PER_SEC && has_missing_sample && missing_pkt_ratio >= BAD_LINK_TRIGGER_MISSING_PKT_RATIO) {
      reasons.push(`missing=${state.rx_missing_on_deadline_pkts_sec}/${state.rx_data_pkts_sec}(${(missing_pkt_ratio * 100).toFixed(0)}%)`);
    }
    if (state.rx_nack_skipped_rounds_sec >= BAD_LINK_TRIGGER_NACK_SKIP_ROUNDS_PER_SEC && has_nack_sample && nack_round_frame_ratio >= BAD_LINK_TRIGGER_NACK_SKIP_ROUND_FRAME_RATIO) {
      reasons.push(`nack_round_frames=${state.rx_nack_skipped_rounds_sec}/${total_nack_frames}(${(nack_round_frame_ratio * 100).toFixed(0)}%)`);
      if (state.rx_nack_skipped_rounds_sec >= BAD_LINK_TRIGGER_IMMEDIATE_NACK_SKIP_ROUNDS_PER_SEC) {
        immediate_trigger = true;
      }
    }
    if (reasons.length > 0) {
      const reason = reasons.join(",");
      if (state.bad_link_trigger_reason === reason) {
        state.bad_link_trigger_streak += 1;
      } else {
        state.bad_link_trigger_reason = reason;
        state.bad_link_trigger_streak = 1;
      }
      if (immediate_trigger || state.bad_link_trigger_streak >= BAD_LINK_TRIGGER_CONSECUTIVE_HITS) {
        set_bad_link_mode(true, reason, "viewer");
      }
      return;
    }
    state.bad_link_trigger_streak = 0;
    state.bad_link_trigger_reason = "";
    if (now >= state.bad_link_until) {
      set_bad_link_mode(false, "", "viewer");
    }
  }

  // 获取Adaptive Reorder Gap Threshold。
  function get_adaptive_reorder_gap_threshold() {
    const out_of_order_rate = get_current_out_of_order_rate();
    if (state.bad_link_mode) {
      return Math.min(RX_REORDER_ADAPTIVE_MAX_GAP, RX_SEQ_REORDER_GAP_THRESHOLD + BAD_LINK_EXTRA_REORDER_GAP);
    }
    if (out_of_order_rate >= 0.12) {
      return RX_REORDER_ADAPTIVE_MAX_GAP;
    }
    if (out_of_order_rate >= 0.08) {
      return Math.min(RX_REORDER_ADAPTIVE_MAX_GAP, RX_SEQ_REORDER_GAP_THRESHOLD + 16);
    }
    if (out_of_order_rate >= 0.04) {
      return Math.min(RX_REORDER_ADAPTIVE_MAX_GAP, RX_SEQ_REORDER_GAP_THRESHOLD + 8);
    }
    return RX_SEQ_REORDER_GAP_THRESHOLD;
  }

  // 获取Adaptive Reorder Hold Ms。
  function get_adaptive_reorder_hold_ms() {
    const out_of_order_rate = get_current_out_of_order_rate();
    if (state.bad_link_mode) {
      return Math.min(RX_REORDER_ADAPTIVE_MAX_HOLD_MS, RX_SEQ_REORDER_HOLD_MS + BAD_LINK_EXTRA_REORDER_HOLD_MS);
    }
    if (out_of_order_rate >= 0.12) {
      return RX_REORDER_ADAPTIVE_MAX_HOLD_MS;
    }
    if (out_of_order_rate >= 0.08) {
      return Math.min(RX_REORDER_ADAPTIVE_MAX_HOLD_MS, RX_SEQ_REORDER_HOLD_MS + 18);
    }
    if (out_of_order_rate >= 0.04) {
      return Math.min(RX_REORDER_ADAPTIVE_MAX_HOLD_MS, RX_SEQ_REORDER_HOLD_MS + 10);
    }
    return RX_SEQ_REORDER_HOLD_MS;
  }

  // 获取Codec Flag。
  function get_codec_flag(codec_key) {
    return codec_key === VIDEO_CODEC_VP8 ? FLAG_CODEC_VP8 : 0;
  }

  // 解析Codec Key From Flags。
  function parse_codec_key_from_flags(flags) {
    return flags & FLAG_CODEC_VP8 ? VIDEO_CODEC_VP8 : VIDEO_CODEC_H264;
  }
  const profile_order = ["360p", "480p", "720p", "1080p"];

  // 获取Profile Order Index。
  function get_profile_order_index(profile_key) {
    const index = profile_order.indexOf(profile_key);
    return index >= 0 ? index : profile_order.indexOf(UNKNOWN_PROFILE_KEY);
  }

  // 处理 cap Profile Key 相关逻辑。
  function cap_profile_key(selected_key, cap_key) {
    if (!cap_key) {
      return selected_key;
    }
    return get_profile_order_index(selected_key) <= get_profile_order_index(cap_key) ? selected_key : cap_key;
  }

  // 获取Lower Profile Key。
  function get_lower_profile_key(left_key, right_key) {
    if (!left_key) {
      return right_key;
    }
    if (!right_key) {
      return left_key;
    }
    return get_profile_order_index(left_key) <= get_profile_order_index(right_key) ? left_key : right_key;
  }

  // 获取Bitrate Eligible Profile Key。
  function get_bitrate_eligible_profile_key(selected_key) {
    const fallback_bitrate_bps = SHARE_PROFILES[selected_key]?.maxBitrateKbps * 1000 || 2_000_000;
    const current_budget_bps = Math.max(300_000, Math.floor(state.cc.vbvTargetBps || fallback_bitrate_bps));
    const selected_index = get_profile_order_index(selected_key);
    let eligible_key = profile_order[0];
    for (const profile_key of profile_order) {
      if (get_profile_order_index(profile_key) > selected_index) {
        break;
      }
      const required_bps = SHARE_PROFILES[profile_key].maxBitrateKbps * 1000 * PROFILE_UPGRADE_TARGET_RATIO;
      if (current_budget_bps >= required_bps) {
        eligible_key = profile_key;
      }
    }
    return eligible_key;
  }

  // 获取Route Policy。
  function get_route_policy() {
    if (state.bad_link_mode) {
      return {
        profileCapKey: BAD_LINK_PROFILE_KEY,
        maxFps: BAD_LINK_MAX_FPS,
        fecFloor: BAD_LINK_FEC_FLOOR,
        bitrateCapBps: BAD_LINK_BITRATE_CAP_BPS
      };
    }
    const route = state.libzt_route_status;
    if (route === "RELAY") {
      return {
        profileCapKey: RELAY_PROFILE_KEY,
        maxFps: RELAY_MAX_FPS,
        fecFloor: RELAY_FEC_FLOOR,
        bitrateCapBps: RELAY_BITRATE_CAP_BPS
      };
    }
    if (route === "UNKNOWN" || route === "UNREACHABLE" || route === "OFFLINE") {
      return {
        profileCapKey: UNKNOWN_PROFILE_KEY,
        maxFps: UNKNOWN_MAX_FPS,
        fecFloor: UNKNOWN_FEC_FLOOR,
        bitrateCapBps: SHARE_PROFILES[UNKNOWN_PROFILE_KEY].maxBitrateKbps * 1000
      };
    }
    return {
      profileCapKey: null,
      maxFps: DIRECT_MAX_FPS,
      fecFloor: FEC_MIN_RATE,
      bitrateCapBps: null
    };
  }

  // 处理 resolve Share Policy 相关逻辑。
  function resolve_share_policy() {
    const now = Date.now();
    const {
      profile_key: selected_key,
      profile: selected_profile
    } = get_selected_profile();
    const route = state.libzt_route_status;
    const route_policy = get_route_policy();
    const current_key = state.cc.activeProfileKey || selected_key;
    const bitrate_cap_key = get_bitrate_eligible_profile_key(selected_key);
    const effective_cap_key = get_lower_profile_key(route_policy.profileCapKey, bitrate_cap_key);
    let desired_key = selected_key;
    if (effective_cap_key) {
      desired_key = cap_profile_key(selected_key, effective_cap_key);
    } else if (route === "DIRECT" && current_key && get_profile_order_index(current_key) < get_profile_order_index(selected_key) && now - (state.libzt_route_changed_at || 0) < LINK_POLICY_DIRECT_STABLE_MS) {
      desired_key = current_key;
    }
    let applied_key = desired_key;
    const desired_is_upgrade = get_profile_order_index(desired_key) > get_profile_order_index(current_key);
    if (desired_is_upgrade && current_key && now - state.cc.lastPolicySwitchAt < LINK_POLICY_SWITCH_COOLDOWN_MS) {
      applied_key = current_key;
    }
    const profile = SHARE_PROFILES[applied_key] || selected_profile;
    const stable_gate_active = route === "DIRECT" && current_key && get_profile_order_index(current_key) < get_profile_order_index(selected_key) && now - (state.libzt_route_changed_at || 0) < LINK_POLICY_DIRECT_STABLE_MS;
    const cooldown_gate_active = desired_is_upgrade && current_key && now - state.cc.lastPolicySwitchAt < LINK_POLICY_SWITCH_COOLDOWN_MS;
    const reason_parts = [`selected=${selected_key}`, `current=${current_key || "-"}`, `route=${route}`, `bad_link=${state.bad_link_mode ? "on" : "off"}`, `route_cap=${route_policy.profileCapKey || "-"}`, `bitrate_cap=${bitrate_cap_key || "-"}`, `effective_cap=${effective_cap_key || "-"}`, `desired=${desired_key}`, `applied=${applied_key}`, `stable_gate=${stable_gate_active ? "on" : "off"}`, `cooldown_gate=${cooldown_gate_active ? "on" : "off"}`, `bitrate_cap_kbps=${Math.round((route_policy.bitrateCapBps ?? profile.maxBitrateKbps * 1000) / 1000)}`, `vbv_kbps=${Math.round((state.cc.vbvTargetBps || 0) / 1000)}`];
    return {
      profileKey: applied_key,
      profile,
      maxFps: Math.min(route_policy.maxFps, FPS_LEVELS[FPS_LEVELS.length - 1]),
      fecFloor: Math.max(FEC_MIN_RATE, route_policy.fecFloor),
      bitrateCapBps: Math.min(profile.maxBitrateKbps * 1000, route_policy.bitrateCapBps ?? Number.MAX_SAFE_INTEGER),
      changed: applied_key !== state.cc.activeProfileKey,
      selectedKey: selected_key,
      desiredKey: desired_key,
      reason: reason_parts.join(" ")
    };
  }

  // 同步Send Policy。
  function sync_send_policy() {
    const policy = resolve_share_policy();
    const now = Date.now();
    const prev_profile_key = state.cc.activeProfileKey || "-";
    if (policy.changed) {
      state.cc.activeProfileKey = policy.profileKey;
      state.cc.lastPolicySwitchAt = now;
      state.force_next_keyframe = true;
    } else if (!state.cc.activeProfileKey) {
      state.cc.activeProfileKey = policy.profileKey;
    }
    const policy_fec_ceil = state.bad_link_mode ? Math.max(policy.fecFloor, FEC_MAX_RATE) : Math.max(policy.fecFloor, FEC_MIN_RATE + 0.08);
    state.cc.currentFecRate = clamp(state.cc.currentFecRate, policy.fecFloor, policy_fec_ceil);
    state.cc.currentFps = Math.min(state.cc.currentFps, policy.maxFps);
    const policy_log_key = `${policy.selectedKey}|${prev_profile_key}|${policy.profileKey}|${policy.desiredKey}|` + `${state.libzt_route_status}|${Math.round(policy.bitrateCapBps / 1000)}|` + `${policy.maxFps}|${Math.round(policy.fecFloor * 100)}|${state.active_video_codec_key || "-"}`;
    if (policy.changed || state.cc.lastPolicyLogKey !== policy_log_key) {
      log(`send policy ${policy.changed ? "changed" : "evaluated"} | from=${prev_profile_key} to=${policy.profileKey} ` + `selected=${policy.selectedKey} desired=${policy.desiredKey} max_fps=${policy.maxFps} ` + `fec_floor=${Math.round(policy.fecFloor * 100)}% bitrate_cap_kbps=${Math.round(policy.bitrateCapBps / 1000)} ` + `codec=${(state.active_video_codec_key || "-").toUpperCase()} ${policy.reason}`, 0);
      state.cc.lastPolicyLogKey = policy_log_key;
    }
    return policy;
  }

  // 获取Active Send Policy。
  function get_active_send_policy() {
    return sync_send_policy();
  }

  // 处理 refill Vbv Tokens 相关逻辑。
  function refill_vbv_tokens(now = Date.now()) {
    if (!state.cc.vbvLastRefillAt) {
      state.cc.vbvLastRefillAt = now;
      state.cc.vbvTokensBits = clamp(state.cc.vbvTokensBits || state.cc.vbvBucketCapacityBits, state.cc.vbvDebtFloorBits, state.cc.vbvBucketCapacityBits);
      return;
    }
    const elapsed_ms = Math.max(0, now - state.cc.vbvLastRefillAt);
    state.cc.vbvLastRefillAt = now;
    if (elapsed_ms <= 0) {
      return;
    }
    const refill_bits = state.cc.vbvTargetBps * elapsed_ms / 1000;
    state.cc.vbvTokensBits = clamp(state.cc.vbvTokensBits + refill_bits, state.cc.vbvDebtFloorBits, state.cc.vbvBucketCapacityBits);
  }

  // 获取Vbv Health Factor。
  function get_vbv_health_factor({
    queueDelayMs: queue_delay_ms,
    lossPermille: loss_permille,
    jitterMs: jitter_ms,
    burstLevel: burst_level
  }) {
    let factor = 1;
    if (queue_delay_ms >= 140) {
      factor *= 0.68;
    } else if (queue_delay_ms >= 100) {
      factor *= 0.76;
    } else if (queue_delay_ms >= 60) {
      factor *= 0.84;
    } else if (queue_delay_ms >= 30) {
      factor *= 0.92;
    }
    if (loss_permille >= 120) {
      factor *= 0.82;
    } else if (loss_permille >= 80) {
      factor *= 0.9;
    } else if (loss_permille >= 40) {
      factor *= 0.96;
    }
    if (burst_level >= 6 || jitter_ms >= 28) {
      factor *= 0.88;
    } else if (burst_level >= 4 || jitter_ms >= 20) {
      factor *= 0.94;
    }
    return clamp(factor, 0.45, 1);
  }

  // 获取Vbv Min Bitrate Bps。
  function get_vbv_min_bitrate_bps(policy) {
    const profile_min_bps = Math.floor(policy.profile.minBpf * FPS_LEVELS[0]);
    return clamp(profile_min_bps, 300_000, Math.max(300_000, policy.bitrateCapBps));
  }

  // 获取Vbv Target Fps。
  function get_vbv_target_fps(policy, bitrate_bps) {
    const min_bpf = policy.profile.minBpf;
    let selected = FPS_LEVELS[0];
    for (const fps of FPS_LEVELS) {
      if (fps > policy.maxFps) {
        continue;
      }
      if (bitrate_bps / fps >= min_bpf) {
        selected = fps;
      }
    }
    return selected;
  }

  // 同步Send Vbv。
  function sync_send_vbv(metrics = null) {
    const policy = sync_send_policy();
    const now = Date.now();
    const health_factor = get_vbv_health_factor(metrics || {
      queueDelayMs: state.cc.queueDelayMs,
      lossPermille: state.cc.lossPermille,
      jitterMs: Math.floor(state.rx_jitter_ms || 0),
      burstLevel: 0
    });
    const min_bitrate_bps = get_vbv_min_bitrate_bps(policy);
    const desired_target_bps = clamp(Math.round(policy.bitrateCapBps * health_factor), min_bitrate_bps, Math.max(min_bitrate_bps, policy.bitrateCapBps));
    state.cc.vbvTargetBps = state.cc.vbvTargetBps > 0 ? Math.round(ewma(state.cc.vbvTargetBps, desired_target_bps, metrics ? 0.35 : 0.6)) : desired_target_bps;
    state.cc.vbvTargetBps = clamp(state.cc.vbvTargetBps, min_bitrate_bps, Math.max(min_bitrate_bps, policy.bitrateCapBps));
    const capacity_ms = state.bad_link_mode ? 520 : 420;
    const bucket_capacity_bits = clamp(Math.round(state.cc.vbvTargetBps * capacity_ms / 1000), 180_000, 1_600_000);
    refill_vbv_tokens(now);
    state.cc.vbvBucketCapacityBits = bucket_capacity_bits;
    state.cc.vbvDebtFloorBits = -Math.round(bucket_capacity_bits * (state.bad_link_mode ? 0.42 : 0.32));
    state.cc.vbvTokensBits = clamp(state.cc.vbvTokensBits, state.cc.vbvDebtFloorBits, state.cc.vbvBucketCapacityBits);
    const prev_fps = Math.max(FPS_LEVELS[0], state.cc.currentFps || FPS_LEVELS[0]);
    let next_fps = get_vbv_target_fps(policy, state.cc.vbvTargetBps);
    if (next_fps > prev_fps && now - state.cc.lastFpsSwitchAt < FPS_COOLDOWN_MS) {
      next_fps = prev_fps;
    }
    next_fps = clamp(next_fps, FPS_LEVELS[0], policy.maxFps);
    if (next_fps !== prev_fps) {
      state.cc.lastFpsSwitchAt = now;
    }
    state.cc.currentFps = next_fps;
    state.cc.vbvEncoderBitrateBps = clamp(Math.round(state.cc.vbvTargetBps * (state.bad_link_mode ? 0.88 : 0.94)), 300_000, Math.max(300_000, policy.bitrateCapBps));
    const frame_budget_bits = state.cc.vbvTargetBps / Math.max(1, state.cc.currentFps);
    const frame_budget_scale = state.bad_link_mode ? 1.85 : 2.1;
    state.cc.vbvMaxFrameBytes = Math.max(PACKET_PAYLOAD_BYTES, Math.round(frame_budget_bits * frame_budget_scale / 8));
    return policy;
  }

  // 处理 prune Expired Frame Marks 相关逻辑。
  function prune_expired_frame_marks(now) {
    for (const [frame_id, expire_at] of state.rx_expired_frames.entries()) {
      if (expire_at <= now) {
        state.rx_expired_frames.delete(frame_id);
      }
    }
  }

  // 标记Frame Expired By Deadline。
  function mark_frame_expired_by_deadline(frame_id, now) {
    const keep_ms = Math.max(1000, state.rx_target_delay_ms * 4);
    state.rx_expired_frames.set(frame_id, now + keep_ms);
  }

  // 处理 activate Timer Fallback 相关逻辑。
  async function activate_timer_fallback() {
    if (state.capture_mode === "timer") {
      return;
    }
    state.capture_loop_token += 1;
    if (state.capture_reader) {
      try {
        await state.capture_reader.cancel();
      } catch {
        // ignore reader cancel failure
      }
      state.capture_reader = null;
    }
    state.track_processor_failure_count = 0;
    start_timer_capture_loop();
    log("capture pipeline fallback activated", 0);
  }

  // 判断是否需要Encode Captured Frame。
  function should_encode_captured_frame(now) {
    if (state.force_next_keyframe) {
      return true;
    }
    const target_fps = Math.max(1, state.cc.currentFps);
    let effective_fps = target_fps;
    if (state.capture_motion_level === "static") {
      effective_fps = Math.min(target_fps, MOTION_STATIC_FPS);
    } else if (state.capture_motion_level === "low") {
      effective_fps = Math.max(MOTION_LOW_MIN_FPS, Math.min(target_fps, Math.round(target_fps / MOTION_LOW_INTERVAL_SCALE)));
    }
    const frame_interval = 1000 / Math.max(1, effective_fps);
    return now - state.last_capture_at >= frame_interval;
  }

  // 确保Motion Analyzer。
  function ensure_motion_analyzer() {
    if (state.capture_motion_canvas && state.capture_motion_ctx) {
      return true;
    }
    let canvas = null;
    if (typeof OffscreenCanvas === "function") {
      canvas = new OffscreenCanvas(MOTION_SAMPLE_WIDTH, MOTION_SAMPLE_HEIGHT);
    } else if (typeof document !== "undefined") {
      canvas = document.createElement("canvas");
      canvas.width = MOTION_SAMPLE_WIDTH;
      canvas.height = MOTION_SAMPLE_HEIGHT;
    }
    if (!canvas) {
      return false;
    }
    const ctx = canvas.getContext("2d", {
      willReadFrequently: true,
      alpha: false
    });
    if (!ctx) {
      return false;
    }
    state.capture_motion_canvas = canvas;
    state.capture_motion_ctx = ctx;
    return true;
  }

  // 处理 analyze Frame Motion 相关逻辑。
  function analyze_frame_motion(frame) {
    if (!ensure_motion_analyzer()) {
      state.capture_motion_level = "high";
      state.capture_motion_score = 255;
      state.cc.vbvMotionBudgetScale = 1.2;
      return {
        level: "high",
        score: 255
      };
    }
    const ctx = state.capture_motion_ctx;
    ctx.drawImage(frame, 0, 0, MOTION_SAMPLE_WIDTH, MOTION_SAMPLE_HEIGHT);
    const image_data = ctx.getImageData(0, 0, MOTION_SAMPLE_WIDTH, MOTION_SAMPLE_HEIGHT);
    const current_luma = new Uint8Array(MOTION_SAMPLE_WIDTH * MOTION_SAMPLE_HEIGHT);
    const prev_luma = state.capture_motion_prev_luma;
    let diff_total = 0;
    for (let src = 0, dst = 0; dst < current_luma.length; src += 4, dst += 1) {
      const r = image_data.data[src];
      const g = image_data.data[src + 1];
      const b = image_data.data[src + 2];
      const luma = r * 77 + g * 150 + b * 29 >> 8;
      current_luma[dst] = luma;
      if (prev_luma) {
        diff_total += Math.abs(luma - prev_luma[dst]);
      }
    }
    state.capture_motion_prev_luma = current_luma;
    if (!prev_luma) {
      state.capture_motion_level = "high";
      state.capture_motion_score = 255;
      state.cc.vbvMotionBudgetScale = 1.2;
      return {
        level: "high",
        score: 255
      };
    }
    const score = diff_total / current_luma.length;
    let level = "high";
    let budget_scale = 1.2;
    if (score <= MOTION_STATIC_THRESHOLD) {
      level = "static";
      budget_scale = 0.92;
    } else if (score <= MOTION_LOW_THRESHOLD) {
      level = "low";
      budget_scale = 0.96;
    } else if (score >= 12) {
      budget_scale = 1.35;
    }
    state.capture_motion_level = level;
    state.capture_motion_score = score;
    state.cc.vbvMotionBudgetScale = budget_scale;
    return {
      level,
      score
    };
  }

  // 处理 reserve Vbv Frame Budget 相关逻辑。
  function reserve_vbv_frame_budget(now, force_key) {
    refill_vbv_tokens(now);
    const frame_budget_bits = state.cc.vbvTargetBps / Math.max(1, state.cc.currentFps);
    const motion_scale = force_key ? 1 : state.cc.vbvMotionBudgetScale || 1;
    const reservation_bits = Math.round(frame_budget_bits * (force_key ? 1.8 : 1.05 * motion_scale));
    const available_bits = state.cc.vbvTokensBits - state.cc.vbvPendingBits;
    const min_reserve_bits = force_key ? state.cc.vbvDebtFloorBits : Math.max(0, frame_budget_bits * 0.55);
    if (available_bits < min_reserve_bits) {
      return null;
    }
    state.cc.vbvPendingBits += reservation_bits;
    state.cc.vbvReservationQueue.push(reservation_bits);
    return reservation_bits;
  }

  // 处理 encode Captured Frame 相关逻辑。
  async function encode_captured_frame(frame, now) {
    if (!state.start_requested || !state.media_transport_open) {
      return false;
    }
    state.tx_encode_attempt_sec += 1;
    sync_send_vbv();
    const force_key = state.force_next_keyframe || now - state.last_keyframe_at >= KEYFRAME_INTERVAL_MS;
    analyze_frame_motion(frame);
    const reserved_bits = reserve_vbv_frame_budget(now, force_key);
    if (reserved_bits == null) {
      state.tx_encode_budget_drop_sec += 1;
      return false;
    }
    await ensure_encoder();
    state.encoder.encode(frame, {
      keyFrame: force_key
    });
    state.tx_encoded_frames_sec += 1;
    if (force_key) {
      state.force_next_keyframe = false;
    }
    state.last_capture_at = now;
    return true;
  }

  // 启动Track Processor Capture Loop。
  function start_track_processor_capture_loop() {
    const track = state.local_stream?.getVideoTracks?.()[0];
    const TrackProcessor = globalThis.MediaStreamTrackProcessor;
    if (!track || typeof TrackProcessor !== "function") {
      return false;
    }
    const processor = new TrackProcessor({
      track
    });
    if (!processor.readable || typeof processor.readable.getReader !== "function") {
      return false;
    }
    const reader = processor.readable.getReader();
    const loop_token = (state.capture_loop_token || 0) + 1;
    state.capture_loop_token = loop_token;
    state.capture_reader = reader;
    state.capture_mode = "track";
    state.track_processor_failure_count = 0;

    // 处理 run 相关逻辑。
    const run = async function () {
      while (state.capture_loop_token === loop_token) {
        const {
          value: frame,
          done
        } = await reader.read();
        if (done || !frame) {
          break;
        }
        try {
          if (!state.start_requested || !state.local_stream) {
            break;
          }
          const now = Date.now();
          state.tx_captured_frames_sec += 1;
          if (!should_encode_captured_frame(now)) {
            state.tx_capture_skip_cadence_sec += 1;
            continue;
          }
          await encode_captured_frame(frame, now);
          state.track_processor_failure_count = 0;
        } catch (error) {
          log("capture loop encode failed", error, 0);
          state.track_processor_failure_count += 1;
          if (state.track_processor_failure_count >= TRACK_PROCESSOR_FAILURE_THRESHOLD) {
            await activate_timer_fallback();
            break;
          }
        } finally {
          frame.close();
        }
      }
    };
    run().catch(error => {
      if (state.capture_loop_token === loop_token) {
        log("track processor loop failed", error, 0);
      }
    }).finally(() => {
      if (state.capture_reader === reader) {
        state.capture_reader = null;
      }
      try {
        reader.releaseLock();
      } catch {
        // ignore release errors
      }
    });
    log("capture pipeline: MediaStreamTrackProcessor");
    return true;
  }

  // 启动Timer Capture Loop。
  function start_timer_capture_loop() {
    if (state.capture_timer) {
      clearInterval(state.capture_timer);
    }
    state.capture_mode = "timer";
    state.track_processor_failure_count = 0;
    state.capture_timer = setInterval(async () => {
      if (
        !state.start_requested ||
        !state.local_stream ||
        !state.media_transport_open
      ) {
        return;
      }
      if (state.capture_busy) {
        return;
      }
      const now = Date.now();
      state.tx_captured_frames_sec += 1;
      if (!should_encode_captured_frame(now)) {
        state.tx_capture_skip_cadence_sec += 1;
        return;
      }
      const video = ui.local_video;
      if (!video || video.readyState < 2) {
        return;
      }
      state.capture_busy = true;
      try {
        const frame = new VideoFrame(video, {
          timestamp: now * 1000
        });
        await encode_captured_frame(frame, now);
        frame.close();
      } catch (error) {
        log("capture timer encode failed", error, 0);
      } finally {
        state.capture_busy = false;
      }
    }, 4);
    log("capture pipeline: video element fallback", 0);
  }

  // Parse the media packet header.
  function parse_packet(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < PACKET_HEADER_BYTES) {
      return null;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const header_len = view.getUint16(2, true);
    if (header_len < PACKET_HEADER_BYTES || header_len > bytes.length) {
      return null;
    }
    const payload_len = view.getUint16(20, true);
    const payload_start = header_len;
    const payload_end = Math.min(bytes.length, payload_start + payload_len);
    return {
      kind: view.getUint8(0),
      flags: view.getUint8(1),
      seq: view.getUint32(4, true),
      frameId: view.getUint32(8, true),
      packetId: view.getUint16(12, true),
      packetCount: view.getUint16(14, true),
      timestampMs: view.getUint32(16, true),
      payloadLen: payload_len,
      aux: view.getUint32(24, true),
      aux2: view.getUint32(28, true),
      payload: bytes.slice(payload_start, payload_end)
    };
  }

  // Pick a usable WebCodecs encoder configuration.
  async function pick_encoder_config(width, height, bitrate, framerate) {
    const candidates = [{
      codecKey: VIDEO_CODEC_H264,
      codec: "avc1.64001f",
      width,
      height,
      bitrate,
      framerate,
      latencyMode: "realtime",
      hardwareAcceleration: "prefer-hardware",
      avc: {
        format: "annexb"
      }
    }, {
      codecKey: VIDEO_CODEC_H264,
      codec: "avc1.42E01F",
      width,
      height,
      bitrate,
      framerate,
      latencyMode: "realtime",
      hardwareAcceleration: "prefer-hardware",
      avc: {
        format: "annexb"
      }
    }, {
      codecKey: VIDEO_CODEC_H264,
      codec: "avc1.42001f",
      width,
      height,
      bitrate,
      framerate,
      latencyMode: "realtime",
      hardwareAcceleration: "prefer-hardware",
      avc: {
        format: "annexb"
      }
    }, {
      codecKey: VIDEO_CODEC_H264,
      codec: "avc1.42E01F",
      width,
      height,
      bitrate,
      framerate,
      latencyMode: "realtime",
      hardwareAcceleration: "no-preference",
      avc: {
        format: "annexb"
      }
    }, {
      codecKey: VIDEO_CODEC_H264,
      codec: "avc1.42001f",
      width,
      height,
      bitrate,
      framerate,
      latencyMode: "realtime",
      hardwareAcceleration: "no-preference",
      avc: {
        format: "annexb"
      }
    }, {
      codecKey: VIDEO_CODEC_VP8,
      codec: "vp8",
      width,
      height,
      bitrate,
      framerate,
      latencyMode: "realtime",
      hardwareAcceleration: "no-preference"
    }];
    const failure_notes = [];
    for (const candidate of candidates) {
      try {
        const support = await VideoEncoder.isConfigSupported(candidate);
        if (support?.supported) {
          return {
            codecKey: candidate.codecKey,
            config: support.config
          };
        }
        failure_notes.push(`${candidate.codec}/${candidate.hardwareAcceleration}/${width}x${height}@${framerate}`);
      } catch {
        failure_notes.push(`${candidate.codec}/${candidate.hardwareAcceleration}/${width}x${height}@${framerate}:throw`);
      }
    }
    throw new Error(`当前环境不支持可用的 WebCodecs 视频编码配置: ${failure_notes.join(", ")}`);
  }

  // 确保Encoder。
  async function ensure_encoder() {
    const policy = sync_send_vbv();
    const {
      profileKey: profile_key,
      profile
    } = policy;
    const bitrate = clamp(Math.floor(state.cc.vbvEncoderBitrateBps), 300_000, Math.max(300_000, policy.bitrateCapBps));
    const fps = clamp(Math.floor(state.cc.currentFps), 12, policy.maxFps);
    const bitrate_bucket_bps = Math.max(300_000, Math.round(bitrate / ENCODER_BITRATE_BUCKET_STEP_BPS) * ENCODER_BITRATE_BUCKET_STEP_BPS);
    const encoder_config_key = `${profile_key}:${profile.width}x${profile.height}:${fps}:${bitrate_bucket_bps}`;
    const prev_profile_key = state.cc.activeProfileKey;
    const prev_bucket_bps = state.cc.activeEncoderBitrateBucketBps || 0;
    const needs_profile_reconfigure = !state.encoder_configured || profile_key !== prev_profile_key || state.cc.currentFps !== fps;
    const bucket_changed = bitrate_bucket_bps !== prev_bucket_bps;
    const now = Date.now();
    if (state.encoder && state.encoder_configured && state.cc.activeEncoderConfigKey === encoder_config_key) {
      return;
    }
    if (state.encoder && state.encoder_configured && !needs_profile_reconfigure && bucket_changed && now - state.cc.lastEncoderReconfigureAt < ENCODER_RECONFIGURE_COOLDOWN_MS) {
      return;
    }
    const {
      codecKey: codec_key,
      config
    } = await pick_encoder_config(profile.width, profile.height, bitrate, fps);
    if (!state.encoder) {
      // 处理 output 相关逻辑。
      state.encoder = new VideoEncoder({
        output: chunk => {
          handle_encoded_chunk(chunk).catch(error => log("encoder output failed", error, 0));
        },
        error: error => {
          log("encoder error", error, 0);
        }
      });
    }
    state.encoder.configure(config);
    state.active_video_codec_key = codec_key;
    state.encoder_configured = true;
    state.cc.activeProfileKey = profile_key;
    state.cc.activeEncoderConfigKey = encoder_config_key;
    state.cc.activeEncoderBitrateBucketBps = bitrate_bucket_bps;
    state.cc.lastEncoderReconfigureAt = now;
    log(`encoder configured: ${config.codec} ${profile.width}x${profile.height} ${fps}fps codec_key=${codec_key} ` + `profile=${profile_key} vbv_kbps=${Math.round(state.cc.vbvTargetBps / 1000)} ` + `bucket_kbps=${Math.round(bitrate_bucket_bps / 1000)} route=${state.libzt_route_status} selected=${policy.selectedKey}`, 0);
  }

  // 确保Decoder。
  function ensure_decoder(codec_key = VIDEO_CODEC_H264) {
    if (state.decoder && state.decoder_configured && state.active_decoder_codec_key === codec_key) {
      return state.decoder_generation;
    }
    const canvas = ui.remote_canvas;
    const ctx = canvas.getContext("2d", {
      alpha: false
    });
    if (!state.decoder) {
      // 处理 output 相关逻辑。
      state.decoder = new VideoDecoder({
        output: frame => {
          try {
            if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
              canvas.width = frame.displayWidth;
              canvas.height = frame.displayHeight;
            }
            ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
            const now = Date.now();
            const frame_timestamp_ms = typeof frame.timestamp === "bigint" ? Number(frame.timestamp / 1000n) : Math.round(Number(frame.timestamp || 0) / 1000);
            if (Number.isFinite(frame_timestamp_ms) && frame_timestamp_ms >= 0) {
              state.rx_play_clock_wall_ms = now;
              state.rx_play_clock_media_ts_ms = frame_timestamp_ms >>> 0;
            }
            state.rx_last_complete_frame_at = now;
            state.rx_last_decode_output_at = now;
            state.rx_decoder_awaiting_output = false;
            state.rx_need_keyframe = false;
            state.rx_window_frames += 1;
            state.rx_frames_played_sec += 1;
            update_merged_video_view();
          } finally {
            frame.close();
          }
        },
        error: error => {
          log("decoder error", error, 0);
          const now = Date.now();
          note_rx_frame_drop(now);
          maybe_request_pli_for_stall(now);
        }
      });
    }
    const decoder_config = codec_key === VIDEO_CODEC_VP8 ? {
      codec: "vp8",
      hardwareAcceleration: "no-preference",
      optimizeForLatency: true
    } : {
      codec: "avc1.42E01F",
      hardwareAcceleration: "prefer-hardware",
      optimizeForLatency: true
    };
    state.decoder.configure(decoder_config);
    state.active_decoder_codec_key = codec_key;
    state.decoder_configured = true;
    state.decoder_generation += 1;
    return state.decoder_generation;
  }

  // Close the encoder.
  async function close_encoder() {
    state.capture_loop_token += 1;
    if (state.capture_timer) {
      clearInterval(state.capture_timer);
      state.capture_timer = null;
    }
    if (state.capture_reader) {
      try {
        await state.capture_reader.cancel();
      } catch {
        // ignore reader cancel failure
      }
      state.capture_reader = null;
    }
    state.capture_mode = "";
    state.track_processor_failure_count = 0;
    state.capture_motion_level = "high";
    state.capture_motion_score = 255;
    state.capture_motion_prev_luma = null;
    if (state.encoder) {
      try {
        await state.encoder.flush();
      } catch {
        // ignore flush failure
      }
      state.encoder.close();
      state.encoder = null;
    }
    state.encoder_configured = false;
    state.active_video_codec_key = VIDEO_CODEC_H264;
    state.cc.activeEncoderConfigKey = "";
    state.cc.activeEncoderBitrateBucketBps = 0;
    state.cc.vbvPendingBits = 0;
    state.cc.vbvReservationQueue = [];
    state.retrans_cache.clear();
  }

  // Close the decoder.
  function close_decoder() {
    if (nack_flush_timer) {
      clearTimeout(nack_flush_timer);
      nack_flush_timer = null;
    }
    pending_nacks.clear();
    if (state.decoder) {
      state.decoder.close();
      state.decoder = null;
    }
    state.decoder_generation += 1;
    state.decoder_configured = false;
    state.active_decoder_codec_key = "";
    state.rx_decoder_awaiting_output = false;
    state.rx_last_frame_assembled_at = 0;
    state.rx_last_decode_input_at = 0;
    state.rx_last_decode_output_at = 0;
    state.rx_play_clock_wall_ms = 0;
    state.rx_play_clock_media_ts_ms = 0;
    state.rx_frame_buffer.clear();
    enter_keyframe_recovery();
    state.rx_consecutive_drop_frames = 0;
    state.rx_last_drop_at = 0;
    state.rx_expected_seq = null;
    state.rx_reorder_pending.clear();
    state.rx_expired_frames.clear();
  }

  // Packetize an encoded frame within MTU and cache retransmittable packets.
  function packetize_encoded_frame(frame_bytes, is_keyframe, frame_id, timestamp_ms, codec_key) {
    const packets = [];
    const total_bytes = frame_bytes.length;
    const packet_count = Math.max(1, Math.ceil(total_bytes / PACKET_PAYLOAD_BYTES));
    for (let i = 0; i < packet_count; i += 1) {
      const start = i * PACKET_PAYLOAD_BYTES;
      const end = Math.min(total_bytes, start + PACKET_PAYLOAD_BYTES);
      const payload = frame_bytes.slice(start, end);
      const seq = state.seq;
      state.seq = state.seq + 1 >>> 0;
      const packet = build_packet({
        kind: PKT_KIND_DATA,
        flags: (is_keyframe ? FLAG_KEYFRAME : 0) | get_codec_flag(codec_key),
        seq,
        frameId: frame_id,
        packetId: i,
        packetCount: packet_count,
        timestampMs: timestamp_ms,
        payload,
        aux: total_bytes,
        aux2: 0
      });
      packets.push(packet);
      const cache_key = `${frame_id}:${i}`;
      state.retrans_cache.set(cache_key, {
        packet,
        sentAt: Date.now(),
        retransmitCount: 0,
        isKeyframe: is_keyframe,
        packetCount: packet_count
      });
    }
    return packets;
  }

  // 获取Base Fec Parity Count。
  function get_base_fec_parity_count(data_packet_count) {
    if (data_packet_count <= 1) {
      return 0;
    }
    if (data_packet_count <= 4) {
      return 1;
    }
    if (data_packet_count <= 8) {
      return 2;
    }
    if (data_packet_count <= 12) {
      return 3;
    }
    if (data_packet_count <= 16) {
      return 4;
    }
    if (data_packet_count <= 20) {
      return 5;
    }
    return Math.min(8, 5 + Math.ceil((data_packet_count - 20) / 4));
  }

  // Build parity packets from packet-count buckets instead of dynamic rate heuristics.
  function build_fec_packets(data_packets, rate, frame_id, timestamp_ms, frame_size, is_keyframe, codec_key) {
    if (!data_packets.length || rate <= 0) {
      return [];
    }
    let parity_count = get_base_fec_parity_count(data_packets.length);
    if (parity_count <= 0) {
      return [];
    }
    if (is_keyframe) {
      parity_count += 1;
    }
    if (state.bad_link_mode) {
      parity_count += 1;
    }
    parity_count = Math.min(parity_count, Math.max(1, Math.min(8, data_packets.length - 1)));
    const data_payloads = [];
    let shard_size = 0;
    for (const packet_bytes of data_packets) {
      const parsed = parse_packet(packet_bytes);
      if (!parsed) {
        continue;
      }
      data_payloads.push(parsed.payload);
      shard_size = Math.max(shard_size, parsed.payload.length);
    }
    if (!data_payloads.length || shard_size <= 0) {
      return [];
    }
    const fec_packets = [];
    for (let parity_index = 0; parity_index < parity_count; parity_index += 1) {
      const selected = make_fec_row_indices(frame_id, parity_index, data_payloads.length);
      const parity_payload = new Uint8Array(shard_size);
      for (const src_index of selected) {
        xor_into(parity_payload, data_payloads[src_index]);
      }
      const seq = state.seq;
      state.seq = state.seq + 1 >>> 0;
      fec_packets.push(build_packet({
        kind: PKT_KIND_DATA,
        flags: (is_keyframe ? FLAG_KEYFRAME : 0) | FLAG_FEC | get_codec_flag(codec_key),
        seq,
        frameId: frame_id,
        packetId: parity_index,
        packetCount: data_payloads.length,
        timestampMs: timestamp_ms,
        payload: parity_payload,
        aux: frame_size,
        aux2: (shard_size & 0xffff) << 16 | parity_count & 0xffff
      }));
    }
    return fec_packets;
  }

  // Compute pacing spread for a frame burst.
  function compute_pacing_spread_ms(packet_count, is_keyframe = false) {
    if (packet_count <= 1) {
      return PACING_MIN_MS;
    }
    let estimate = Math.round(packet_count * 0.9);
    if (packet_count >= 16) {
      estimate += 6;
    } else if (packet_count >= 10) {
      estimate += 3;
    }
    if (is_keyframe) {
      estimate += 4;
    }
    if (state.bad_link_mode) {
      estimate += packet_count >= 12 ? 8 : 4;
    }
    return clamp(estimate, PACING_MIN_MS, PACING_MAX_MS);
  }

  // Cleanup retransmission cache with different keyframe/delta retention windows.
  function cleanup_retrans_cache() {
    const now = Date.now();
    for (const [key, item] of state.retrans_cache.entries()) {
      const keep_ms = item.isKeyframe ? KEYFRAME_CACHE_KEEP_MS : DELTA_CACHE_KEEP_MS;
      if (now - item.sentAt > keep_ms) {
        state.retrans_cache.delete(key);
      }
    }
    const overflow = state.retrans_cache.size - RETRANS_CACHE_MAX_ITEMS;
    if (overflow <= 0) {
      return;
    }
    const oldest = Array.from(state.retrans_cache.entries()).sort((a, b) => a[1].sentAt - b[1].sentAt).slice(0, overflow);
    for (const [key] of oldest) {
      state.retrans_cache.delete(key);
    }
  }

  // Handle encoder output: packetize, add FEC, then pace sending.
  async function handle_encoded_chunk(chunk) {
    if (!state.media_transport_open) {
      return;
    }
    const is_keyframe = chunk.type === "key";
    if (is_keyframe) {
      state.last_keyframe_at = Date.now();
    }
    const frame_bytes = new Uint8Array(chunk.byteLength);
    chunk.copyTo(frame_bytes);
    const frame_id = state.frame_id;
    state.frame_id = state.frame_id + 1 >>> 0;
    const timestamp_ms = Date.now() & 0xffffffff;
    const codec_key = state.active_video_codec_key || VIDEO_CODEC_H264;
    const data_packets = packetize_encoded_frame(frame_bytes, is_keyframe, frame_id, timestamp_ms, codec_key);
    const fec_packets = build_fec_packets(data_packets, state.cc.currentFecRate, frame_id, timestamp_ms, frame_bytes.length, is_keyframe, codec_key);
    const packets = [...data_packets, ...fec_packets];
    const wire_bytes = packets.reduce((sum, pkt) => sum + pkt.byteLength, 0);
    const reserved_bits = state.cc.vbvReservationQueue.length > 0 ? state.cc.vbvReservationQueue.shift() : 0;
    if (reserved_bits > 0) {
      state.cc.vbvPendingBits = Math.max(0, state.cc.vbvPendingBits - reserved_bits);
    }
    const spread_ms = compute_pacing_spread_ms(packets.length, is_keyframe);
    const sent = await send_media_batch(packets, spread_ms, is_keyframe ? "keyframe" : "delta");
    if (!sent) {
      return;
    }
    refill_vbv_tokens();
    state.cc.vbvTokensBits = clamp(state.cc.vbvTokensBits - wire_bytes * 8, state.cc.vbvDebtFloorBits, state.cc.vbvBucketCapacityBits);
    state.tx_window_bytes += frame_bytes.byteLength;
    state.tx_window_frames += 1;
    state.tx_pkts_sec += packets.length;
    state.tx_bytes_sec += wire_bytes;
    state.tx_frames_sent_sec += 1;
    state.tx_frame_pkt_total_sec += data_packets.length;
    if (is_keyframe) {
      state.tx_keyframes_sec += 1;
    }
    cleanup_retrans_cache();
  }

  // Compute remaining time before the 32-bit deadline.
  function remaining_ms_to_deadline32(deadline_ms, now_ms) {
    return deadline_ms - now_ms | 0;
  }

  // Try a single retransmission if there is still enough time.
  async function try_retransmit_packet(frame_id, packet_id, deadline_ms) {
    const key = `${frame_id}:${packet_id}`;
    const item = state.retrans_cache.get(key);
    if (!item) {
      return;
    }
    const now = Date.now();
    const now32 = now & 0xffffffff;
    const estimated_rtt = state.cc.rttMs > 0 ? state.cc.rttMs : NACK_UNKNOWN_RTT_MS;
    const remain_ms = remaining_ms_to_deadline32(deadline_ms >>> 0, now32 >>> 0);
    const remain_guard_ms = item.isKeyframe ? 0 : DELTA_NACK_REMAIN_GUARD_MS;
    if (remain_ms <= estimated_rtt + remain_guard_ms) {
      return;
    }
    const max_retransmits = item.isKeyframe ? 3 : item.packetCount >= 12 ? 2 : 1;
    if ((item.retransmitCount || 0) >= max_retransmits) {
      return;
    }
    const copy = item.packet.slice();
    copy[1] = copy[1] | FLAG_RETRANS;
    const sent = await send_media_batch([copy], PACING_MIN_MS, "retransmit");
    if (!sent) {
      return;
    }
    item.retransmitCount = (item.retransmitCount || 0) + 1;
    item.sentAt = now;
    state.retrans_cache.set(key, item);
    log(`${item.isKeyframe ? "keyframe" : "delta frame"} retransmit frame=${frame_id} pid=${packet_id}`, 0);
  }

  // Send a congestion-control feedback probe.
  async function send_feedback_req() {
    if (!state.media_transport_open) {
      return;
    }
    const now_wall_ms = Date.now();
    if (state.awaiting_cc_probe) {
      const elapsed_ms = now_wall_ms - state.last_cc_req_wall_ms;
      if (elapsed_ms >= 0 && elapsed_ms < CC_PROBE_TIMEOUT_MS) {
        return;
      }
      state.awaiting_cc_probe = false;
    }
    const req_ts = now_wall_ms & 0xffffffff;
    const probe_id = state.last_cc_probe_id + 1 >>> 0;
    state.last_cc_req_ts = req_ts;
    state.last_cc_req_wall_ms = now_wall_ms;
    state.last_cc_probe_id = probe_id;
    state.awaiting_cc_probe = true;
    const seq = state.seq;
    state.seq = state.seq + 1 >>> 0;
    const packet = build_packet({
      kind: PKT_KIND_FEEDBACK_REQ,
      flags: 0,
      seq,
      frameId: 0,
      packetId: 0,
      packetCount: 0,
      timestampMs: req_ts,
      payload: build_cc_probe_payload(probe_id),
      aux: 0,
      aux2: 0
    });
    await send_media_batch([packet], PACING_MIN_MS, "control");
  }

  // Reply with feedback including jitter/loss and burst level.
  async function send_feedback(echo_req_ts, probe_id) {
    if (!state.media_transport_open) {
      return;
    }
    const loss_permille = state.rx_delta_recv_packets + state.rx_delta_lost_packets > 0 ? Math.floor(state.rx_delta_lost_packets * 1000 / (state.rx_delta_recv_packets + state.rx_delta_lost_packets)) : 0;
    const jitter_ms = Math.floor(state.rx_jitter_ms);
    const aux2 = (loss_permille & 0xffff) << 16 | jitter_ms & 0xffff;
    const feedback_payload = build_feedback_payload(state.rx_loss_burst_max, probe_id);
    const seq = state.seq;
    state.seq = state.seq + 1 >>> 0;
    const packet = build_packet({
      kind: PKT_KIND_FEEDBACK,
      flags: 0,
      seq,
      frameId: 0,
      packetId: 0,
      packetCount: 0,
      timestampMs: Date.now() & 0xffffffff,
      payload: feedback_payload,
      aux: echo_req_ts >>> 0,
      aux2
    });
    await send_media_batch([packet], PACING_MIN_MS, "control");
    state.rx_delta_recv_packets = 0;
    state.rx_delta_lost_packets = 0;
    state.rx_loss_burst_current = 0;
    state.rx_loss_burst_max = 0;
  }

  // Refresh the min-RTT window to keep queue-delay baseline from sticking forever.
  function update_min_rtt_window(rtt_ms, now_ms) {
    const samples = state.cc.rttSamples;
    samples.push({
      ts: now_ms,
      rttMs: rtt_ms
    });
    const cutoff = now_ms - MIN_RTT_WINDOW_MS;
    while (samples.length > 0 && samples[0].ts < cutoff) {
      samples.shift();
    }
    if (samples.length === 0) {
      return rtt_ms;
    }
    let min_rtt = samples[0].rttMs;
    for (let i = 1; i < samples.length; i += 1) {
      if (samples[i].rttMs < min_rtt) {
        min_rtt = samples[i].rttMs;
      }
    }
    return min_rtt;
  }

  // Adapt FEC rate with hysteresis from loss, burst level, and jitter.
  function adapt_fec_rate_with_hysteresis(loss_permille, burst_level, jitter_ms) {
    let target_rate = FEC_MIN_RATE;
    if (loss_permille >= 180 || burst_level >= 6 || jitter_ms >= 28) {
      target_rate = FEC_MAX_RATE;
    } else if (loss_permille >= 120 || burst_level >= 4 || jitter_ms >= 20) {
      target_rate = Math.min(FEC_MAX_RATE, FEC_MIN_RATE + 0.09);
    } else if (loss_permille >= 70 || burst_level >= 3 || jitter_ms >= 14) {
      target_rate = Math.min(FEC_MAX_RATE, FEC_MIN_RATE + 0.06);
    } else if (loss_permille >= 35 || burst_level >= 2 || jitter_ms >= 10) {
      target_rate = Math.min(FEC_MAX_RATE, FEC_MIN_RATE + 0.03);
    }
    const now = Date.now();
    const current = state.cc.currentFecRate;
    if (target_rate > current + FEC_HYSTERESIS_UP_STEP) {
      state.cc.currentFecRate = target_rate;
      state.cc.fecLastAdjustAt = now;
      return;
    }
    if (target_rate < current - FEC_HYSTERESIS_DOWN_STEP && now - state.cc.fecLastAdjustAt >= FEC_HYSTERESIS_HOLD_MS) {
      state.cc.currentFecRate = target_rate;
      state.cc.fecLastAdjustAt = now;
    }
  }

  // 刷新Pending Nacks。
  async function flush_pending_nacks() {
    nack_flush_timer = null;
    if (!state.media_transport_open || pending_nacks.size === 0) {
      pending_nacks.clear();
      return;
    }
    const now = Date.now() & 0xffffffff;
    const packets = [];
    for (const item of pending_nacks.values()) {
      const seq = state.seq;
      state.seq = state.seq + 1 >>> 0;
      packets.push(build_packet({
        kind: PKT_KIND_NACK,
        flags: 0,
        seq,
        frameId: item.frameId,
        packetId: item.packetId,
        packetCount: 1,
        timestampMs: now,
        payload: new Uint8Array(0),
        aux: item.deadlineMs & 0xffffffff,
        aux2: 0
      }));
    }
    pending_nacks.clear();
    if (packets.length > 0) {
      state.rx_nack_sent_sec += packets.length;
      await send_media_batch(packets, NACK_FLUSH_BATCH_MS, "nack");
    }
  }

  // 处理 enqueue Nack 相关逻辑。
  function enqueue_nack(frame_id, packet_id, deadline_ms) {
    const key = `${frame_id}:${packet_id}`;
    const existing = pending_nacks.get(key);
    if (!existing || deadline_ms > existing.deadlineMs) {
      pending_nacks.set(key, {
        frameId: frame_id,
        packetId: packet_id,
        deadlineMs: deadline_ms
      });
      if (!existing) {
        state.rx_nack_enqueued_sec += 1;
      }
    }
    if (!nack_flush_timer) {
      nack_flush_timer = setTimeout(() => {
        flush_pending_nacks().catch(error => log("flush nack batch failed", error, 0));
      }, NACK_FLUSH_BATCH_MS);
    }
    return !existing;
  }

  // Send a PLI request for a fresh keyframe.
  async function send_pli() {
    if (!state.media_transport_open) {
      return;
    }
    const now = Date.now();
    if (now - state.rx_pli_last_sent_at < PLI_MIN_INTERVAL_MS) {
      return;
    }
    state.rx_pli_last_sent_at = now;
    const seq = state.seq;
    state.seq = state.seq + 1 >>> 0;
    const packet = build_packet({
      kind: PKT_KIND_PLI,
      flags: 0,
      seq,
      frameId: state.rx_last_complete_frame_id,
      packetId: 0,
      packetCount: 0,
      timestampMs: now & 0xffffffff,
      payload: new Uint8Array(0),
      aux: 0,
      aux2: 0
    });
    await send_media_batch([packet], PACING_MIN_MS, "control");
    push_metric_ts(state.pli_sent_ts, now, 60_000);
  }

  // Try to recover missing shards with FEC before decode.
  function try_recover_missing_by_fec(frame_state, frame_id) {
    const missing = [];
    for (let i = 0; i < frame_state.packetCount; i += 1) {
      if (!frame_state.packets.has(i)) {
        missing.push(i);
      }
    }
    if (missing.length === 0 || !frame_state.fecPackets || frame_state.fecPackets.size === 0) {
      return;
    }
    const unknown_pos = new Map();
    missing.forEach((packet_id, idx) => unknown_pos.set(packet_id, idx));
    const matrix = [];
    const rhs = [];
    const shard_size = frame_state.fecShardSize || PACKET_PAYLOAD_BYTES;
    for (const [parity_index, parity_payload] of frame_state.fecPackets.entries()) {
      const selected = make_fec_row_indices(frame_id, parity_index, frame_state.packetCount);
      const coeff = new Uint8Array(missing.length);
      const row_rhs = parity_payload.slice();
      for (const pkt_index of selected) {
        const known = frame_state.packets.get(pkt_index);
        if (known) {
          xor_into(row_rhs, known);
          continue;
        }
        const miss_pos = unknown_pos.get(pkt_index);
        if (miss_pos != null) {
          coeff[miss_pos] = 1;
        }
      }
      if (coeff.some(v => v !== 0)) {
        if (row_rhs.length !== shard_size) {
          const normalized = new Uint8Array(shard_size);
          normalized.set(row_rhs.slice(0, shard_size));
          matrix.push(coeff);
          rhs.push(normalized);
        } else {
          matrix.push(coeff);
          rhs.push(row_rhs);
        }
      }
    }
    if (matrix.length < missing.length) {
      return;
    }
    const pivot_cols = [];
    let pivot_row = 0;
    for (let col = 0; col < missing.length && pivot_row < matrix.length; col += 1) {
      let row = pivot_row;
      while (row < matrix.length && matrix[row][col] === 0) {
        row += 1;
      }
      if (row >= matrix.length) {
        continue;
      }
      if (row !== pivot_row) {
        [matrix[row], matrix[pivot_row]] = [matrix[pivot_row], matrix[row]];
        [rhs[row], rhs[pivot_row]] = [rhs[pivot_row], rhs[row]];
      }
      for (let r = 0; r < matrix.length; r += 1) {
        if (r === pivot_row || matrix[r][col] === 0) {
          continue;
        }
        for (let c = col; c < missing.length; c += 1) {
          matrix[r][c] ^= matrix[pivot_row][c];
        }
        xor_into(rhs[r], rhs[pivot_row]);
      }
      pivot_cols[pivot_row] = col;
      pivot_row += 1;
    }
    if (pivot_row < missing.length) {
      return;
    }
    const solved = new Array(missing.length);
    for (let r = pivot_row - 1; r >= 0; r -= 1) {
      const pivot_col = pivot_cols[r];
      const value = rhs[r].slice();
      for (let c = pivot_col + 1; c < missing.length; c += 1) {
        if (matrix[r][c] === 1 && solved[c]) {
          xor_into(value, solved[c]);
        }
      }
      solved[pivot_col] = value;
    }
    for (let idx = 0; idx < missing.length; idx += 1) {
      const packet_id = missing[idx];
      const shard = solved[idx];
      if (!shard) {
        continue;
      }
      const start = packet_id * PACKET_PAYLOAD_BYTES;
      const expected_len = Math.max(0, Math.min(PACKET_PAYLOAD_BYTES, frame_state.frameSize - start));
      if (expected_len <= 0) {
        continue;
      }
      frame_state.packets.set(packet_id, shard.slice(0, expected_len));
    }
  }

  // 处理 decode Completed Frame 相关逻辑。
  async function decode_completed_frame(frame_id, frame_state, bytes) {
    const chunk = new EncodedVideoChunk({
      type: frame_state.isKeyframe ? "key" : "delta",
      timestamp: Number(frame_state.timestampMs) * 1000,
      data: bytes
    });
    const decoder_generation = await ensure_decoder(frame_state.codecKey || VIDEO_CODEC_H264);
    if (!state.decoder || !state.decoder_configured || decoder_generation !== state.decoder_generation || state.active_decoder_codec_key !== (frame_state.codecKey || VIDEO_CODEC_H264)) {
      return false;
    }
    state.decoder.decode(chunk);
    state.rx_last_decode_input_at = Date.now();
    state.rx_decoder_awaiting_output = state.rx_need_keyframe;
    state.rx_last_complete_frame_id = frame_id;
    state.rx_consecutive_drop_frames = 0;
    state.rx_last_drop_at = 0;
    state.rx_window_bytes += bytes.byteLength;
    return true;
  }

  // 获取Smallest Completed Frame Id。
  function get_smallest_completed_frame_id() {
    let min_frame_id = null;
    for (const frame_id of state.rx_completed_frames.keys()) {
      if (min_frame_id == null || frame_id < min_frame_id) {
        min_frame_id = frame_id;
      }
    }
    return min_frame_id;
  }

  function get_smallest_completed_frame_id_at_or_after(min_frame_id, keyframe_only = false) {
    let candidate_frame_id = null;
    for (const [frame_id, frame_state] of state.rx_completed_frames.entries()) {
      if (frame_id < min_frame_id) {
        continue;
      }
      if (keyframe_only && !frame_state.isKeyframe) {
        continue;
      }
      if (candidate_frame_id == null || frame_id < candidate_frame_id) {
        candidate_frame_id = frame_id;
      }
    }
    return candidate_frame_id;
  }

  // 获取Smallest Completed Keyframe Id。
  function get_smallest_completed_keyframe_id() {
    let min_frame_id = null;
    for (const [frame_id, frame_state] of state.rx_completed_frames.entries()) {
      if (!frame_state.isKeyframe) {
        continue;
      }
      if (min_frame_id == null || frame_id < min_frame_id) {
        min_frame_id = frame_id;
      }
    }
    return min_frame_id;
  }

  function reset_decode_wait_state() {
    state.rx_decode_wait_frame_id = null;
    state.rx_decode_wait_started_at = 0;
  }

  function get_decode_wait_timeout_ms() {
    return Math.max(PLI_TIMEOUT_MS, get_adaptive_reorder_hold_ms() + 240, state.rx_target_delay_ms * 4);
  }

  function maybe_resume_decode_after_missing_frame(next_frame_id, now) {
    if (state.rx_decode_wait_frame_id !== next_frame_id) {
      state.rx_decode_wait_frame_id = next_frame_id;
      state.rx_decode_wait_started_at = now;
      return false;
    }
    const wait_ms = now - state.rx_decode_wait_started_at;
    const wait_timeout_ms = get_decode_wait_timeout_ms();
    if (wait_ms < wait_timeout_ms) {
      return false;
    }
    const keyframe_candidate = get_smallest_completed_frame_id_at_or_after(next_frame_id, true);
    const resume_frame_id = state.rx_need_keyframe ? keyframe_candidate : keyframe_candidate ?? get_smallest_completed_frame_id_at_or_after(next_frame_id, false);
    if (resume_frame_id == null) {
      return false;
    }
    for (const frame_id of state.rx_completed_frames.keys()) {
      if (frame_id < resume_frame_id) {
        state.rx_completed_frames.delete(frame_id);
      }
    }
    log(`rx decode re-anchor | from=${next_frame_id} to=${resume_frame_id} reason=missing-frame-stall wait_ms=${wait_ms} need_keyframe=${state.rx_need_keyframe}`, 0);
    state.rx_next_decode_frame_id = resume_frame_id;
    reset_decode_wait_state();
    return true;
  }

  // 刷新Completed Frames。
  async function flush_completed_frames() {
    if (state.rx_decode_flush_busy) {
      return;
    }
    state.rx_decode_flush_busy = true;
    try {
      while (state.rx_completed_frames.size > 0) {
        if (state.rx_next_decode_frame_id == null) {
          const anchor_frame_id = state.rx_need_keyframe ? get_smallest_completed_keyframe_id() : get_smallest_completed_frame_id();
          if (anchor_frame_id == null) {
            return;
          }
          for (const frame_id of state.rx_completed_frames.keys()) {
            if (frame_id < anchor_frame_id) {
              state.rx_completed_frames.delete(frame_id);
            }
          }
          state.rx_next_decode_frame_id = anchor_frame_id;
          reset_decode_wait_state();
          log(`rx decode anchor | frame=${anchor_frame_id} keyframe=${state.rx_need_keyframe ? "required" : "no"}`, 0);
        }
        const next_frame_id = state.rx_next_decode_frame_id;
        const completed_frame = state.rx_completed_frames.get(next_frame_id);
        if (completed_frame) {
          reset_decode_wait_state();
          if (state.rx_need_keyframe && state.rx_decoder_awaiting_output && !completed_frame.isKeyframe) {
            return;
          }
          try {
            const decoded = await decode_completed_frame(next_frame_id, completed_frame, completed_frame.bytes);
            if (!decoded) {
              return;
            }
            state.rx_completed_frames.delete(next_frame_id);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!message.includes("closed codec")) {
              log("解码输入失败", error, 0);
              log("decoder input failed", error, 0);
            }
            enter_keyframe_recovery();
            return;
          }
          state.rx_next_decode_frame_id = next_frame_id + 1 >>> 0;
          continue;
        }
        const expired_at = state.rx_expired_frames.get(next_frame_id);
        if (expired_at && expired_at > Date.now()) {
          reset_decode_wait_state();
          log(`rx decode skip expired frame=${next_frame_id}`, 0);
          state.rx_next_decode_frame_id = next_frame_id + 1 >>> 0;
          continue;
        }
        if (maybe_resume_decode_after_missing_frame(next_frame_id, Date.now())) {
          continue;
        }
        return;
      }
    } finally {
      state.rx_decode_flush_busy = false;
    }
  }

  // 处理 try Assemble Frame 相关逻辑。
  async function try_assemble_frame(frame_id) {
    const frame_state = state.rx_frame_buffer.get(frame_id);
    if (!frame_state) {
      return;
    }
    if (frame_state.packets.size !== frame_state.packetCount) {
      try_recover_missing_by_fec(frame_state, frame_id);
      if (frame_state.packets.size !== frame_state.packetCount) {
        return;
      }
    }
    const merged = new Uint8Array(frame_state.frameSize);
    let offset = 0;
    for (let i = 0; i < frame_state.packetCount; i += 1) {
      const part = frame_state.packets.get(i);
      if (!part) {
        return;
      }
      merged.set(part, offset);
      offset += part.length;
    }
    const bytes = merged.slice(0, frame_state.frameSize);
    state.rx_frames_completed_sec += 1;
    state.rx_completed_frame_pkt_total_sec += frame_state.packetCount;
    state.rx_frame_buffer.delete(frame_id);
    state.rx_completed_frames.set(frame_id, {
      codecKey: frame_state.codecKey || VIDEO_CODEC_H264,
      isKeyframe: frame_state.isKeyframe,
      timestampMs: frame_state.timestampMs,
      bytes
    });
    state.rx_last_frame_assembled_at = Date.now();
    await flush_completed_frames();
  }

  // Update jitter and receive counters from packet arrival.
  function update_rx_transit_stats(packet) {
    const now = Date.now();
    const transit = now - packet.timestampMs;
    if (Number.isFinite(transit)) {
      if (state.rx_prev_transit_ms != null) {
        const delta = Math.abs(transit - state.rx_prev_transit_ms);
        state.rx_jitter_ms = ewma(state.rx_jitter_ms, delta, 0.18);
      }
      state.rx_prev_transit_ms = transit;
    }
    state.rx_target_delay_ms = compute_rx_target_delay_ms();
    state.rx_delta_recv_packets += 1;
    state.rx_data_pkts_sec += 1;
  }

  // Compute forward distance from expected seq in uint32 space.
  function seq_forward_distance(seq, expected) {
    return seq - expected >>> 0;
  }

  // 记录Burst Loss。
  function note_burst_loss(lost_count) {
    if (lost_count <= 0) {
      return;
    }
    state.rx_loss_burst_current += lost_count;
    state.rx_loss_burst_max = Math.max(state.rx_loss_burst_max, state.rx_loss_burst_current);
  }

  // 记录Burst Receive。
  function note_burst_receive() {
    state.rx_loss_burst_current = 0;
  }

  // 计算Rx Target Delay Ms。
  function compute_rx_target_delay_ms() {
    const reorder_penalty_ms = Math.round(get_current_out_of_order_rate() * 220);
    const drop_penalty_ms = Math.min(54, state.rx_drop_deadline_sec * RX_TARGET_DELAY_DROP_PENALTY_MS);
    const missing_penalty_ms = Math.min(46, state.rx_missing_on_deadline_pkts_sec * RX_TARGET_DELAY_MISSING_PKT_PENALTY_MS);
    const nack_round_penalty_ms = Math.min(40, state.rx_nack_skipped_rounds_sec * RX_TARGET_DELAY_NACK_ROUND_PENALTY_MS);
    const floor_ms = state.bad_link_mode ? RX_TARGET_DELAY_BAD_LINK_FLOOR_MS : RX_TARGET_DELAY_FLOOR_MS;
    const bad_link_penalty_ms = state.bad_link_mode ? BAD_LINK_EXTRA_TARGET_DELAY_MS : 0;
    return clamp(Math.round(JITTER_MIN_MS + state.rx_jitter_ms + reorder_penalty_ms + drop_penalty_ms + missing_penalty_ms + nack_round_penalty_ms + bad_link_penalty_ms), Math.max(JITTER_MIN_MS, floor_ms), JITTER_MAX_MS);
  }

  // 获取Rx Frame Base Delay Ms。
  function is_rx_bad_path() {
    return state.bad_link_mode || state.libzt_route_status === "RELAY";
  }

  function get_rx_frame_hard_deadline_ms(is_keyframe) {
    if (is_rx_bad_path()) {
      return is_keyframe
        ? RX_FRAME_HARD_DEADLINE_BAD_LINK_KEYFRAME_MS
        : RX_FRAME_HARD_DEADLINE_BAD_LINK_DELTA_MS;
    }
    return is_keyframe
      ? RX_FRAME_HARD_DEADLINE_KEYFRAME_MS
      : RX_FRAME_HARD_DEADLINE_DELTA_MS;
  }

  function get_rx_repair_budget_ms() {
    if (state.cc.rttMs > 0) {
      const scale = is_rx_bad_path() ? 1.5 : 1.3;
      const safety_ms = is_rx_bad_path() ? 30 : 15;
      return Math.round(state.cc.rttMs * scale + safety_ms);
    }
    if (is_rx_bad_path()) {
      return Math.max(NACK_UNKNOWN_RTT_MS + 20, Math.round(state.rx_target_delay_ms * 0.45));
    }
    return Math.max(NACK_UNKNOWN_RTT_MS + 5, Math.round(state.rx_target_delay_ms * 0.3));
  }

  function get_rx_repair_slack_ms(is_keyframe) {
    if (is_rx_bad_path()) {
      return is_keyframe
        ? RX_REPAIR_SLACK_BAD_LINK_KEYFRAME_MS
        : RX_REPAIR_SLACK_BAD_LINK_MS;
    }
    return is_keyframe
      ? RX_REPAIR_SLACK_KEYFRAME_MS
      : RX_REPAIR_SLACK_MS;
  }

  function get_rx_frame_base_delay_ms() {
    const drop_safety_ms = Math.min(90, state.rx_drop_deadline_sec * 6);
    const missing_safety_ms = Math.min(80, state.rx_missing_on_deadline_pkts_sec);
    return state.rx_target_delay_ms + RX_DEADLINE_SAFETY_MS + (state.bad_link_mode ? BAD_LINK_EXTRA_DEADLINE_MS : 0) + drop_safety_ms + missing_safety_ms;
  }

  function get_signed_timestamp_delta_ms(target_ts, base_ts) {
    let delta = (target_ts >>> 0) - (base_ts >>> 0);
    if (delta > 0x7fffffff) {
      delta -= 0x100000000;
    } else if (delta < -0x7fffffff) {
      delta += 0x100000000;
    }
    return delta;
  }

  function get_frame_fallback_expected_play_at(frame_state) {
    const base_delay = get_rx_frame_base_delay_ms();
    const arrival_bonus = Math.min(RX_DEADLINE_MAX_BONUS_MS, frame_state.arrivalCount * RX_DEADLINE_BONUS_PER_PKT_MS);
    return frame_state.firstSeenAt + base_delay + arrival_bonus;
  }

  function compute_frame_expected_play_at(frame_state) {
    const fallback_expected_play_at = get_frame_fallback_expected_play_at(frame_state);
    if (state.rx_play_clock_wall_ms <= 0) {
      return fallback_expected_play_at;
    }
    const media_delta_ms = get_signed_timestamp_delta_ms(frame_state.timestampMs >>> 0, state.rx_play_clock_media_ts_ms >>> 0);
    if (Math.abs(media_delta_ms) > 5000) {
      return fallback_expected_play_at;
    }
    const clock_expected_play_at = state.rx_play_clock_wall_ms + media_delta_ms;
    if (!Number.isFinite(clock_expected_play_at)) {
      return fallback_expected_play_at;
    }
    return clock_expected_play_at;
  }

  function get_frame_repair_cutoff_at(frame_state) {
    return frame_state.expectedPlayAt + get_rx_repair_slack_ms(frame_state.isKeyframe);
  }

  function get_rx_post_cutoff_grace_ms(is_keyframe, repair_budget_ms) {
    const fallback_grace_ms = is_rx_bad_path() ? is_keyframe ? 220 : 120 : is_keyframe ? 140 : 90;
    return Math.max(fallback_grace_ms, Math.round(repair_budget_ms * (is_keyframe ? 1.1 : 0.8)));
  }

  // 判断是否需要Request Recovery Keyframe。
  function should_request_recovery_keyframe(now) {
    const since_last_assembled = state.rx_last_frame_assembled_at > 0 ? now - state.rx_last_frame_assembled_at : Number.POSITIVE_INFINITY;
    return state.rx_completed_frames.size === 0 && since_last_assembled >= Math.max(PLI_TIMEOUT_MS + get_adaptive_reorder_hold_ms(), 1400);
  }

  // 判断是否需要Enter Hard Keyframe Recovery。
  function should_enter_hard_keyframe_recovery(now) {
    const since_last_assembled = state.rx_last_frame_assembled_at > 0 ? now - state.rx_last_frame_assembled_at : Number.POSITIVE_INFINITY;
    return state.rx_completed_frames.size === 0 && since_last_assembled >= Math.max(PLI_TIMEOUT_MS * 2 + get_adaptive_reorder_hold_ms(), 2400);
  }

  // 判断是否需要Recover For Decode Output Stall。
  function should_recover_for_decode_output_stall(now) {
    const last_output_base = state.rx_last_decode_output_at || state.rx_start_at;
    const since_last_output = last_output_base > 0 ? now - last_output_base : Number.POSITIVE_INFINITY;
    const since_last_decode_input = state.rx_last_decode_input_at > 0 ? now - state.rx_last_decode_input_at : Number.POSITIVE_INFINITY;
    return state.rx_completed_frames.size > 0 && state.rx_last_decode_input_at > state.rx_last_decode_output_at && since_last_output >= Math.max(PLI_TIMEOUT_MS + get_adaptive_reorder_hold_ms(), 1200) && since_last_decode_input <= Math.max(get_adaptive_reorder_hold_ms(), 500);
  }

  // Refresh per-frame playback timing whenever a new packet for that frame arrives.
  function refresh_frame_timing(frame_state, now) {
    frame_state.lastPacketAt = now;
    frame_state.expectedPlayAt = compute_frame_expected_play_at(frame_state);
    const next_hard_deadline = frame_state.firstSeenAt + get_rx_frame_hard_deadline_ms(frame_state.isKeyframe);
    frame_state.hardDeadlineAt = Math.max(frame_state.hardDeadlineAt, next_hard_deadline);
  }

  function mark_frame_repair_cutoff(frame_id, frame_state, now, missing_count, repair_budget_ms, reason, metric = "rtt") {
    if (!frame_state.repairCutoffReached) {
      frame_state.repairCutoffReached = true;
      frame_state.repairCutoffAt = now;
      if (metric === "missing") {
        state.rx_nack_skipped_missing_sec += missing_count;
      } else if (metric === "rounds") {
        state.rx_nack_skipped_rounds_sec += 1;
      } else {
        state.rx_nack_skipped_rtt_sec += missing_count;
      }
      frame_state.hardDeadlineAt = Math.min(frame_state.hardDeadlineAt, now + get_rx_post_cutoff_grace_ms(frame_state.isKeyframe, repair_budget_ms));
    }
    if (frame_state.recoveryRequestedAt > 0) {
      return;
    }
    frame_state.recoveryRequestedAt = now;
    if (frame_state.isKeyframe) {
      if (should_enter_hard_keyframe_recovery(now)) {
        enter_keyframe_recovery();
      } else if (should_request_recovery_keyframe(now)) {
        request_recovery_keyframe();
      }
      send_pli().catch(error => log(`send ${reason} keyframe PLI failed`, error, 0));
      return;
    }
    if (should_request_recovery_keyframe(now)) {
      request_recovery_keyframe();
    }
    send_pli().catch(error => log(`send ${reason} delta PLI failed`, error, 0));
  }

  function get_missing_run_length(frame_state, packet_id) {
    let run_start = packet_id;
    while (run_start > 0 && !frame_state.packets.has(run_start - 1)) {
      run_start -= 1;
    }
    let run_end = packet_id;
    while (run_end + 1 < frame_state.packetCount && !frame_state.packets.has(run_end + 1)) {
      run_end += 1;
    }
    return run_end - run_start + 1;
  }

  function get_nack_trigger_delay_ms(frame_state, packet_id) {
    const missing_run_length = get_missing_run_length(frame_state, packet_id);
    if (missing_run_length >= NACK_GAP_IMMEDIATE_RUN_THRESHOLD) {
      return 0;
    }
    const has_prev = packet_id > 0 && frame_state.packets.has(packet_id - 1);
    const has_next = packet_id + 1 < frame_state.packetCount && frame_state.packets.has(packet_id + 1);
    const has_next2 = packet_id + 2 < frame_state.packetCount && frame_state.packets.has(packet_id + 2);
    if ((has_prev && has_next) || (has_next && has_next2) || (has_prev && has_next2)) {
      return NACK_GAP_DELAY_STRONG_MS;
    }
    if (has_prev || has_next || has_next2) {
      return NACK_GAP_DELAY_WEAK_MS;
    }
    return Number.POSITIVE_INFINITY;
  }

  function get_rx_global_nack_packet_budget() {
    return is_rx_bad_path()
      ? RX_GLOBAL_NACK_BAD_LINK_PACKET_BUDGET
      : RX_GLOBAL_NACK_PACKET_BUDGET;
  }

  function get_rx_global_nack_frame_budget() {
    return is_rx_bad_path()
      ? RX_GLOBAL_NACK_BAD_LINK_FRAME_BUDGET
      : RX_GLOBAL_NACK_FRAME_BUDGET;
  }

  function can_schedule_global_nack(frame_id) {
    if (state.rx_nack_enqueued_sec >= get_rx_global_nack_packet_budget()) {
      return false;
    }
    if (state.rx_nack_budget_active_frames.has(frame_id)) {
      return true;
    }
    return state.rx_nack_budget_active_frames.size < get_rx_global_nack_frame_budget();
  }

  // 处理 request Recovery Keyframe 相关逻辑。
  function request_recovery_keyframe() {
    if (state.rx_need_keyframe) {
      return;
    }
    state.rx_need_keyframe = true;
    state.rx_decoder_awaiting_output = false;
    if (state.rx_next_decode_frame_id == null) {
      return;
    }
    const next_frame = state.rx_completed_frames.get(state.rx_next_decode_frame_id);
    if (next_frame?.isKeyframe) {
      return;
    }
    for (const [frame_id, completed_frame] of state.rx_completed_frames) {
      if (frame_id >= state.rx_next_decode_frame_id && completed_frame.isKeyframe) {
        state.rx_next_decode_frame_id = frame_id;
        return;
      }
    }
  }

  // 处理 enter Keyframe Recovery 相关逻辑。
  function enter_keyframe_recovery() {
    state.rx_need_keyframe = true;
    state.rx_decoder_awaiting_output = false;
    state.rx_next_decode_frame_id = null;
    state.rx_completed_frames.clear();
    reset_decode_wait_state();
  }

  // Track receive failures and only enter keyframe recovery after consecutive drops.
  function note_rx_frame_drop(now) {
    if (now - state.rx_last_drop_at > RX_NEED_KEYFRAME_DROP_WINDOW_MS) {
      state.rx_consecutive_drop_frames = 0;
    }
    state.rx_consecutive_drop_frames += 1;
    state.rx_last_drop_at = now;
    if (state.rx_consecutive_drop_frames >= RX_NEED_KEYFRAME_DROP_THRESHOLD && should_request_recovery_keyframe(now)) {
      request_recovery_keyframe();
    }
  }

  // Request a keyframe if no complete frame has arrived for too long.
  function maybe_request_pli_for_stall(now) {
    const base_ts = state.rx_last_decode_output_at || state.rx_start_at;
    const out_of_order_rate = get_current_out_of_order_rate();
    const reorder_hold_ms = get_adaptive_reorder_hold_ms();
    const adaptive_pli_timeout_ms = Math.round(PLI_TIMEOUT_MS + reorder_hold_ms + (out_of_order_rate >= 0.08 ? 320 : out_of_order_rate >= 0.04 ? 180 : 80));
    if (state.role !== "viewer" || !state.start_requested || base_ts <= 0 || now - base_ts <= adaptive_pli_timeout_ms) {
      return;
    }
    if (out_of_order_rate >= 0.04 && state.rx_reorder_pending.size > 0) {
      return;
    }
    if (now - state.rx_pli_last_sent_at < PLI_MIN_INTERVAL_MS) {
      return;
    }
    if (should_recover_for_decode_output_stall(now)) {
      enter_keyframe_recovery();
    } else {
      request_recovery_keyframe();
    }
    send_pli().catch(error => log("send pli failed", error, 0));
  }

  // Flush pending packets that have become contiguous in seq order.
  function flush_contiguous_pending_packets() {
    const ready = [];
    while (state.rx_expected_seq != null) {
      const queued = state.rx_reorder_pending.get(state.rx_expected_seq);
      if (!queued) {
        break;
      }
      state.rx_reorder_pending.delete(state.rx_expected_seq);
      ready.push(queued.packet);
      state.rx_expected_seq = state.rx_expected_seq + 1 >>> 0;
    }
    return ready;
  }

  // Advance expected seq after reorder timeout to avoid stalling on a single missing packet.
  function promote_pending_packet_after_timeout(now, force = false) {
    if (state.rx_expected_seq == null || state.rx_reorder_pending.size === 0) {
      return [];
    }
    let candidate = null;
    for (const [seq, item] of state.rx_reorder_pending.entries()) {
      const gap = seq_forward_distance(seq, state.rx_expected_seq);
      if (gap === 0 || gap >= 0x80000000) {
        continue;
      }
      if (!candidate || gap < candidate.gap || gap === candidate.gap && item.arrivalAt < candidate.arrivalAt) {
        candidate = {
          seq,
          gap,
          arrivalAt: item.arrivalAt
        };
      }
    }
    if (!candidate) {
      return [];
    }
    if (!force) {
      const age_ms = now - candidate.arrivalAt;
      if (age_ms < get_adaptive_reorder_hold_ms()) {
        return [];
      }
    }
    state.rx_delta_lost_packets += candidate.gap;
    note_burst_loss(candidate.gap);
    state.rx_expected_seq = candidate.seq;
    return flush_contiguous_pending_packets();
  }

  // Reorder by seq and return packets that are ready for frame reassembly.
  function pop_ready_packets_by_seq(packet, now) {
    if (state.rx_expected_seq == null) {
      state.rx_expected_seq = packet.seq;
    }
    const gap = seq_forward_distance(packet.seq, state.rx_expected_seq);
    if (gap === 0) {
      note_burst_receive();
      state.rx_expected_seq = state.rx_expected_seq + 1 >>> 0;
      return [packet, ...flush_contiguous_pending_packets()];
    }
    if (gap < 0x80000000) {
      if (gap > get_adaptive_reorder_gap_threshold()) {
        if (!state.rx_reorder_pending.has(packet.seq)) {
          state.rx_reorder_pending.set(packet.seq, {
            packet,
            arrivalAt: now
          });
        }
        if (state.rx_reorder_pending.size > RX_SEQ_REORDER_MAX_PENDING) {
          return promote_pending_packet_after_timeout(now, true);
        }
        return promote_pending_packet_after_timeout(now, false);
      }
      state.rx_delta_lost_packets += gap;
      note_burst_loss(gap);
      state.rx_expected_seq = packet.seq + 1 >>> 0;
      return [packet, ...flush_contiguous_pending_packets()];
    }
    state.rx_out_of_order_pkts_sec += 1;
    return [packet];
  }

  // Ingest ordered packets into frame buffer and try assembly.
  async function ingest_ordered_data_packet(packet, now) {
    prune_expired_frame_marks(now);
    const frame_id = packet.frameId;
    const expired_at = state.rx_expired_frames.get(frame_id);
    if (expired_at && expired_at > now) {
      state.rx_late_after_deadline_pkts_sec += 1;
      return;
    }
    let frame_state = state.rx_frame_buffer.get(frame_id);
    if (!frame_state) {
        frame_state = {
          codecKey: parse_codec_key_from_flags(packet.flags),
          isKeyframe: Boolean(packet.flags & FLAG_KEYFRAME),
          packetCount: packet.packetCount,
          frameSize: packet.aux,
          timestampMs: packet.timestampMs,
          firstSeenAt: now,
          expectedPlayAt: now + get_rx_frame_base_delay_ms(),
          hardDeadlineAt: now + get_rx_frame_hard_deadline_ms(Boolean(packet.flags & FLAG_KEYFRAME)),
          lastPacketAt: now,
          arrivalCount: 0,
          packets: new Map(),
          fecPackets: new Map(),
          fecShardSize: 0,
          fecParityCount: 0,
          nackMeta: new Map(),
          graceExtended: false,
          repairCutoffReached: false,
          repairCutoffAt: 0,
          recoveryRequestedAt: 0
      };
      state.rx_frame_buffer.set(frame_id, frame_state);
    } else {
      frame_state.codecKey = parse_codec_key_from_flags(packet.flags);
      frame_state.isKeyframe = frame_state.isKeyframe || Boolean(packet.flags & FLAG_KEYFRAME);
      frame_state.packetCount = Math.max(frame_state.packetCount, packet.packetCount);
      frame_state.frameSize = Math.max(frame_state.frameSize, packet.aux);
    }
    if (packet.flags & FLAG_FEC) {
      const shard_size = packet.aux2 >>> 16 & 0xffff;
      const parity_count = packet.aux2 & 0xffff;
      frame_state.fecShardSize = Math.max(frame_state.fecShardSize, shard_size);
      frame_state.fecParityCount = Math.max(frame_state.fecParityCount, parity_count);
      if (!frame_state.fecPackets.has(packet.packetId)) {
        frame_state.fecPackets.set(packet.packetId, packet.payload);
        frame_state.arrivalCount += 1;
        refresh_frame_timing(frame_state, now);
      }
    } else if (!frame_state.packets.has(packet.packetId)) {
      frame_state.packets.set(packet.packetId, packet.payload);
      frame_state.arrivalCount += 1;
      refresh_frame_timing(frame_state, now);
    }
    await try_assemble_frame(frame_id);
  }

  // Handle DATA packets.
  async function handle_data_packet(packet) {
    const now = Date.now();
    update_rx_transit_stats(packet);
    const ready_packets = pop_ready_packets_by_seq(packet, now);
    for (const ready_packet of ready_packets) {
      await ingest_ordered_data_packet(ready_packet, now);
    }
  }

  // Handle FEEDBACK_REQ packets.
  async function handle_feedback_req_packet(packet) {
    const probe_id = parse_cc_probe_id(packet.payload);
    if (probe_id == null) {
      return;
    }
    await send_feedback(packet.timestampMs >>> 0, probe_id);
  }

  // Handle FEEDBACK packets and update congestion control.
  function handle_feedback_packet(packet) {
    const now_wall_ms = Date.now();
    const now = now_wall_ms & 0xffffffff;
    const echoed = packet.aux >>> 0;
    const {
      burstLevel: burst_level,
      probeId: probe_id
    } = parse_feedback_payload(packet.payload);
    if (!state.awaiting_cc_probe || probe_id == null || probe_id !== state.last_cc_probe_id || echoed !== state.last_cc_req_ts) {
      return;
    }
    const age_ms = now_wall_ms - state.last_cc_req_wall_ms;
    if (age_ms < 0 || age_ms > CC_PROBE_TIMEOUT_MS) {
      state.awaiting_cc_probe = false;
      return;
    }
    let rtt = now - echoed;
    if (rtt < 0) {
      rtt += 0xffffffff;
    }
    rtt = clamp(rtt, 1, CC_PROBE_TIMEOUT_MS);
    state.awaiting_cc_probe = false;
    state.cc.rttMs = rtt;
    state.cc.minRttMs = update_min_rtt_window(rtt, now_wall_ms);
    state.cc.queueDelayMs = Math.max(0, rtt - state.cc.minRttMs);
    const jitter_ms = packet.aux2 & 0xffff;
    const loss_permille = packet.aux2 >>> 16 & 0xffff;
    state.cc.lossPermille = loss_permille;
    adapt_fec_rate_with_hysteresis(loss_permille, burst_level, jitter_ms);
    const policy = sync_send_vbv({
      queueDelayMs: state.cc.queueDelayMs,
      lossPermille: loss_permille,
      jitterMs: jitter_ms,
      burstLevel: burst_level
    });
    const policy_fec_ceil = state.bad_link_mode ? Math.max(policy.fecFloor, FEC_MAX_RATE) : Math.max(policy.fecFloor, FEC_MIN_RATE + 0.08);
    state.cc.currentFecRate = clamp(state.cc.currentFecRate, policy.fecFloor, policy_fec_ceil);
    if (state.encoder_configured) {
      ensure_encoder().catch(error => log("encoder VBV reconfigure failed", error, 0));
    }
  }

  // Handle NACK packets.
  async function handle_nack_packet(packet) {
    if (state.role !== "share") {
      return;
    }
    state.nack_rx_sec += 1;
    await try_retransmit_packet(packet.frameId, packet.packetId, packet.aux >>> 0);
  }

  // Handle PLI packets.
  function handle_pli_packet() {
    if (state.role !== "share") {
      return;
    }
    const now = Date.now();
    push_metric_ts(state.pli_rx_ts, now, 60_000);
    if (now - state.last_keyframe_at < MIN_KEYFRAME_GAP_MS) {
      return;
    }
    state.force_next_keyframe = true;
  }

  // Dispatch an incoming media packet by kind.
  function handle_incoming_media_packet(bytes) {
    state.rx_pkts_sec += 1;
    state.rx_bytes_sec += bytes.byteLength;
    const packet = parse_packet(bytes);
    if (!packet) {
      return;
    }
    if (packet.kind === PKT_KIND_DATA) {
      if (state.rx_first_media_packet_at <= 0) {
        state.rx_first_media_packet_at = Date.now();
      }
      handle_data_packet(packet).catch(error => log("handle data packet failed", error, 0));
      return;
    }
    if (packet.kind === PKT_KIND_FEEDBACK_REQ) {
      handle_feedback_req_packet(packet).catch(error => log("handle feedback req failed", error, 0));
      return;
    }
    if (packet.kind === PKT_KIND_FEEDBACK) {
      try {
        handle_feedback_packet(packet);
      } catch (error) {
        log("handle feedback failed", error, 0);
      }
      return;
    }
    if (packet.kind === PKT_KIND_NACK) {
      handle_nack_packet(packet).catch(error => log("handle nack failed", error, 0));
      return;
    }
    if (packet.kind === PKT_KIND_PLI) {
      try {
        handle_pli_packet(packet);
      } catch (error) {
        log("handle pli failed", error, 0);
      }
    }
  }

  // Check receiver health and drive NACK/PLI/deadline drops.
  function check_rx_health() {
    const now = Date.now();
    evaluate_bad_link_mode(now);
    if (should_recover_for_decode_output_stall(now)) {
      enter_keyframe_recovery();
      send_pli().catch(error => log("send stalled-output PLI failed", error, 0));
    }
    const promoted_packets = promote_pending_packet_after_timeout(now, false);
    for (const packet of promoted_packets) {
      ingest_ordered_data_packet(packet, now).catch(error => {
        log("handle reordered packet failed", error, 0);
      });
    }
    for (const [frame_id, frame_state] of state.rx_frame_buffer.entries()) {
      const is_complete = frame_state.packets.size === frame_state.packetCount;
      if (is_complete) {
        continue;
      }
      const missing_count = frame_state.packetCount - frame_state.packets.size;
      if (missing_count <= 0) {
        continue;
      }
      if (now > frame_state.hardDeadlineAt) {
        state.rx_drop_deadline_sec += 1;
        state.rx_expired_frames_sec += 1;
        state.rx_missing_on_deadline_pkts_sec += Math.max(0, missing_count);
        note_rx_frame_drop(now);
        mark_frame_expired_by_deadline(frame_id, now);
        state.rx_frame_buffer.delete(frame_id);
        flush_completed_frames().catch(error => {
          log("flush completed frames after deadline failed", error, 0);
        });
        continue;
      }
      frame_state.expectedPlayAt = compute_frame_expected_play_at(frame_state);
      const estimated_rtt = get_rx_repair_budget_ms();
      const repair_cutoff_at = get_frame_repair_cutoff_at(frame_state);
      const remain_to_repair_cutoff_ms = repair_cutoff_at - now;
      if (frame_state.repairCutoffReached) {
        continue;
      }
      if (frame_state.isKeyframe) {
        const out_of_order_rate = get_current_out_of_order_rate();
        if (out_of_order_rate >= 0.05 && state.rx_reorder_pending.size > 0 && remain_to_repair_cutoff_ms > get_adaptive_reorder_hold_ms()) {
          continue;
        }
        if (missing_count > NACK_KEYFRAME_MAX_MISSING && frame_state.fecPackets.size < Math.min(4, missing_count)) {
          mark_frame_repair_cutoff(frame_id, frame_state, now, missing_count, estimated_rtt, "keyframe-cutoff");
          continue;
        }
      }
      if (remain_to_repair_cutoff_ms <= estimated_rtt) {
        mark_frame_repair_cutoff(frame_id, frame_state, now, missing_count, estimated_rtt, "late-frame");
        continue;
      }
      if (!frame_state.isKeyframe && missing_count > DELTA_NACK_MAX_MISSING) {
        mark_frame_repair_cutoff(frame_id, frame_state, now, missing_count, estimated_rtt, "delta-recovery", "missing");
        continue;
      }
      let frame_nack_budget = frame_state.isKeyframe ? Number.MAX_SAFE_INTEGER : DELTA_NACK_MAX_PER_FRAME;
      let frame_hit_round_limit = false;
      let frame_participated_in_nack = false;
      for (let i = 0; i < frame_state.packetCount; i += 1) {
        if (frame_state.packets.has(i)) {
          continue;
        }
        frame_participated_in_nack = true;
        if (frame_nack_budget <= 0) {
          break;
        }
        const remain = repair_cutoff_at - now;
        const remain_guard_ms = frame_state.isKeyframe ? 0 : DELTA_NACK_REMAIN_GUARD_MS;
        if (remain <= estimated_rtt + remain_guard_ms) {
          mark_frame_repair_cutoff(frame_id, frame_state, now, missing_count, estimated_rtt, "late-packet");
          break;
        }
        const nack_info = frame_state.nackMeta.get(i) || {
          attempts: 0,
          lastSentAt: 0,
          missingSince: now
        };
        if (!Number.isFinite(nack_info.missingSince) || nack_info.missingSince <= 0) {
          nack_info.missingSince = now;
        }
        const nack_trigger_delay_ms = get_nack_trigger_delay_ms(frame_state, i);
        if (!Number.isFinite(nack_trigger_delay_ms)) {
          frame_state.nackMeta.set(i, nack_info);
          continue;
        }
        if (nack_info.attempts === 0 && now - nack_info.missingSince < nack_trigger_delay_ms) {
          frame_state.nackMeta.set(i, nack_info);
          continue;
        }
        const max_rounds = frame_state.isKeyframe ? NACK_KEYFRAME_MAX_ROUNDS : DELTA_NACK_MAX_ROUNDS;
        if (nack_info.attempts >= max_rounds) {
          frame_hit_round_limit = true;
          break;
        }
        if (now - nack_info.lastSentAt < NACK_RETRY_MIN_INTERVAL_MS) {
          frame_state.nackMeta.set(i, nack_info);
          continue;
        }
        if (!can_schedule_global_nack(frame_id)) {
          frame_state.nackMeta.set(i, nack_info);
          break;
        }
        nack_info.attempts += 1;
        nack_info.lastSentAt = now;
        frame_state.nackMeta.set(i, nack_info);
        if (enqueue_nack(frame_id, i, repair_cutoff_at)) {
          state.rx_nack_budget_active_frames.add(frame_id);
        }
        frame_nack_budget -= 1;
      }
      if (frame_participated_in_nack) {
        state.rx_nack_active_frames_sec += 1;
      }
      if (frame_hit_round_limit) {
        mark_frame_repair_cutoff(frame_id, frame_state, now, missing_count, estimated_rtt, "round-limit", "rounds");
      }
    }
    maybe_request_pli_for_stall(now);
    evaluate_bad_link_mode(now);
  }

  // Initialize the screen-share capture stream.
  async function ensure_share_stream() {
    if (state.local_stream) {
      return;
    }
    const {
      profile
    } = get_active_send_policy();
    const max_capture_fps = DIRECT_MAX_FPS;
    state.local_stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: {
          ideal: profile.width,
          max: profile.width
        },
        height: {
          ideal: profile.height,
          max: profile.height
        },
        frameRate: {
          ideal: max_capture_fps,
          max: max_capture_fps
        }
      },
      audio: false
    });
    const track = state.local_stream.getVideoTracks()[0];
    if (!track) {
      throw new Error("屏幕共享没有视频轨道");
    }
    track.contentHint = "detail";
    // 处理 onended 相关逻辑。
    track.onended = () => {
      log("screen share ended");
      state.start_requested = false;
      if (state.signal_connected) {
        invoke("zt_signal_send", {
          payload: JSON.stringify({
            type: "share-ended",
            role: "share",
            target: state.peer_target_id || undefined,
            ts: Date.now(),
            client_id: state.client_id,
            session_id: state.session_id || undefined
          })
        }).catch(error => log("send share-ended failed", error, 0));
      }
      stop_share_pipeline().catch(error => log("stop share pipeline failed", error, 0));
    };
    ui.local_video.srcObject = state.local_stream;
    update_merged_video_view();
  }

  // Start the share encode/send pipeline.
  async function start_share_pipeline() {
    await ensure_share_stream();
    await ensure_encoder();
    const started_by_track = await start_track_processor_capture_loop();
    if (!started_by_track) {
      start_timer_capture_loop();
    }
  }

  // 停止Share Pipeline。
  async function stop_share_pipeline() {
    await close_encoder();
    if (state.local_stream) {
      state.local_stream.getTracks().forEach(track => track.stop());
      state.local_stream = null;
    }
    state.capture_busy = false;
    state.last_capture_at = 0;
    ui.local_video.srcObject = null;
  }

  // Stop the viewer-side decode pipeline.
  function stop_viewer_pipeline() {
    stop_bad_link_signal_heartbeat();
    close_decoder();
    const canvas = ui.remote_canvas;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width || 1, canvas.height || 1);
    state.rx_last_complete_frame_at = 0;
    state.rx_last_frame_assembled_at = 0;
    state.rx_last_complete_frame_id = 0;
    state.rx_need_keyframe = true;
    state.rx_decoder_awaiting_output = false;
    state.rx_first_media_packet_at = 0;
    state.rx_start_at = 0;
    state.rx_last_decode_input_at = 0;
    state.rx_last_decode_output_at = 0;
    state.rx_play_clock_wall_ms = 0;
    state.rx_play_clock_media_ts_ms = 0;
    state.rx_frame_buffer.clear();
    state.rx_completed_frames.clear();
    state.rx_consecutive_drop_frames = 0;
    state.rx_last_drop_at = 0;
    state.rx_next_decode_frame_id = null;
    reset_decode_wait_state();
    state.rx_decode_flush_busy = false;
    state.rx_expected_seq = null;
    state.rx_reorder_pending.clear();
    state.bad_link_mode = false;
    state.bad_link_until = 0;
    state.bad_link_last_trigger_at = 0;
    state.bad_link_last_reason = "";
    state.bad_link_trigger_streak = 0;
    state.bad_link_trigger_reason = "";
    state.bad_link_signal_state = "";
  }

  // Start the congestion-control probe timer.
  function start_cc_timer() {
    if (state.cc_timer) {
      return;
    }
    state.cc_timer = setInterval(() => {
      send_feedback_req().catch(error => log("send feedback req failed", error, 0));
    }, CC_INTERVAL_MS);
  }

  // Stop the congestion-control probe timer.
  function stop_cc_timer() {
    if (state.cc_timer) {
      clearInterval(state.cc_timer);
      state.cc_timer = null;
    }
  }

  // Reset congestion-control runtime state between sessions.
  function reset_cc_runtime() {
    stop_bad_link_signal_heartbeat();
    state.last_cc_req_ts = 0;
    state.last_cc_req_wall_ms = 0;
    state.last_cc_probe_id = 0;
    state.awaiting_cc_probe = false;
    state.cc.minRttMs = Infinity;
    state.cc.rttMs = 0;
    state.cc.queueDelayMs = 0;
    state.cc.lossPermille = 0;
    state.cc.rttSamples = [];
    state.cc.currentFecRate = FEC_MIN_RATE;
    state.cc.vbvTargetBps = 2_000_000;
    state.cc.vbvBucketCapacityBits = 800_000;
    state.cc.vbvTokensBits = 800_000;
    state.cc.vbvDebtFloorBits = -280_000;
    state.cc.vbvPendingBits = 0;
    state.cc.vbvReservationQueue = [];
    state.cc.vbvEncoderBitrateBps = 2_000_000;
    state.cc.vbvMaxFrameBytes = 180_000;
    state.cc.vbvLastRefillAt = 0;
    state.cc.vbvMotionBudgetScale = 1;
    state.cc.activeProfileKey = "";
    state.cc.activeEncoderConfigKey = "";
    state.cc.activeEncoderBitrateBucketBps = 0;
    state.cc.lastPolicyLogKey = "";
    state.cc.lastPolicySwitchAt = 0;
    state.cc.lastEncoderReconfigureAt = 0;
    state.cc.fecLastAdjustAt = Date.now();
    state.bad_link_mode = false;
    state.bad_link_until = 0;
    state.bad_link_last_trigger_at = 0;
    state.bad_link_last_reason = "";
    state.bad_link_trigger_streak = 0;
    state.bad_link_trigger_reason = "";
    state.bad_link_signal_state = "";
    state.capture_motion_level = "high";
    state.capture_motion_score = 255;
    state.capture_motion_prev_luma = null;
  }

  // Handle signaling business messages.

  return {
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
    handle_incoming_media_packet
  };
}
export { create_media_module };
