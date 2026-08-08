use std::path::Path;

/// Minimum-allowlist project I/O (plan S6.18 seam, minimal for ticket #15).
///
/// These commands are the ONLY native surface of the shell: the webview
/// never touches the filesystem directly. Paths arrive from the native
/// open/save dialogs; the Rust side still rejects empty and NUL-containing
/// paths before any filesystem call. Full scoped-path validation, journal
/// recovery, and lock handling arrive with the project lifecycle ticket.

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
fn write_project_bytes_atomic(
    path: String,
    bytes: Vec<u8>,
) -> Result<AtomicWriteResult, String> {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_project_bytes,
            write_project_bytes_atomic,
            project_exists,
            read_backup_bytes,
            remove_project
        ])
        .run(tauri::generate_context!())
        .expect("error while running the voxel-maker desktop shell");
}
