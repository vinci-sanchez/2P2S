#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::{env, path::Path};

use tauri::Manager;

#[tauri::command]
fn append_log(app: tauri::AppHandle, message: String) -> Result<(), String> {
    let log_dir = resolve_log_dir(&app)?;
    let log_path = log_dir.join("frontend.log");

    if let Err(err) = ensure_log_dir(&log_dir) {
        return fallback_log(&app, &message, &err);
    }

    if let Err(err) = write_log_line(&log_path, &message) {
        return fallback_log(&app, &message, &err);
    }
    Ok(())
}

#[tauri::command]
fn open_log_dir(app: tauri::AppHandle) -> Result<(), String> {
    let log_dir = resolve_log_dir(&app)?;
    if ensure_log_dir(&log_dir).is_err() {
        let fallback_dir = fallback_dir(&app)?;
        ensure_log_dir(&fallback_dir).map_err(|e| format!("create log dir: {e}"))?;
  tauri::api::shell::open(&app.shell_scope(), fallback_dir.to_string_lossy(), None)
            .map_err(|e| format!("open log dir: {e}"))?;
        return Ok(());
    }

    tauri::api::shell::open(&app.shell_scope(), log_dir.to_string_lossy(), None)
        .map_err(|e| format!("open log dir: {e}"))?;
    Ok(())
}

fn resolve_log_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(custom) = env::var("FRONTEND_LOG_DIR") {
        if !custom.trim().is_empty() {
            return Ok(PathBuf::from(custom));
        }
    }

    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    if let Some(app_root) = manifest_dir.parent() {
        if app_root.join("config.js").exists() {
            return Ok(app_root.join("logs"));
        }
    }

    if let Ok(exe_path) = env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            return Ok(exe_dir.join("logs"));
        }
    }

    let resolver = app.path_resolver();
    resolver
        .app_data_dir()
        .map(|dir| dir.join("logs"))
        .ok_or_else(|| "failed to resolve app data dir".to_string())
}

fn ensure_log_dir(dir: &Path) -> Result<(), String> {
    create_dir_all(dir).map_err(|e| e.to_string())
}

fn write_log_line(path: &Path, message: &str) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    writeln!(file, "{message}").map_err(|e| e.to_string())
}

fn fallback_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let resolver = app.path_resolver();
    resolver
        .app_data_dir()
        .map(|dir| dir.join("logs"))
        .ok_or_else(|| "failed to resolve app data dir".to_string())
}

fn fallback_log(app: &tauri::AppHandle, message: &str, err: &str) -> Result<(), String> {
    let fallback = fallback_dir(app)?;
    ensure_log_dir(&fallback).map_err(|e| format!("fallback create dir: {e}"))?;
    let log_path = fallback.join("frontend.log");
    write_log_line(&log_path, message)
        .map_err(|e| format!("fallback write log: {e}; original error: {err}"))
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![append_log, open_log_dir])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
