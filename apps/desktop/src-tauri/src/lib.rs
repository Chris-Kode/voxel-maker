use std::path::Path;
use tauri::Manager;

/// Minimum-allowlist project I/O (plan S6.18 seam, tickets #15/#22).
///
/// These commands are the ONLY native surface of the shell: the webview
/// never touches the filesystem directly. Paths arrive from the native
/// open/save dialogs; the Rust side still rejects empty, NUL-containing,
/// and relative paths before any filesystem call. The project lifecycle
/// ticket (#22) adds the adjacent recovery journal (read/append/replace/
/// remove) and the bounded recent-project store in the app config
/// directory. Lock handling remains a documented follow-up.

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AtomicWriteResult {
    temp_path: String,
    backup_created: bool,
    backup_path: Option<String>,
    directory_sync_succeeded: bool,
}

fn validate_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("project path is empty".to_string());
    }
    if path.as_bytes().contains(&0) {
        return Err("project path contains a NUL byte".to_string());
    }
    // Native dialogs always return absolute paths; relative paths are
    // rejected outright so the webview can never address files through
    // its own working directory. Scoped allowlists and canonicalization
    // arrive with the project lifecycle ticket (#22 / S6.18).
    if !Path::new(path).is_absolute() {
        return Err("project path must be absolute".to_string());
    }
    Ok(())
}

/// Reads a project file's bytes (the webview receives a copied buffer).
#[tauri::command]
fn read_project_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    validate_path(&path)?;
    let bytes = std::fs::read(&path).map_err(|error| error.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Atomically replaces a project file: write a same-directory temporary
/// file, preserve the previous destination as a `.bak` backup, then rename
/// over the destination and best-effort sync the parent directory. A
/// failure before the rename leaves destination and backup untouched.
#[tauri::command]
fn write_project_bytes_atomic(path: String, bytes: Vec<u8>) -> Result<AtomicWriteResult, String> {
    validate_path(&path)?;
    let destination = Path::new(&path);
    let parent = destination
        .parent()
        .ok_or_else(|| "project path has no parent directory".to_string())?;
    let file_name = destination
        .file_name()
        .ok_or_else(|| "project path has no file name".to_string())?;
    let file_name = file_name.to_string_lossy();
    let temp_path = parent.join(format!(".{file_name}.tmp"));
    std::fs::write(&temp_path, &bytes).map_err(|error| error.to_string())?;

    let mut backup_created = false;
    let backup_path;
    if destination.exists() {
        let backup = parent.join(format!(".{file_name}.bak"));
        std::fs::copy(destination, &backup).map_err(|error| error.to_string())?;
        backup_created = true;
        backup_path = Some(backup.to_string_lossy().into_owned());
    } else {
        backup_path = None;
    }

    std::fs::rename(&temp_path, destination).map_err(|error| error.to_string())?;
    // Best-effort durability: a failed sync weakens crash durability but
    // does not fail the save.
    let directory_sync_succeeded = std::fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .is_ok();

    Ok(AtomicWriteResult {
        temp_path: temp_path.to_string_lossy().into_owned(),
        backup_created,
        backup_path,
        directory_sync_succeeded,
    })
}

#[tauri::command]
fn project_exists(path: String) -> Result<bool, String> {
    validate_path(&path)?;
    Ok(Path::new(&path).exists())
}

#[tauri::command]
fn read_backup_bytes(path: String) -> Result<Option<Vec<u8>>, String> {
    validate_path(&path)?;
    match std::fs::read(format!("{path}.bak")) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn remove_project(path: String) -> Result<(), String> {
    validate_path(&path)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

/// Reads the adjacent recovery journal (`<path>.journal`); `None` when
/// absent (recovery data is never inside the `.vxl` container, ADR-0011).
#[tauri::command]
fn read_journal_bytes(path: String) -> Result<Option<Vec<u8>>, String> {
    validate_path(&path)?;
    match std::fs::read(format!("{path}.journal")) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

/// Appends bytes to the adjacent journal, creating it when absent, and
/// flushes before returning so a resolved append is durable.
#[tauri::command]
fn append_journal_bytes(path: String, bytes: Vec<u8>) -> Result<(), String> {
    validate_path(&path)?;
    let journal_path = format!("{path}.journal");
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&journal_path)
        .map_err(|error| error.to_string())?;
    std::io::Write::write_all(&mut file, &bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    Ok(())
}

/// Atomically replaces the adjacent journal (compaction and anchor reset):
/// same-directory temporary file, flush, rename, best-effort directory sync
/// — the same order as `write_project_bytes_atomic`, so journal replacement
/// can never cross a filesystem boundary or leave a temp file behind.
#[tauri::command]
fn replace_journal_bytes(path: String, bytes: Vec<u8>) -> Result<(), String> {
    validate_path(&path)?;
    let journal_path = format!("{path}.journal");
    let destination = Path::new(&journal_path);
    let parent = destination
        .parent()
        .ok_or_else(|| "journal path has no parent directory".to_string())?;
    let file_name = destination
        .file_name()
        .ok_or_else(|| "journal path has no file name".to_string())?
        .to_string_lossy()
        .into_owned();
    let temp_path = parent.join(format!(".{file_name}.tmp"));
    std::fs::write(&temp_path, &bytes).map_err(|error| error.to_string())?;
    let file = std::fs::File::open(&temp_path).and_then(|f| f.sync_all());
    if let Err(error) = file {
        let _ = std::fs::remove_file(&temp_path);
        return Err(error.to_string());
    }
    std::fs::rename(&temp_path, destination).map_err(|error| error.to_string())?;
    // Best-effort durability: a failed sync weakens crash durability but
    // does not fail the replacement.
    let _ = std::fs::File::open(parent).and_then(|directory| directory.sync_all());
    Ok(())
}

/// Removes the adjacent journal; a missing journal is not an error.
#[tauri::command]
fn remove_journal(path: String) -> Result<(), String> {
    validate_path(&path)?;
    match std::fs::remove_file(format!("{path}.journal")) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

/// Hard bound on the recent-project list (mirrors the webview bound).
const MAX_RECENT_PROJECTS: usize = 10;

/// Reads the bounded recent-project JSON from the app config directory.
#[tauri::command]
fn read_recent_projects(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = recent_projects_path(&app)?;
    match std::fs::read_to_string(&path) {
        Ok(json) => Ok(Some(json)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

/// Writes the bounded recent-project JSON to the app config directory.
/// The list is re-bounded and shape-checked on read, and the write is
/// atomic (same-directory temporary file + rename). The bound is enforced
/// here as well, so the webview can never grow the file past it.
#[tauri::command]
fn write_recent_projects(app: tauri::AppHandle, json: String) -> Result<(), String> {
    if json.len() > 1_000_000 {
        return Err("recent projects payload exceeds the size limit".to_string());
    }
    let bounded: serde_json::Value = serde_json::from_str(&json)
        .map_err(|error| format!("recent projects payload is not valid JSON: {error}"))?;
    let entries = match bounded {
        serde_json::Value::Array(entries) => entries,
        _ => return Err("recent projects payload must be a JSON array".to_string()),
    };
    let entries: Vec<serde_json::Value> = entries
        .into_iter()
        .filter(|entry| {
            entry
                .as_object()
                .map(|object| {
                    object
                        .get("path")
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|s| !s.is_empty())
                        && object
                            .get("title")
                            .and_then(serde_json::Value::as_str)
                            .is_some()
                        && object
                            .get("openedAt")
                            .and_then(serde_json::Value::as_f64)
                            .is_some_and(|n| n.is_finite())
                })
                .unwrap_or(false)
        })
        .take(MAX_RECENT_PROJECTS)
        .collect();
    let json = serde_json::to_string(&entries)
        .map_err(|error| format!("recent projects payload cannot be serialized: {error}"))?;
    let path = recent_projects_path(&app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "recent projects path has no parent".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| "recent projects path has no file name".to_string())?;
    let temp_path = parent.join(format!(".{file_name}.tmp"));
    std::fs::write(&temp_path, &json).map_err(|error| error.to_string())?;
    std::fs::rename(&temp_path, &path).map_err(|error| error.to_string())?;
    Ok(())
}

/// App-config-dir path of the recent-project store (scoped native storage).
fn recent_projects_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("recent-projects.json"))
        .map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_project_bytes,
            write_project_bytes_atomic,
            project_exists,
            read_backup_bytes,
            remove_project,
            read_journal_bytes,
            append_journal_bytes,
            replace_journal_bytes,
            remove_journal,
            read_recent_projects,
            write_recent_projects
        ])
        .run(tauri::generate_context!())
        .expect("error while running the voxel-maker desktop shell");
}
