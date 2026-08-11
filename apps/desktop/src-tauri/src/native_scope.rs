//! Scoped native handles for the desktop shell (issue #94, plan §11.2).
//!
//! Every project/image command in the IPC surface takes an OPAGUE HANDLE
//! TOKEN, never a filesystem path. Tokens are minted only by the
//! Rust-side open/save dialogs (`pick_open_project`, `pick_save_project`,
//! `pick_preview_image_paths`) or loaded from the Rust-owned recent-project
//! store, so a compromised webview cannot address a file the user never
//! chose. Each handle is bound to a scope kind (project vs image) and to
//! ONE canonicalized absolute path; a handle of one kind can never be used
//! through a command of the other kind, and no command accepts a raw path.
//!
//! Canonicalization happens at mint time (dialog time): symlinked
//! directories are resolved, `..` components collapse, and adjacent
//! artifacts (`.bak`, `.journal`, `.<name>.tmp`) are derived from the
//! canonical path afterwards. As defense in depth, operations refuse to
//! follow a symbolic link that appears AT the stored path or at a derived
//! artifact path at operation time (a same-user local race), so a planted
//! link can never redirect a read, an append, or a backup copy to a
//! different file.
//!
//! The recent-project store is Rust-owned: entries are written only from
//! resolved handle tokens (the webview can never persist a path of its
//! choosing), bounded to `MAX_RECENT_PROJECTS`, and re-loaded into the
//! token map at startup so a recent entry stays openable after a restart.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

/// Hard bound on the recent-project list (mirrors the webview bound).
pub const MAX_RECENT_PROJECTS: usize = 10;

/// Per-kind bound on live dialog handles (each token costs one tiny map
/// entry; dialogs are user-driven, the bound is defense in depth).
const MAX_HANDLES_PER_KIND: usize = 256;

/// Title bound for recent entries (bounded metadata, ARCHITECTURE.md).
const MAX_RECENT_TITLE_CHARS: usize = 512;

/// Bytes written per atomic-write chunk so cancellation can interrupt
/// large saves (mirrors the Node adapter's default chunk size).
const WRITE_CHUNK_BYTES: usize = 256 * 1024;

/// Bound on a webview-supplied cancellation token (bounded input).
const MAX_CANCEL_TOKEN_CHARS: usize = 128;

/// Bound on live cancellation tokens (one per in-flight write). Tokens
/// are webview-chosen, so the registry must not grow without limit; a
/// write beyond the cap simply runs without cancellation (the save still
/// succeeds, Cancel only degrades to "cannot interrupt this write").
const MAX_LIVE_CANCEL_TOKENS: usize = 256;

/// The four standard preview views the shell can derive from one chosen
/// PNG base path (mirrors `STANDARD_PREVIEW_VIEWS` in
/// `packages/renderer/src/preview/preview-protocol.ts`).
const PREVIEW_VIEWS: [&str; 4] = ["perspective", "front", "side", "top"];

/// The scope kind bound to one opaque handle.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum HandleKind {
    Project,
    Image,
}

/// One dialog-issued handle: a scope kind plus the canonicalized absolute
/// path of exactly the file the user chose.
struct ScopedHandle {
    kind: HandleKind,
    path: PathBuf,
}

/// A dialog pick result returned to the webview. `token` is the opaque
/// handle used by every subsequent command; `path` is DISPLAY-ONLY (the
/// shell chrome shows it, but no command ever accepts a raw path).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedPath {
    pub token: String,
    pub path: String,
}

/// One recent-project entry persisted in the app config directory. The
/// `path` is written by Rust from the resolved handle; the webview only
/// ever supplies the token (plus display metadata).
#[derive(serde::Serialize, serde::Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RecentEntry {
    pub token: String,
    pub path: String,
    pub title: String,
    pub opened_at: f64,
}

/// Result of one atomic project/image write (unchanged webview contract).
#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AtomicWriteResult {
    pub temp_path: String,
    pub backup_created: bool,
    pub backup_path: Option<String>,
    pub directory_sync_succeeded: bool,
}

/// Atomic write phases (mirror of `AtomicWritePhase` in
/// `@voxel-maker/storage`, docs/storage/atomic-save-v1.md). One shared
/// enum drives the IPC fault plan and the canonical per-phase error
/// codes, so a contract change cannot drift between them.
#[derive(serde::Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum AtomicWritePhase {
    CreateTemp,
    WriteTemp,
    FlushTemp,
    Backup,
    Replace,
    SyncDirectory,
}

/// Wire fault plan for one atomic write (the shared
/// `AtomicWriteFaultPlan` restricted to `true` canonical errors; custom
/// `WorkspaceError` faults are a memory/Node-only seam and cannot cross
/// IPC). Only the listed phases fail, each with its canonical error code,
/// so the native conformance matrix can inject every phase failure
/// through the real command surface (issue #120).
#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AtomicWriteFaultPlan {
    pub fail_at: Option<Vec<AtomicWritePhase>>,
}

/// Stable io-family error codes (mirror of `IO_ERROR_CODES` in
/// `@voxel-maker/storage`). Errors cross IPC as `CODE: message` strings
/// and the webview adapter maps them back to the shared contract.
const IO_NOT_FOUND: &str = "IO_NOT_FOUND";
const IO_NOT_REGULAR_FILE: &str = "IO_NOT_REGULAR_FILE";
const IO_DISK_FULL: &str = "IO_DISK_FULL";
const IO_PERMISSION_DENIED: &str = "IO_PERMISSION_DENIED";
const IO_RENAME_FAILED: &str = "IO_RENAME_FAILED";
const IO_WRITE_INTERRUPTED: &str = "IO_WRITE_INTERRUPTED";
const IO_READ_FAILED: &str = "IO_READ_FAILED";
const IO_WRITE_FAILED: &str = "IO_WRITE_FAILED";
const IO_SYNC_FAILED: &str = "IO_SYNC_FAILED";
const INPUT_FILE_LIMIT_EXCEEDED: &str = "INPUT_FILE_LIMIT_EXCEEDED";

/// Live dialog-issued handles with FIFO eviction order. Handles are
/// user-driven (one per dialog pick) and become useless once the webview
/// moves on, so when the per-kind cap is reached the OLDEST handle of
/// that kind is evicted instead of failing the dialog.
struct HandleTable {
    entries: HashMap<String, ScopedHandle>,
    order: std::collections::VecDeque<String>,
}

/// The Rust-owned handle registry and recent-project store. Managed as
/// Tauri state so every command resolves tokens through the same table.
pub struct NativeScope {
    /// Live dialog-issued handles: token -> scoped handle.
    handles: Mutex<HandleTable>,
    /// Persisted recent tokens: token -> canonical project path. Loaded at
    /// startup and updated on record/remove; never webview-writable.
    recent: Mutex<HashMap<String, PathBuf>>,
    /// App-config location of the recent-project JSON (set in `setup`).
    recent_file: Mutex<Option<PathBuf>>,
    /// Live atomic-write cancellation flags: token -> shared flag. The
    /// write command registers a flag under the webview-chosen token, the
    /// `cancel_project_write` command flips it, and the write loop observes
    /// it between chunks and before each phase (issue #120). Entries are
    /// removed when the write finishes.
    write_cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl Default for NativeScope {
    fn default() -> Self {
        Self {
            handles: Mutex::new(HandleTable {
                entries: HashMap::new(),
                order: std::collections::VecDeque::new(),
            }),
            recent: Mutex::new(HashMap::new()),
            recent_file: Mutex::new(None),
            write_cancels: Mutex::new(HashMap::new()),
        }
    }
}

/// The one stable error for unknown/out-of-scope handles: it must not
/// reveal whether a token exists or which kind it holds.
const UNRECOGNIZED_HANDLE: &str = "unrecognized handle token";

fn unrecognized_handle() -> String {
    UNRECOGNIZED_HANDLE.to_string()
}

/// Rejects a path that is a symbolic link at operation time. A stored
/// handle path is canonical (symlink-free) at mint time, so a symlink
/// here means a same-user local swap; refusing it prevents a read, an
/// append, a backup copy, or a temp write from being redirected to a
/// different file. A missing path is NOT an error: the caller reports
/// the real not-found outcome (or creates the artifact).
fn reject_symlink(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err("refusing to operate through a symbolic link".to_string())
        }
        _ => Ok(()),
    }
}

impl NativeScope {
    /// Points the recent-project store at its app-config file (setup).
    pub fn set_recent_file(&self, path: PathBuf) {
        *self.recent_file.lock().expect("recent file lock poisoned") = Some(path);
    }

    /// Loads persisted recent tokens into the in-memory map (startup).
    /// A missing or malformed store degrades to an empty list; the app
    /// never fails to start because of its own config file.
    pub fn load_recent(&self) {
        let Some(entries) = self.read_entries() else {
            return;
        };
        let mut recent = self.recent.lock().expect("recent lock poisoned");
        for entry in entries {
            recent.insert(entry.token, PathBuf::from(entry.path));
        }
    }

    /// Mints a project-scope handle for a canonicalized absolute path.
    /// The dialog commands canonicalize before calling; the checks here
    /// are the invariant guard (relative, non-canonical, or nameless
    /// paths are rejected even if a future caller forgets).
    pub fn mint_project(&self, path: PathBuf) -> Result<String, String> {
        self.mint(HandleKind::Project, path)
    }

    /// Mints an image-scope handle (same invariants as `mint_project`).
    pub fn mint_image(&self, path: PathBuf) -> Result<String, String> {
        self.mint(HandleKind::Image, path)
    }

    fn mint(&self, kind: HandleKind, path: PathBuf) -> Result<String, String> {
        if !path.is_absolute() {
            return Err("handle path must be absolute".to_string());
        }
        let parent = path
            .parent()
            .ok_or_else(|| "handle path has no parent directory".to_string())?;
        if path.file_name().is_none() {
            return Err("handle path has no file name".to_string());
        }
        // The parent must already be canonical (no symlinks, no `..`):
        // canonicalize is idempotent, so equality proves it.
        let canonical_parent = parent
            .canonicalize()
            .map_err(|error| format!("cannot resolve the handle directory: {error}"))?;
        if canonical_parent != parent {
            return Err("handle path is not canonical".to_string());
        }
        let mut table = self.handles.lock().expect("handles lock poisoned");
        let count = table.entries.values().filter(|h| h.kind == kind).count();
        if count >= MAX_HANDLES_PER_KIND {
            // FIFO eviction: drop the oldest handle of this kind so a long
            // session with many dialog picks never hits a hard wall. Old
            // tokens are only ever the webview's own stale picks (the app
            // operates on the current token; recent tokens resolve through
            // the Rust-owned store), so evicting them is safe.
            while let Some(oldest) = table.order.pop_front() {
                let evicted_kind = table.entries.get(&oldest).map(|h| h.kind);
                table.entries.remove(&oldest);
                if evicted_kind == Some(kind) {
                    break;
                }
            }
        }
        let token = uuid::Uuid::new_v4().to_string();
        table
            .entries
            .insert(token.clone(), ScopedHandle { kind, path });
        table.order.push_back(token.clone());
        Ok(token)
    }

    /// Resolves a token to the canonical project path it was minted for.
    /// Recent tokens (loaded from the Rust-owned store) resolve too, so a
    /// reopened recent project works after a restart. Raw paths and
    /// image-scope tokens never resolve.
    pub fn resolve_project(&self, token: &str) -> Result<PathBuf, String> {
        {
            let table = self.handles.lock().expect("handles lock poisoned");
            if let Some(handle) = table.entries.get(token) {
                if handle.kind == HandleKind::Project {
                    return Ok(handle.path.clone());
                }
                return Err(unrecognized_handle());
            }
        }
        let recent = self.recent.lock().expect("recent lock poisoned");
        recent.get(token).cloned().ok_or_else(unrecognized_handle)
    }

    /// Resolves a token to the canonical image path it was minted for.
    pub fn resolve_image(&self, token: &str) -> Result<PathBuf, String> {
        let table = self.handles.lock().expect("handles lock poisoned");
        match table.entries.get(token) {
            Some(handle) if handle.kind == HandleKind::Image => Ok(handle.path.clone()),
            _ => Err(unrecognized_handle()),
        }
    }

    /// Registers (or reuses) the cancellation flag for a write token. An
    /// existing flag is reused so a pre-cancelled token stays cancelled
    /// (the native conformance tests cancel before invoking the write);
    /// beyond the live-token cap the write runs without cancellation.
    pub fn register_cancel(&self, token: &str) -> Option<Arc<AtomicBool>> {
        let mut cancels = self.write_cancels.lock().expect("cancel lock poisoned");
        if let Some(flag) = cancels.get(token) {
            return Some(flag.clone());
        }
        if cancels.len() >= MAX_LIVE_CANCEL_TOKENS {
            return None;
        }
        let flag = Arc::new(AtomicBool::new(false));
        cancels.insert(token.to_string(), flag.clone());
        Some(flag)
    }

    /// Forgets a write token; called when its write finishes.
    pub fn unregister_cancel(&self, token: &str) {
        self.write_cancels
            .lock()
            .expect("cancel lock poisoned")
            .remove(token);
    }

    /// Flips the cancellation flag for a token; a missing token is not an
    /// error (the write already finished).
    pub fn cancel_write(&self, token: &str) {
        if let Some(flag) = self
            .write_cancels
            .lock()
            .expect("cancel lock poisoned")
            .get(token)
        {
            flag.store(true, Ordering::Relaxed);
        }
    }

    /// The bounded recent list (None when the store file is absent).
    pub fn recent_entries(&self) -> Option<Vec<RecentEntry>> {
        self.read_entries()
    }

    /// Records a recent entry from a RESOLVED project token. The stored
    /// path comes from the handle, never from the webview; a forged token
    /// (or a raw path) is rejected before any write.
    pub fn record_recent(&self, token: &str, title: &str, opened_at: f64) -> Result<(), String> {
        if !opened_at.is_finite() {
            return Err("openedAt must be a finite number".to_string());
        }
        let path = self.resolve_project(token)?;
        let bounded_title: String = title.chars().take(MAX_RECENT_TITLE_CHARS).collect();
        let mut entries = self.read_entries().unwrap_or_default();
        entries.retain(|entry| entry.token != token);
        entries.insert(
            0,
            RecentEntry {
                token: token.to_string(),
                path: path.to_string_lossy().into_owned(),
                title: bounded_title,
                opened_at,
            },
        );
        entries.truncate(MAX_RECENT_PROJECTS);
        self.write_entries(&entries)?;
        self.recent
            .lock()
            .expect("recent lock poisoned")
            .insert(token.to_string(), path);
        Ok(())
    }

    /// Forgets one recent entry by token; a missing entry is not an error.
    pub fn remove_recent(&self, token: &str) -> Result<(), String> {
        let mut entries = self.read_entries().unwrap_or_default();
        let before = entries.len();
        entries.retain(|entry| entry.token != token);
        if entries.len() == before {
            return Ok(());
        }
        self.write_entries(&entries)?;
        self.recent
            .lock()
            .expect("recent lock poisoned")
            .remove(token);
        Ok(())
    }

    /// Reads, validates, and bounds the persisted recent list.
    fn read_entries(&self) -> Option<Vec<RecentEntry>> {
        let path = self
            .recent_file
            .lock()
            .expect("recent file lock poisoned")
            .clone()?;
        let raw = std::fs::read_to_string(&path).ok()?;
        Some(parse_recent_json(&raw))
    }

    /// Atomically replaces the persisted recent list (temp + rename).
    fn write_entries(&self, entries: &[RecentEntry]) -> Result<(), String> {
        let path = self
            .recent_file
            .lock()
            .expect("recent file lock poisoned")
            .clone()
            .ok_or_else(|| "recent-projects store is not configured".to_string())?;
        let parent = path
            .parent()
            .ok_or_else(|| "recent-projects path has no parent".to_string())?;
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let file_name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .ok_or_else(|| "recent-projects path has no file name".to_string())?;
        let temp_path = parent.join(format!(".{file_name}.tmp"));
        reject_symlink(&temp_path)?;
        let json = serde_json::to_string(entries)
            .map_err(|error| format!("recent projects cannot be serialized: {error}"))?;
        std::fs::write(&temp_path, json).map_err(|error| error.to_string())?;
        std::fs::rename(&temp_path, &path).map_err(|error| error.to_string())?;
        Ok(())
    }
}

/// Parses the persisted recent JSON: unknown shapes are dropped, the
/// result is bounded, and every field is validated (bounded metadata).
/// Entries written by a pre-issue-#94 build (no `token` field) are
/// dropped INTENTIONALLY: they carry no Rust-owned token, and minting one
/// for a webview-written path would re-open the arbitrary-path hole. The
/// one-time cost of an emptied recent list is the safe upgrade path.
fn parse_recent_json(raw: &str) -> Vec<RecentEntry> {
    let Ok(serde_json::Value::Array(items)) = serde_json::from_str(raw) else {
        return Vec::new();
    };
    items
        .into_iter()
        .filter_map(|item| {
            let object = item.as_object()?;
            let token = object.get("token")?.as_str()?;
            let path = object.get("path")?.as_str()?;
            let title = object.get("title")?.as_str()?;
            let opened_at = object.get("openedAt")?.as_f64()?;
            if token.is_empty() || path.is_empty() || !opened_at.is_finite() {
                return None;
            }
            Some(RecentEntry {
                token: token.to_string(),
                path: path.to_string(),
                title: title.chars().take(MAX_RECENT_TITLE_CHARS).collect(),
                opened_at,
            })
        })
        .take(MAX_RECENT_PROJECTS)
        .collect()
}

/// Canonicalizes a path a SAVE dialog returned (the file may not exist):
/// resolve the parent directory and keep the chosen file name. When the
/// chosen name itself is an existing symlink, resolve the link fully so
/// the handle points at the real destination the user picked.
fn canonicalize_destination(path: &Path) -> Result<PathBuf, String> {
    if std::fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return path
            .canonicalize()
            .map_err(|error| format!("cannot resolve the chosen destination: {error}"));
    }
    let parent = path
        .parent()
        .ok_or_else(|| "chosen path has no parent directory".to_string())?;
    let file_name = path
        .file_name()
        .ok_or_else(|| "chosen path has no file name".to_string())?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|error| format!("cannot resolve the chosen directory: {error}"))?;
    Ok(canonical_parent.join(file_name))
}

/// Converts a dialog result into a local path; remote URLs are rejected
/// (a URL can never be a scoped local file).
fn local_dialog_path(file_path: tauri_plugin_dialog::FilePath) -> Result<PathBuf, String> {
    match file_path {
        tauri_plugin_dialog::FilePath::Path(path) => Ok(path),
        tauri_plugin_dialog::FilePath::Url(_) => {
            Err("remote file URLs are not supported".to_string())
        }
    }
}

/// Bounds a webview-supplied suggested file name to its last component
/// (the dialog only uses it as the initial text; the final path is the
/// user's choice, but the value is still parsed and bounded).
fn sanitize_suggested_name(name: &str) -> Option<String> {
    let last = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = last.chars().filter(|c| !c.is_control()).take(255).collect();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

/// Removes a trailing `.png`/`.PNG` from a file name (mirrors the
/// webview's `stripPngExtension`); preview view names derive from it.
fn strip_png_extension(path: &Path) -> Result<&str, String> {
    let name = path
        .file_name()
        .ok_or_else(|| "image path has no file name".to_string())?
        .to_str()
        .ok_or_else(|| "image path is not valid UTF-8".to_string())?;
    let stem = if name.len() >= 4 && name[name.len() - 4..].eq_ignore_ascii_case(".png") {
        &name[..name.len() - 4]
    } else {
        name
    };
    if stem.is_empty() {
        return Err("chosen image name is invalid".to_string());
    }
    Ok(stem)
}

/// Mints one handle from a canonical path with the given scope kind.
fn mint_canonical(scope: &NativeScope, kind: HandleKind, path: PathBuf) -> Result<String, String> {
    match kind {
        HandleKind::Project => scope.mint_project(path),
        HandleKind::Image => scope.mint_image(path),
    }
}

// ---------------------------------------------------------------------------
// Commands (the entire IPC surface; lib.rs registers this exact list).
// ---------------------------------------------------------------------------

/// Open dialog -> one project-scope handle for the chosen file.
#[tauri::command]
#[allow(clippy::unused_async)] // blocking dialog must run off the main thread
pub async fn pick_open_project(
    app: AppHandle,
    state: State<'_, NativeScope>,
) -> Result<Option<PickedPath>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("Open Voxel Maker project")
        .add_filter("Voxel Maker project", &["vxl"])
        .blocking_pick_file();
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = local_dialog_path(picked)?;
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("cannot resolve the chosen project path: {error}"))?;
    let token = mint_canonical(&state, HandleKind::Project, canonical.clone())?;
    Ok(Some(PickedPath {
        token,
        path: canonical.to_string_lossy().into_owned(),
    }))
}

/// Save dialog -> one project-scope handle for the chosen destination.
#[tauri::command]
#[allow(clippy::unused_async)] // blocking dialog must run off the main thread
pub async fn pick_save_project(
    app: AppHandle,
    state: State<'_, NativeScope>,
    suggested_name: Option<String>,
) -> Result<Option<PickedPath>, String> {
    let mut builder = app
        .dialog()
        .file()
        .set_title("Save Voxel Maker project")
        .add_filter("Voxel Maker project", &["vxl"]);
    if let Some(name) = suggested_name.as_deref().and_then(sanitize_suggested_name) {
        builder = builder.set_file_name(name);
    }
    let picked = builder.blocking_save_file();
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = local_dialog_path(picked)?;
    let canonical = canonicalize_destination(&path)?;
    let token = mint_canonical(&state, HandleKind::Project, canonical.clone())?;
    Ok(Some(PickedPath {
        token,
        path: canonical.to_string_lossy().into_owned(),
    }))
}

/// PNG save dialog -> one image-scope handle per standard preview view,
/// all derived from the single base path the user chose. The webview can
/// address exactly those four files, never arbitrary siblings.
#[tauri::command]
#[allow(clippy::unused_async)] // blocking dialog must run off the main thread
pub async fn pick_preview_image_paths(
    app: AppHandle,
    state: State<'_, NativeScope>,
    suggested_name: Option<String>,
) -> Result<Option<Vec<PickedPath>>, String> {
    let mut builder = app
        .dialog()
        .file()
        .set_title("Export preview images")
        .add_filter("PNG image", &["png"]);
    if let Some(name) = suggested_name.as_deref().and_then(sanitize_suggested_name) {
        builder = builder.set_file_name(name);
    }
    let picked = builder.blocking_save_file();
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = local_dialog_path(picked)?;
    let stem = strip_png_extension(&path)?;
    let parent = path
        .parent()
        .ok_or_else(|| "image path has no parent directory".to_string())?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|error| format!("cannot resolve the chosen directory: {error}"))?;
    let mut results = Vec::with_capacity(PREVIEW_VIEWS.len());
    for view in PREVIEW_VIEWS {
        let view_path = canonical_parent.join(format!("{stem}-{view}.png"));
        let canonical = canonicalize_destination(&view_path)?;
        let token = mint_canonical(&state, HandleKind::Image, canonical.clone())?;
        results.push(PickedPath {
            token,
            path: canonical.to_string_lossy().into_owned(),
        });
    }
    Ok(Some(results))
}

/// Hard bound on native/external input files (ADR-0009, issue #96),
/// mirroring the shared `INPUT_FILE_MAX_BYTES` constant the Node storage
/// adapter and the format parsers enforce.
const MAX_INPUT_FILE_BYTES: u64 = 512 * 1024 * 1024;

/// Stable, machine-distinguishable limit message naming the resource, the
/// configured maximum, and the requested size (ADR-0009).
fn input_file_limit_message(path: &Path, requested: u64) -> String {
    format!(
        "input file exceeds the 512 MiB hard limit ({requested} bytes): {}",
        path.display()
    )
}

/// Reads a file with a stat preflight and a bounded stream (issue #96):
/// non-regular paths and files above the 512 MiB input-file hard cap are
/// rejected BEFORE the body is read, and the read itself is capped so a
/// file that grows between the metadata check and the read can never be
/// allocated beyond the limit.
fn read_bounded_bytes(path: &Path) -> Result<Vec<u8>, String> {
    let file = std::fs::File::open(path).map_err(|error| read_io_error(&error))?;
    read_bounded_file(file, path)
}

/// `read_bounded_bytes`, with a missing file resolving to `None` (used by
/// the backup and journal readers, where absence is a normal state).
fn read_bounded_bytes_or_none(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match std::fs::File::open(path) {
        Ok(file) => read_bounded_file(file, path).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(read_io_error(&error)),
    }
}

/// Shared bounded read over an already-opened file: metadata preflight on
/// the handle, capped stream, and a post-read size check so a file that
/// grows past the cap is never allocated beyond it.
fn read_bounded_file(file: std::fs::File, path: &Path) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let metadata = file.metadata().map_err(|error| read_io_error(&error))?;
    if !metadata.is_file() {
        return Err(format!(
            "{IO_NOT_REGULAR_FILE}: input path is not a regular file: {}",
            path.display()
        ));
    }
    if metadata.len() > MAX_INPUT_FILE_BYTES {
        return Err(format!(
            "{INPUT_FILE_LIMIT_EXCEEDED}: {}",
            input_file_limit_message(path, metadata.len())
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_INPUT_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| read_io_error(&error))?;
    if bytes.len() as u64 > MAX_INPUT_FILE_BYTES {
        return Err(format!(
            "{INPUT_FILE_LIMIT_EXCEEDED}: {}",
            input_file_limit_message(path, bytes.len() as u64)
        ));
    }
    Ok(bytes)
}

/// Reads a project file's bytes through a project handle.
#[tauri::command]
pub fn read_project_bytes(
    state: State<'_, NativeScope>,
    handle: String,
) -> Result<tauri::ipc::Response, String> {
    let path = state.resolve_project(&handle)?;
    reject_symlink(&path)?;
    let bytes = read_bounded_bytes(&path)?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// The frozen phased atomic-save algorithm (docs/storage/atomic-save-v1.md,
/// plan S5.7/S6.18, tickets #13/#22, issue #120): exclusive same-directory
/// nonce temp -> chunked cancellable write -> fsync -> atomic backup refresh
/// -> replace -> best-effort directory sync. Every failure before `replace`
/// removes its temporary files and leaves destination and backup
/// byte-identical; a `replace` failure leaves the previous destination in
/// place with the backup already refreshed to it. `nonce` is the
/// adapter-supplied temp nonce (a fresh UUID in the command; fixed values
/// in tests so temp-path attacks are deterministic). `fault_plan` injects
/// canonical per-phase failures (native conformance seam); `cancel`
/// interrupts the write before the replace when set, mirroring the port's
/// AbortSignal contract. Errors are stable `CODE: message` strings the
/// webview adapter maps back to the shared io-family error contract.
/// The same-directory hidden temporary paths of one atomic write: the
/// destination temp and the backup-refresh temp. Hidden dotfiles beside
/// the destination keep every rename on one filesystem, and the nonce
/// makes both names exclusive (a stale temp from a crashed process is
/// never reused or truncated).
fn temp_paths_for(destination: &Path, nonce: &str) -> (PathBuf, PathBuf) {
    let parent = destination.parent().expect("canonical path has a parent");
    let file_name = destination
        .file_name()
        .expect("canonical path has a file name")
        .to_string_lossy();
    (
        parent.join(format!(".{file_name}.{nonce}.tmp")),
        parent.join(format!(".{file_name}.bak.{nonce}.tmp")),
    )
}

fn write_project_atomic_phased(
    destination: &Path,
    bytes: &[u8],
    temp_path: &Path,
    backup_temp_path: &Path,
    fault_plan: Option<&AtomicWriteFaultPlan>,
    cancel: Option<&AtomicBool>,
) -> Result<AtomicWriteResult, String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "project path has no parent directory".to_string())?;
    let backup_path = sibling_path_for(destination, ".bak");

    // Preflight every symlink guard BEFORE any write (issue #94 defense in
    // depth): the destination (never back up THROUGH a planted link — copy
    // follows its source), the adjacent backup, and both temp paths. The
    // destination temp also refuses a planted link via exclusive creation;
    // the backup temp copy would otherwise follow one, so its preflight is
    // load-bearing. A rejection leaves the filesystem untouched.
    let destination_present = destination.exists();
    if destination_present {
        reject_symlink(destination)?;
        reject_symlink(&backup_path)?;
    }
    reject_symlink(temp_path)?;
    reject_symlink(backup_temp_path)?;

    // create-temp: exclusive creation never follows or reuses an existing
    // path (a stale or planted file at the nonce temp fails the phase).
    phase_gate(fault_plan, cancel, AtomicWritePhase::CreateTemp)?;
    let mut temp = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temp_path)
        .map_err(|error| write_phase_error(AtomicWritePhase::CreateTemp, &error))?;

    // write-temp: chunked so cancellation can interrupt large saves.
    phase_gate(fault_plan, cancel, AtomicWritePhase::WriteTemp)?;
    for chunk in bytes.chunks(WRITE_CHUNK_BYTES) {
        throw_if_cancelled(cancel)?;
        temp.write_all(chunk)
            .map_err(|error| write_phase_error(AtomicWritePhase::WriteTemp, &error))?;
    }

    // flush-temp: fsync before the backup/replace so a resolved save is
    // durable (a failure leaves destination and backup intact).
    phase_gate(fault_plan, cancel, AtomicWritePhase::FlushTemp)?;
    temp.sync_all()
        .map_err(|error| write_phase_error(AtomicWritePhase::FlushTemp, &error))?;
    drop(temp);

    // backup: atomically refresh the last-known-good backup — copy to a
    // same-directory temporary, then rename over `<path>.bak` — so a
    // mid-copy failure can never truncate the previous backup.
    let mut backup_created = false;
    if destination_present {
        phase_gate(fault_plan, cancel, AtomicWritePhase::Backup)?;
        std::fs::copy(destination, backup_temp_path)
            .map_err(|error| write_phase_error(AtomicWritePhase::Backup, &error))?;
        throw_if_cancelled(cancel)?;
        std::fs::rename(backup_temp_path, &backup_path)
            .map_err(|error| write_phase_error(AtomicWritePhase::Backup, &error))?;
        backup_created = true;
    }

    // replace: rename replaces a destination link itself and never follows
    // it; a failure leaves the previous destination in place.
    phase_gate(fault_plan, cancel, AtomicWritePhase::Replace)?;
    std::fs::rename(temp_path, destination)
        .map_err(|error| write_phase_error(AtomicWritePhase::Replace, &error))?;

    // sync-directory: best-effort — an injected fault or a real sync
    // failure never fails the save, only weakens crash durability.
    let directory_sync_succeeded = if fault_at(fault_plan, AtomicWritePhase::SyncDirectory) {
        false
    } else {
        std::fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .is_ok()
    };

    Ok(AtomicWriteResult {
        temp_path: temp_path.to_string_lossy().into_owned(),
        backup_created,
        backup_path: backup_created.then(|| backup_path.to_string_lossy().into_owned()),
        directory_sync_succeeded,
    })
}

/// Runs the phased algorithm and guarantees temp cleanup on every failure
/// path: destination and backup stay untouched and every temporary file is
/// removed (contract, issue #120).
fn write_project_atomic_cleaned(
    destination: &Path,
    bytes: &[u8],
    nonce: &str,
    fault_plan: Option<&AtomicWriteFaultPlan>,
    cancel: Option<&AtomicBool>,
) -> Result<AtomicWriteResult, String> {
    let (temp_path, backup_temp_path) = temp_paths_for(destination, nonce);
    let outcome = write_project_atomic_phased(
        destination,
        bytes,
        &temp_path,
        &backup_temp_path,
        fault_plan,
        cancel,
    );
    if outcome.is_err() {
        let _ = std::fs::remove_file(&temp_path);
        let _ = std::fs::remove_file(&backup_temp_path);
    }
    outcome
}

/// Atomically replaces a project file through a project handle (issue
/// #120): the frozen phased algorithm — exclusive nonce temp, chunked
/// cancellable write, fsync, atomic standard-name backup refresh, replace,
/// cleanup, and structured parity errors. `cancel_token` names a
/// Rust-side cancellation flag that `cancel_project_write` flips; the
/// write observes it between chunks and before each phase, so Cancel can
/// interrupt a large save before the replace (an abort after the replace
/// committed completes normally). `faults` is the native conformance seam:
/// the webview adapter forwards `true` phase faults so the shared fault
/// matrix runs against the real command surface.
#[tauri::command]
pub async fn write_project_bytes_atomic(
    state: State<'_, NativeScope>,
    handle: String,
    bytes: Vec<u8>,
    cancel_token: Option<String>,
    faults: Option<AtomicWriteFaultPlan>,
) -> Result<AtomicWriteResult, String> {
    let destination = state.resolve_project(&handle)?;
    validate_cancel_token(cancel_token.as_deref())?;
    if bytes.len() as u64 > MAX_INPUT_FILE_BYTES {
        return Err(format!(
            "{INPUT_FILE_LIMIT_EXCEEDED}: {}",
            input_file_limit_message(&destination, bytes.len() as u64)
        ));
    }
    let cancel_flag = cancel_token
        .as_deref()
        .and_then(|token| state.register_cancel(token));
    // The guard removes the token when the write finishes (success or
    // failure), so the registry never retains finished writes.
    let guard = CancelGuard {
        scope: &state,
        token: cancel_token,
    };
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        write_project_atomic_cleaned(
            &destination,
            &bytes,
            &nonce,
            faults.as_ref(),
            cancel_flag.as_deref(),
        )
    })
    .await
    .map_err(|error| format!("{IO_WRITE_FAILED}: The project write failed: {error}"))?;
    drop(guard);
    outcome
}

/// Removes a write's cancellation token when the write finishes.
struct CancelGuard<'a> {
    scope: &'a NativeScope,
    token: Option<String>,
}

impl Drop for CancelGuard<'_> {
    fn drop(&mut self) {
        if let Some(token) = self.token.take() {
            self.scope.unregister_cancel(&token);
        }
    }
}

/// Bounds a webview-supplied cancellation token before it is registered.
fn validate_cancel_token(token: Option<&str>) -> Result<(), String> {
    if token.is_some_and(|token| token.is_empty() || token.len() > MAX_CANCEL_TOKEN_CHARS) {
        return Err("cancel token is empty or exceeds the size limit".to_string());
    }
    Ok(())
}

/// Cancels an in-flight atomic project write named by its token (issue
/// #120). The write observes the flag between chunks and before each
/// phase; an observation before the replace aborts with
/// `IO_WRITE_INTERRUPTED` and removes the temporary files. A token that
/// is unknown (the write already finished) is not an error.
#[tauri::command]
pub fn cancel_project_write(state: State<'_, NativeScope>, token: String) -> Result<(), String> {
    validate_cancel_token(Some(&token))?;
    state.cancel_write(&token);
    Ok(())
}

/// One per-phase contract table (mirror of `PHASE_ERROR_CODES` /
/// `PHASE_ERROR_MESSAGES` in `@voxel-maker/storage`): the canonical error
/// code, the stable message, and the wire phase name. Fault injection and
/// real filesystem errors share this table, so a contract change cannot
/// drift between them.
struct PhaseContract {
    code: &'static str,
    message: &'static str,
    name: &'static str,
}

fn phase_contract(phase: AtomicWritePhase) -> PhaseContract {
    match phase {
        AtomicWritePhase::CreateTemp => PhaseContract {
            code: IO_PERMISSION_DENIED,
            message: "Cannot create the temporary project file in the project directory",
            name: "create-temp",
        },
        AtomicWritePhase::WriteTemp => PhaseContract {
            code: IO_DISK_FULL,
            message: "Cannot write the temporary project file",
            name: "write-temp",
        },
        AtomicWritePhase::FlushTemp => PhaseContract {
            code: IO_DISK_FULL,
            message: "Cannot flush the temporary project file to disk",
            name: "flush-temp",
        },
        AtomicWritePhase::Backup => PhaseContract {
            code: IO_PERMISSION_DENIED,
            message: "Cannot preserve the last-known-good backup",
            name: "backup",
        },
        AtomicWritePhase::Replace => PhaseContract {
            code: IO_RENAME_FAILED,
            message: "Cannot atomically replace the project file",
            name: "replace",
        },
        AtomicWritePhase::SyncDirectory => PhaseContract {
            code: IO_SYNC_FAILED,
            message: "Cannot sync the project directory",
            name: "sync-directory",
        },
    }
}

/// True when the fault plan injects a canonical failure at `phase`.
fn fault_at(fault_plan: Option<&AtomicWriteFaultPlan>, phase: AtomicWritePhase) -> bool {
    fault_plan
        .and_then(|plan| plan.fail_at.as_ref())
        .is_some_and(|phases| phases.contains(&phase))
}

/// Injects the canonical phase fault when the plan names the phase.
fn throw_write_fault(
    fault_plan: Option<&AtomicWriteFaultPlan>,
    phase: AtomicWritePhase,
) -> Result<(), String> {
    if fault_at(fault_plan, phase) {
        let contract = phase_contract(phase);
        Err(format!(
            "{}: {} (phase {})",
            contract.code, contract.message, contract.name
        ))
    } else {
        Ok(())
    }
}

/// One phase gate: injects the canonical phase fault, then observes
/// cancellation, before a phase runs (the port's per-phase fault and
/// abort checks).
fn phase_gate(
    fault_plan: Option<&AtomicWriteFaultPlan>,
    cancel: Option<&AtomicBool>,
    phase: AtomicWritePhase,
) -> Result<(), String> {
    throw_write_fault(fault_plan, phase)?;
    throw_if_cancelled(cancel)
}

/// Cooperative abort check between atomic write phases and chunks.
fn throw_if_cancelled(cancel: Option<&AtomicBool>) -> Result<(), String> {
    if cancel.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
        Err(format!(
            "{IO_WRITE_INTERRUPTED}: The project write was interrupted"
        ))
    } else {
        Ok(())
    }
}

/// Builds the stable `CODE: message (phase X): cause` error string for a
/// real filesystem failure, classifying by error kind (parity with the
/// Node adapter's `mapFsError`). Unclassified kinds keep the phase's
/// canonical code.
fn write_phase_error(phase: AtomicWritePhase, error: &std::io::Error) -> String {
    let contract = phase_contract(phase);
    let code = match error.kind() {
        std::io::ErrorKind::NotFound => IO_WRITE_FAILED,
        std::io::ErrorKind::StorageFull => IO_DISK_FULL,
        std::io::ErrorKind::PermissionDenied => IO_PERMISSION_DENIED,
        // Exclusive-create collision: a file (or planted link) already
        // exists at the nonce temp path.
        std::io::ErrorKind::AlreadyExists => IO_PERMISSION_DENIED,
        _ => contract.code,
    };
    format!(
        "{code}: {} (phase {}): {error}",
        contract.message, contract.name
    )
}

/// Builds the stable `CODE: message` string for a read failure (parity
/// with the Node adapter's read mapping).
fn read_io_error(error: &std::io::Error) -> String {
    let code = match error.kind() {
        std::io::ErrorKind::NotFound => IO_NOT_FOUND,
        std::io::ErrorKind::PermissionDenied => IO_PERMISSION_DENIED,
        _ => IO_READ_FAILED,
    };
    format!("{code}: Cannot read the file: {error}")
}

/// Existence probe for a project handle (dialog-chosen files only).
/// A planted symlink at the stored path is refused like every other
/// operation, so the probe can never become an oracle on the link target.
#[tauri::command]
pub fn project_exists(state: State<'_, NativeScope>, handle: String) -> Result<bool, String> {
    let path = state.resolve_project(&handle)?;
    reject_symlink(&path)?;
    Ok(Path::new(&path).exists())
}

/// Reads the last-known-good backup of a project handle.
#[tauri::command]
pub fn read_backup_bytes(
    state: State<'_, NativeScope>,
    handle: String,
) -> Result<Option<Vec<u8>>, String> {
    let path = state.resolve_project(&handle)?;
    let backup = sibling_path_for(&path, ".bak");
    reject_symlink(&backup)?;
    read_bounded_bytes_or_none(&backup)
}

/// Removes a project file through a project handle (missing is not an
/// error). `remove_file` unlinks the path itself and never follows a
/// planted link, so no symlink guard is needed.
#[tauri::command]
pub fn remove_project(state: State<'_, NativeScope>, handle: String) -> Result<(), String> {
    let path = state.resolve_project(&handle)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

/// Atomically replaces a preview image file through an IMAGE handle:
/// same-directory temporary file, flush, rename, best-effort directory
/// sync — WITHOUT a `.bak` backup (preview images are reproducible).
#[tauri::command]
pub fn write_image_bytes_atomic(
    state: State<'_, NativeScope>,
    handle: String,
    bytes: Vec<u8>,
) -> Result<AtomicWriteResult, String> {
    let destination = state.resolve_image(&handle)?;
    let parent = destination
        .parent()
        .ok_or_else(|| "image path has no parent directory".to_string())?;
    let file_name = destination
        .file_name()
        .ok_or_else(|| "image path has no file name".to_string())?;
    let file_name = file_name.to_string_lossy();
    let temp_path = parent.join(format!(".{file_name}.tmp"));
    // Preflight before any write: a symlink at the stored destination is a
    // post-dialog swap (the dialog command resolves picked links at mint
    // time), so refuse it rather than rename over it.
    reject_symlink(&destination)?;
    reject_symlink(&temp_path)?;
    std::fs::write(&temp_path, &bytes).map_err(|error| error.to_string())?;
    let file = std::fs::File::open(&temp_path).and_then(|file| file.sync_all());
    if let Err(error) = file {
        let _ = std::fs::remove_file(&temp_path);
        return Err(error.to_string());
    }
    std::fs::rename(&temp_path, &destination).map_err(|error| error.to_string())?;
    let directory_sync_succeeded = std::fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .is_ok();
    Ok(AtomicWriteResult {
        temp_path: temp_path.to_string_lossy().into_owned(),
        backup_created: false,
        backup_path: None,
        directory_sync_succeeded,
    })
}

/// Existence probe for an image handle (dialog-chosen files only).
/// Like `project_exists`, a planted symlink is refused, never followed.
#[tauri::command]
pub fn image_exists(state: State<'_, NativeScope>, handle: String) -> Result<bool, String> {
    let path = state.resolve_image(&handle)?;
    reject_symlink(&path)?;
    Ok(Path::new(&path).exists())
}

/// Appends a suffix to a canonical project path (`<path>.bak`,
/// `<path>.journal`) at the OS-string level. Adjacent artifacts are
/// derived from the canonical path AFTER minting, so they stay within the
/// exact directory the user chose.
fn sibling_path_for(project_path: &Path, suffix: &str) -> PathBuf {
    let mut path = project_path.as_os_str().to_owned();
    path.push(suffix);
    PathBuf::from(path)
}

/// The adjacent journal path of a canonical project path.
fn journal_path_for(project_path: &Path) -> PathBuf {
    sibling_path_for(project_path, ".journal")
}

/// Reads the adjacent recovery journal (`<path>.journal`) of a project
/// handle; `None` when absent.
#[tauri::command]
pub fn read_journal_bytes(
    state: State<'_, NativeScope>,
    handle: String,
) -> Result<Option<Vec<u8>>, String> {
    let path = state.resolve_project(&handle)?;
    let journal_path = journal_path_for(&path);
    reject_symlink(&journal_path)?;
    read_bounded_bytes_or_none(&journal_path)
}

/// Appends bytes to the adjacent journal of a project handle, creating it
/// when absent, and flushes before returning.
#[tauri::command]
pub fn append_journal_bytes(
    state: State<'_, NativeScope>,
    handle: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let path = state.resolve_project(&handle)?;
    let journal_path = journal_path_for(&path);
    // Opening with create+append would FOLLOW a planted link; check first.
    reject_symlink(&journal_path)?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&journal_path)
        .map_err(|error| error.to_string())?;
    std::io::Write::write_all(&mut file, &bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    Ok(())
}

/// Atomically replaces the adjacent journal of a project handle
/// (compaction and anchor reset): temp + flush + rename, no backup.
#[tauri::command]
pub fn replace_journal_bytes(
    state: State<'_, NativeScope>,
    handle: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let path = state.resolve_project(&handle)?;
    let journal_path = journal_path_for(&path);
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
    reject_symlink(&temp_path)?;
    std::fs::write(&temp_path, &bytes).map_err(|error| error.to_string())?;
    let file = std::fs::File::open(&temp_path).and_then(|f| f.sync_all());
    if let Err(error) = file {
        let _ = std::fs::remove_file(&temp_path);
        return Err(error.to_string());
    }
    std::fs::rename(&temp_path, destination).map_err(|error| error.to_string())?;
    let _ = std::fs::File::open(parent).and_then(|directory| directory.sync_all());
    Ok(())
}

/// Removes the adjacent journal of a project handle; missing is not an
/// error (unlink never follows a planted link).
#[tauri::command]
pub fn remove_journal(state: State<'_, NativeScope>, handle: String) -> Result<(), String> {
    let path = state.resolve_project(&handle)?;
    let journal_path = journal_path_for(&path);
    match std::fs::remove_file(&journal_path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

/// Reads the bounded recent-project list (Rust-owned store; the webview
/// only ever writes through resolved handle tokens).
#[tauri::command]
pub fn read_recent_projects(
    state: State<'_, NativeScope>,
) -> Result<Option<Vec<RecentEntry>>, String> {
    Ok(state.recent_entries())
}

/// Records one recent entry from a project handle token.
#[tauri::command]
pub fn record_recent_project(
    state: State<'_, NativeScope>,
    handle: String,
    title: String,
    opened_at: f64,
) -> Result<(), String> {
    state.record_recent(&handle, &title, opened_at)
}

/// Forgets one recent entry by token; missing is not an error.
#[tauri::command]
pub fn remove_recent_project(state: State<'_, NativeScope>, token: String) -> Result<(), String> {
    state.remove_recent(&token)
}

#[cfg(test)]
mod tests {
    //! Regression tests for issue #94: the IPC surface must reject every
    //! raw path (including /etc/passwd, user dotfiles, unselected temp
    //! paths, and symlink variants) BEFORE any filesystem access, and
    //! dialog-issued handles must permit only their intended operations.
    //! Commands are exercised through their real signatures with a Tauri
    //! mock app and a real `NativeScope` state, so the test seam is the
    //! actual IPC surface (minus the blocking native dialogs, which are
    //! exercised through the same `mint_*` + canonicalization helpers the
    //! dialog commands call).

    use super::*;
    use tauri::ipc::IpcResponse;
    use tauri::test::mock_app;
    use tauri::Manager;

    /// A hermetic temp directory removed on drop.
    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(label: &str) -> Self {
            let path =
                std::env::temp_dir().join(format!("voxel-maker-{label}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).expect("create temp dir");
            Self { path }
        }

        fn file(&self, name: &str) -> PathBuf {
            self.path.join(name)
        }

        /// Canonicalizes like the save dialog does (parent + file name).
        fn canonical(&self, name: &str) -> PathBuf {
            self.path
                .canonicalize()
                .expect("canonical temp dir")
                .join(name)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    /// A mock app with a managed `NativeScope` (recent store in `dir`,
    /// when given) and the raw response bytes of a read command.
    fn managed_app(recent_dir: Option<&TempDir>) -> tauri::App<tauri::test::MockRuntime> {
        let app = mock_app();
        let scope = NativeScope::default();
        if let Some(dir) = recent_dir {
            scope.set_recent_file(dir.file("recent-projects.json"));
        }
        app.manage(scope);
        app
    }

    fn read_bytes(
        app: &tauri::App<tauri::test::MockRuntime>,
        handle: String,
    ) -> Result<Vec<u8>, String> {
        let response = read_project_bytes(app.state::<NativeScope>(), handle)?;
        let body = response.body().map_err(|error| error.to_string())?;
        match body {
            tauri::ipc::InvokeResponseBody::Raw(bytes) => Ok(bytes),
            other => Err(format!("unexpected body kind: {other:?}")),
        }
    }

    /// Blocks on the async atomic-write command (the test runtime has no
    /// poller of its own; issue #120 made the command async so the native
    /// write runs on the blocking pool and stays cancellable).
    fn write_project(
        state: State<'_, NativeScope>,
        handle: String,
        bytes: Vec<u8>,
    ) -> Result<AtomicWriteResult, String> {
        write_project_with(state, handle, bytes, None, None)
    }

    /// `write_project` with the native conformance seam (cancel token and
    /// canonical phase faults).
    fn write_project_with(
        state: State<'_, NativeScope>,
        handle: String,
        bytes: Vec<u8>,
        cancel_token: Option<String>,
        faults: Option<AtomicWriteFaultPlan>,
    ) -> Result<AtomicWriteResult, String> {
        tauri::async_runtime::block_on(write_project_bytes_atomic(
            state,
            handle,
            bytes,
            cancel_token,
            faults,
        ))
    }

    /// Same-directory temp artifacts currently present in the fixture dir.
    fn temp_files(dir: &TempDir) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(&dir.path)
            .expect("read fixture dir")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        names.sort();
        names
    }

    // -------------------------------------------------------------------
    // Acceptance: direct IPC with arbitrary paths fails BEFORE fs access.
    // -------------------------------------------------------------------

    #[test]
    fn every_command_rejects_raw_paths_before_filesystem_access() {
        let dir = TempDir::new("raw");
        let victim = dir.file("victim.vxl");
        std::fs::write(&victim, b"secret").expect("seed victim");
        let app = managed_app(None);
        let state = app.state::<NativeScope>();

        // /etc/passwd, a user dotfile, an unselected temp path, and a
        // symlink variant: all must fail as raw paths on EVERY command.
        let raw_paths = [
            "/etc/passwd".to_string(),
            dir.file(".user-dotfile").to_string_lossy().into_owned(),
            victim.to_string_lossy().into_owned(),
        ];
        for raw in &raw_paths {
            let message = format!("raw path {raw} was not rejected");
            assert!(
                read_project_bytes(state.clone(), raw.clone()).is_err(),
                "{message}"
            );
            assert!(
                write_project(state.clone(), raw.clone(), vec![1]).is_err(),
                "{message}"
            );
            assert!(
                project_exists(state.clone(), raw.clone()).is_err(),
                "{message}"
            );
            assert!(
                read_backup_bytes(state.clone(), raw.clone()).is_err(),
                "{message}"
            );
            assert!(
                remove_project(state.clone(), raw.clone()).is_err(),
                "{message}"
            );
            assert!(
                write_image_bytes_atomic(state.clone(), raw.clone(), vec![1]).is_err(),
                "{message}"
            );
            assert!(
                image_exists(state.clone(), raw.clone()).is_err(),
                "{message}"
            );
            assert!(
                read_journal_bytes(state.clone(), raw.clone()).is_err(),
                "{message}"
            );
            assert!(
                append_journal_bytes(state.clone(), raw.clone(), vec![1]).is_err(),
                "{message}"
            );
            assert!(
                replace_journal_bytes(state.clone(), raw.clone(), vec![1]).is_err(),
                "{message}"
            );
            assert!(
                remove_journal(state.clone(), raw.clone()).is_err(),
                "{message}"
            );
            assert!(
                record_recent_project(state.clone(), raw.clone(), "t".into(), 1.0).is_err(),
                "{message}"
            );
        }
        // The victim file was never touched by any of the rejected calls.
        assert_eq!(std::fs::read(&victim).expect("victim readable"), b"secret");
        // And a forged/garbage token never resolves either.
        assert!(read_project_bytes(state.clone(), "forged-token".into()).is_err());
        assert!(project_exists(state, "forged-token".into()).is_err());
    }

    #[test]
    fn unselected_paths_never_resolve_even_through_recent_records() {
        let dir = TempDir::new("unselected");
        let chosen = dir.file("chosen.vxl");
        std::fs::write(&chosen, b"chosen").expect("seed chosen");
        let unselected = dir.file("unselected.vxl");
        std::fs::write(&unselected, b"unselected").expect("seed unselected");
        let app = managed_app(Some(&dir));
        let state = app.state::<NativeScope>();

        let token = state
            .mint_project(dir.canonical("chosen.vxl"))
            .expect("mint");
        // The unselected sibling's RAW path (the string the webview would
        // have) is rejected by every command.
        let raw = unselected.to_string_lossy().into_owned();
        assert!(read_project_bytes(state.clone(), raw.clone()).is_err());
        assert!(project_exists(state.clone(), raw.clone()).is_err());
        assert!(remove_project(state.clone(), raw.clone()).is_err());
        // record_recent with the raw path must not persist it either.
        assert!(record_recent_project(state.clone(), raw.clone(), "x".into(), 1.0).is_err());
        assert_eq!(
            state.recent_entries().unwrap_or_default().len(),
            0,
            "a raw path must never enter the recent store"
        );
        // And the chosen handle works (the intended operation).
        assert_eq!(read_bytes(&app, token).expect("read chosen"), b"chosen");
    }

    // -------------------------------------------------------------------
    // Acceptance: handles permit only their intended operations.
    // -------------------------------------------------------------------

    #[test]
    fn handle_scopes_are_separate_and_bound_to_one_canonical_path() {
        let dir = TempDir::new("scopes");
        let project_file = dir.file("project.vxl");
        std::fs::write(&project_file, b"project").expect("seed project");
        let image_file = dir.file("preview.png");
        std::fs::write(&image_file, b"png").expect("seed image");
        let app = managed_app(None);
        let state = app.state::<NativeScope>();

        let project = state
            .mint_project(dir.canonical("project.vxl"))
            .expect("mint project");
        let image = state
            .mint_image(dir.canonical("preview.png"))
            .expect("mint image");

        // Image token on project commands: rejected (scope mismatch).
        assert!(read_project_bytes(state.clone(), image.clone()).is_err());
        assert!(write_project(state.clone(), image.clone(), vec![1]).is_err());
        assert!(project_exists(state.clone(), image.clone()).is_err());
        assert!(read_backup_bytes(state.clone(), image.clone()).is_err());
        assert!(remove_project(state.clone(), image.clone()).is_err());
        assert!(read_journal_bytes(state.clone(), image.clone()).is_err());
        assert!(append_journal_bytes(state.clone(), image.clone(), vec![1]).is_err());
        assert!(replace_journal_bytes(state.clone(), image.clone(), vec![1]).is_err());
        assert!(remove_journal(state.clone(), image.clone()).is_err());
        // Project token on image commands: rejected (scope mismatch).
        assert!(write_image_bytes_atomic(state.clone(), project.clone(), vec![1]).is_err());
        assert!(image_exists(state.clone(), project.clone()).is_err());

        // Intended operations succeed through the matching handle.
        assert_eq!(
            read_bytes(&app, project.clone()).expect("read project"),
            b"project"
        );
        assert!(project_exists(state.clone(), project.clone()).expect("project exists"));
        assert!(image_exists(state.clone(), image.clone()).expect("image exists"));

        // A project handle can never address a DIFFERENT file: mint a
        // second project and confirm the first token still maps to its own
        // file only.
        let other = dir.file("other.vxl");
        std::fs::write(&other, b"other").expect("seed other");
        let other_token = state
            .mint_project(dir.canonical("other.vxl"))
            .expect("mint other");
        assert_eq!(
            read_bytes(&app, project.clone()).expect("first unchanged"),
            b"project"
        );
        assert_eq!(read_bytes(&app, other_token).expect("second"), b"other");
    }

    #[test]
    fn project_handle_permits_the_full_project_workflow() {
        let dir = TempDir::new("project-flow");
        let project_file = dir.file("flow.vxl");
        std::fs::write(&project_file, b"v1").expect("seed project");
        let app = managed_app(None);
        let state = app.state::<NativeScope>();
        let token = state.mint_project(dir.canonical("flow.vxl")).expect("mint");

        assert_eq!(read_bytes(&app, token.clone()).expect("read v1"), b"v1");
        assert!(project_exists(state.clone(), token.clone()).expect("exists"));

        // Atomic write with backup: destination replaced, backup holds v1.
        let result =
            write_project(state.clone(), token.clone(), b"v2".to_vec()).expect("atomic write");
        assert!(result.backup_created);
        assert_eq!(std::fs::read(&project_file).expect("read v2"), b"v2");
        assert_eq!(
            std::fs::read(dir.file("flow.vxl.bak")).expect("read backup"),
            b"v1"
        );
        assert_eq!(
            read_backup_bytes(state.clone(), token.clone())
                .expect("backup via handle")
                .expect("backup present"),
            b"v1"
        );
        // No stray temp file is left behind (nonce temps are removed).
        assert!(temp_files(&dir).is_empty(), "no temp files remain");

        // Journal: append, read, replace, remove.
        append_journal_bytes(state.clone(), token.clone(), b"frame1".to_vec()).expect("append");
        assert_eq!(
            read_journal_bytes(state.clone(), token.clone())
                .expect("journal read")
                .expect("journal present"),
            b"frame1"
        );
        replace_journal_bytes(state.clone(), token.clone(), b"compacted".to_vec())
            .expect("replace journal");
        assert_eq!(
            read_journal_bytes(state.clone(), token.clone())
                .expect("journal read 2")
                .expect("journal present"),
            b"compacted"
        );
        remove_journal(state.clone(), token.clone()).expect("remove journal");
        assert!(read_journal_bytes(state.clone(), token.clone())
            .expect("journal read 3")
            .is_none());

        // Remove the project; a second remove is not an error.
        remove_project(state.clone(), token.clone()).expect("remove project");
        assert!(!project_file.exists());
        remove_project(state.clone(), token.clone()).expect("second remove ok");
    }

    #[test]
    fn image_handle_permits_only_image_operations() {
        let dir = TempDir::new("image-flow");
        let app = managed_app(None);
        let state = app.state::<NativeScope>();
        let token = state
            .mint_image(dir.canonical("preview-front.png"))
            .expect("mint image");

        assert!(!image_exists(state.clone(), token.clone()).expect("absent"));
        let result = write_image_bytes_atomic(state.clone(), token.clone(), b"png1".to_vec())
            .expect("image write");
        assert!(!result.backup_created);
        assert!(image_exists(state.clone(), token.clone()).expect("present"));
        assert_eq!(
            std::fs::read(dir.file("preview-front.png")).expect("read image"),
            b"png1"
        );
        // Image writes never create backup or journal siblings.
        assert!(!dir.file(".preview-front.png.bak").exists());
        assert!(!dir.file("preview-front.png.journal").exists());
    }

    // -------------------------------------------------------------------
    // Mint-time invariants: canonical absolute paths only.
    // -------------------------------------------------------------------

    #[test]
    fn mint_rejects_relative_and_non_canonical_paths() {
        let dir = TempDir::new("mint");
        let app = managed_app(None);
        let state = app.state::<NativeScope>();

        assert!(state
            .mint_project(PathBuf::from("relative/path.vxl"))
            .is_err());
        assert!(state.mint_image(PathBuf::from("/tmp/no-name/")).is_err());

        // A path through a symlinked directory is not canonical: the
        // dialog commands canonicalize FIRST, and mint must not accept
        // the un-canonicalized form.
        #[cfg(unix)]
        {
            let link = dir.file("link-dir");
            std::os::unix::fs::symlink(&dir.path, &link).expect("symlink dir");
            assert!(state.mint_project(link.join("x.vxl")).is_err());
        }
    }

    #[test]
    fn canonicalize_destination_resolves_symlinks_and_parents() {
        let dir = TempDir::new("canonical");
        // A save destination that does not exist yet: parent resolves.
        let dest = dir.file("new.vxl");
        let canonical = canonicalize_destination(&dest).expect("canonical new");
        assert_eq!(canonical, dir.canonical("new.vxl"));

        // A destination whose NAME is an existing symlink resolves to the
        // link target (the real file the user picked).
        #[cfg(unix)]
        {
            let target = dir.file("target.vxl");
            std::fs::write(&target, b"target").expect("seed target");
            let link = dir.file("linked.vxl");
            std::os::unix::fs::symlink(&target, &link).expect("symlink file");
            let canonical = canonicalize_destination(&link).expect("canonical link");
            assert_eq!(canonical, target.canonicalize().expect("target canonical"));
        }
    }

    #[test]
    fn sanitize_suggested_name_bounds_untrusted_input() {
        assert_eq!(
            sanitize_suggested_name("my project.vxl"),
            Some("my project.vxl".into())
        );
        assert_eq!(sanitize_suggested_name(""), None);
        assert_eq!(sanitize_suggested_name("a/b/c.vxl"), Some("c.vxl".into()));
        assert_eq!(sanitize_suggested_name("a\\b.vxl"), Some("b.vxl".into()));
        assert_eq!(sanitize_suggested_name(".."), Some("..".into())); // dialog-initial text only
        assert!(sanitize_suggested_name("\n").is_none());
    }

    // -------------------------------------------------------------------
    // Symlink variants fail before filesystem access (defense in depth).
    // -------------------------------------------------------------------

    #[cfg(unix)]
    #[test]
    fn planted_symlinks_at_artifacts_are_never_followed() {
        use std::os::unix::fs::symlink;

        let dir = TempDir::new("symlinks");
        let secret = dir.file("secret.txt");
        std::fs::write(&secret, b"top-secret").expect("seed secret");
        let app = managed_app(None);
        let state = app.state::<NativeScope>();
        let project_file = dir.file("proj.vxl");
        std::fs::write(&project_file, b"project").expect("seed project");
        let token = state.mint_project(dir.canonical("proj.vxl")).expect("mint");

        // Symlink at the journal path: append/read/replace must refuse
        // and the secret must stay byte-identical.
        symlink(&secret, dir.file("proj.vxl.journal")).expect("plant journal link");
        assert!(append_journal_bytes(state.clone(), token.clone(), b"x".to_vec()).is_err());
        assert!(read_journal_bytes(state.clone(), token.clone()).is_err());
        // Replace renames over the link (rename never follows), so it
        // succeeds and replaces the planted link with a regular file
        // while the secret stays byte-identical.
        replace_journal_bytes(state.clone(), token.clone(), b"replaced".to_vec()).expect("replace");
        assert_eq!(
            std::fs::read(&secret).expect("secret intact"),
            b"top-secret"
        );
        assert_eq!(
            std::fs::read(dir.file("proj.vxl.journal")).expect("journal replaced"),
            b"replaced"
        );

        // Symlink at the backup path: the write must refuse BEFORE the
        // backup copy (fs::copy would otherwise truncate the link target).
        symlink(&secret, dir.file("proj.vxl.bak")).expect("plant backup link");
        assert!(write_project(state.clone(), token.clone(), b"v2".to_vec()).is_err());
        assert_eq!(
            std::fs::read(&secret).expect("secret intact 2"),
            b"top-secret"
        );
        std::fs::remove_file(dir.file("proj.vxl.bak")).expect("remove backup link");

        // Symlink at a nonce temp path: the phased write must refuse. The
        // destination-temp preflight and the exclusive create both refuse
        // a planted link (O_EXCL fails on an existing link instead of
        // following it); the backup-temp preflight is load-bearing because
        // fs::copy would otherwise follow a planted link and truncate its
        // target. A fixed nonce makes the temp names deterministic.
        symlink(&secret, dir.file(".proj.vxl.attacknonce.tmp")).expect("plant temp link");
        symlink(&secret, dir.file(".proj.vxl.bak.attacknonce.tmp"))
            .expect("plant backup temp link");
        let error = write_project_atomic_cleaned(&project_file, b"v2", "attacknonce", None, None)
            .expect_err("planted temp links must refuse the write");
        assert!(
            error.contains("symbolic link"),
            "the refusal must name the link guard: {error}"
        );
        assert_eq!(
            std::fs::read(&secret).expect("secret intact 3"),
            b"top-secret"
        );
        // The failed write removed both planted temp links as part of its
        // cleanup (the links never existed as our files, but removing them
        // is the same temp cleanup the failure path guarantees).
        assert!(!dir.file(".proj.vxl.attacknonce.tmp").exists());
        assert!(!dir.file(".proj.vxl.bak.attacknonce.tmp").exists());

        // Symlink REPLACING the destination file: reads and existence
        // probes refuse (never an oracle on the link target), and the
        // atomic write refuses instead of backing up through the link.
        std::fs::remove_file(&project_file).expect("remove project");
        symlink(&secret, &project_file).expect("plant destination link");
        assert!(read_bytes(&app, token.clone()).is_err());
        assert!(project_exists(state.clone(), token.clone()).is_err());
        assert!(write_project(state.clone(), token.clone(), b"v2".to_vec()).is_err());
        assert_eq!(
            std::fs::read(&secret).expect("secret intact 4"),
            b"top-secret"
        );

        // A planted symlink at an image destination is refused by the
        // image existence probe and write alike.
        let image_file = dir.file("shot.png");
        std::fs::write(&image_file, b"png").expect("seed image");
        let image_token = state
            .mint_image(dir.canonical("shot.png"))
            .expect("mint image");
        std::fs::remove_file(&image_file).expect("remove image");
        symlink(&secret, &image_file).expect("plant image link");
        assert!(image_exists(state.clone(), image_token.clone()).is_err());
        assert!(
            write_image_bytes_atomic(state.clone(), image_token.clone(), b"x".to_vec()).is_err()
        );
        assert_eq!(
            std::fs::read(&secret).expect("secret intact 5"),
            b"top-secret"
        );

        // A raw symlink path (webview-supplied) is rejected like any raw
        // path, before any filesystem access.
        assert!(
            read_project_bytes(state.clone(), project_file.to_string_lossy().into_owned()).is_err()
        );
    }

    // -------------------------------------------------------------------
    // Recent projects: Rust-owned tokens, bounded, restart-safe.
    // -------------------------------------------------------------------

    #[test]
    fn recent_entries_are_rust_owned_bounded_and_restart_safe() {
        let dir = TempDir::new("recent");
        let project_file = dir.file("recent.vxl");
        std::fs::write(&project_file, b"recent").expect("seed project");
        let app = managed_app(Some(&dir));
        let state = app.state::<NativeScope>();
        let token = state
            .mint_project(dir.canonical("recent.vxl"))
            .expect("mint");

        // Nothing recorded yet.
        assert!(read_recent_projects(state.clone())
            .expect("empty list")
            .is_none());

        record_recent_project(state.clone(), token.clone(), "Recent title".into(), 1234.5)
            .expect("record");
        let entries = read_recent_projects(state.clone())
            .expect("list")
            .expect("entries present");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].token, token);
        assert_eq!(
            entries[0].path,
            dir.canonical("recent.vxl").to_string_lossy()
        );
        assert_eq!(entries[0].title, "Recent title");
        assert_eq!(entries[0].opened_at, 1234.5);

        // A fresh scope (simulating an app restart) loads the store and
        // resolves the persisted token to the same canonical path.
        let restarted = managed_app(Some(&dir));
        restarted.state::<NativeScope>().load_recent();
        assert_eq!(
            read_bytes(&restarted, token.clone()).expect("reopen recent"),
            b"recent"
        );

        // Forge attempts fail: a raw path and a random token never record.
        assert!(
            record_recent_project(state.clone(), "/etc/passwd".into(), "x".into(), 1.0).is_err()
        );
        assert!(record_recent_project(state.clone(), "forged".into(), "x".into(), 1.0).is_err());

        // Bounded: 12 records keep the newest 10.
        for index in 0..12 {
            let name = format!("p{index}.vxl");
            let file = dir.file(&name);
            std::fs::write(&file, format!("p{index}")).expect("seed");
            let t = state.mint_project(dir.canonical(&name)).expect("mint");
            record_recent_project(state.clone(), t, format!("P{index}"), index as f64)
                .expect("record");
        }
        let entries = read_recent_projects(state.clone())
            .expect("list")
            .expect("entries");
        assert_eq!(entries.len(), 10);
        assert_eq!(entries[0].title, "P11");
        assert_eq!(entries[9].title, "P2");

        // Remove by token; a second remove is not an error.
        let first = entries[0].token.clone();
        remove_recent_project(state.clone(), first.clone()).expect("remove");
        assert!(!read_recent_projects(state.clone())
            .expect("list 2")
            .expect("entries 2")
            .iter()
            .any(|entry| entry.token == first));
        remove_recent_project(state.clone(), first).expect("second remove ok");
    }

    #[test]
    fn recent_metadata_is_bounded_and_validated() {
        let dir = TempDir::new("recent-meta");
        let project_file = dir.file("meta.vxl");
        std::fs::write(&project_file, b"meta").expect("seed project");
        let app = managed_app(Some(&dir));
        let state = app.state::<NativeScope>();
        let token = state.mint_project(dir.canonical("meta.vxl")).expect("mint");

        // Non-finite timestamps are rejected.
        assert!(record_recent_project(state.clone(), token.clone(), "t".into(), f64::NAN).is_err());
        // Titles are bounded (the store round-trips a truncated title).
        let long_title = "x".repeat(2000);
        record_recent_project(state.clone(), token.clone(), long_title.clone(), 1.0)
            .expect("record");
        let entries = read_recent_projects(state.clone())
            .expect("list")
            .expect("entries");
        assert_eq!(entries[0].title.len(), 512);
        // A hand-edited store with malformed entries drops them and stays
        // bounded (defense against a locally edited config file).
        std::fs::write(
            dir.file("recent-projects.json"),
            r#"[{"token":"t1","path":"/a/b.vxl","title":"ok","openedAt":1},
                {"token":"","path":"/x","title":"no-token","openedAt":1},
                {"token":"t2","path":"/x","title":"bad-time","openedAt":"NaN"},
                {"token":"t3","path":"/x","title":"ok","openedAt":2}]"#,
        )
        .expect("write edited store");
        let entries = state.recent_entries().expect("parsed entries");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].token, "t1");
        assert_eq!(entries[1].token, "t3");
        // The in-memory map reflects only valid entries after load.
        state.load_recent();
        assert!(state.resolve_project("t1").is_ok());
        assert!(state.resolve_project("t2").is_err());
    }

    // -------------------------------------------------------------------
    // Issue #96: reads preflight against the 512 MiB input-file hard cap.
    // -------------------------------------------------------------------

    #[test]
    fn reads_reject_inputs_above_the_512_mib_cap_before_reading() {
        let dir = TempDir::new("oversized");
        let app = managed_app(None);
        let state = app.state::<NativeScope>();

        // Sparse files: 512 MiB + 1 logical bytes with no backing blocks,
        // so passing only proves the metadata preflight rejected them
        // before any body bytes were read or copied.
        let project = dir.canonical("oversized.vxl");
        std::fs::File::create(&project)
            .expect("create project")
            .set_len(MAX_INPUT_FILE_BYTES + 1)
            .expect("sparse project");
        let token = state.mint_project(project).expect("mint project");
        let error = match read_project_bytes(state.clone(), token) {
            Ok(_) => panic!("expected the limit rejection"),
            Err(error) => error,
        };
        assert!(error.contains("512 MiB"), "unexpected error: {error}");

        let backup_base = dir.canonical("backup.vxl");
        std::fs::File::create(&backup_base)
            .expect("create backup base")
            .set_len(1)
            .expect("backup base");
        std::fs::File::create(dir.file("backup.vxl.bak"))
            .expect("create backup")
            .set_len(MAX_INPUT_FILE_BYTES + 1)
            .expect("sparse backup");
        let token = state.mint_project(backup_base).expect("mint backup");
        let error = match read_backup_bytes(state.clone(), token) {
            Ok(_) => panic!("expected the limit rejection"),
            Err(error) => error,
        };
        assert!(error.contains("512 MiB"), "unexpected error: {error}");

        let journal_base = dir.canonical("journal.vxl");
        std::fs::File::create(&journal_base)
            .expect("create journal base")
            .set_len(1)
            .expect("journal base");
        std::fs::File::create(dir.file("journal.vxl.journal"))
            .expect("create journal")
            .set_len(MAX_INPUT_FILE_BYTES + 1)
            .expect("sparse journal");
        let token = state.mint_project(journal_base).expect("mint journal");
        let error = match read_journal_bytes(state.clone(), token) {
            Ok(_) => panic!("expected the limit rejection"),
            Err(error) => error,
        };
        assert!(error.contains("512 MiB"), "unexpected error: {error}");
    }

    #[test]
    fn reads_reject_non_regular_paths_and_read_regular_files() {
        let dir = TempDir::new("regular");
        let app = managed_app(None);
        let state = app.state::<NativeScope>();

        let directory = dir.file("directory.vxl");
        std::fs::create_dir(&directory).expect("create directory");
        let token = state
            .mint_project(directory.canonicalize().expect("canonical directory"))
            .expect("mint directory");
        let error = match read_project_bytes(state.clone(), token) {
            Ok(_) => panic!("expected the limit rejection"),
            Err(error) => error,
        };
        assert!(
            error.contains("not a regular file"),
            "unexpected error: {error}"
        );

        let project = dir.canonical("regular.vxl");
        std::fs::write(&project, b"hello").expect("write project");
        let token = state.mint_project(project).expect("mint project");
        let bytes = read_bytes(&app, token).expect("read project");
        assert_eq!(bytes, b"hello");
    }

    // -------------------------------------------------------------------
    // Issue #120: the frozen atomic-save phases
    // (docs/storage/atomic-save-v1.md). This native matrix mirrors the
    // storage-port conformance cases: destination and backup stay
    // byte-identical under every injected phase failure, every temporary
    // file is removed, readBackup returns the previous destination, and
    // cancellation interrupts the write before the replace.
    // -------------------------------------------------------------------

    #[test]
    fn atomic_write_round_trips_and_reports_result_fields() {
        let dir = TempDir::new("issue120-roundtrip");
        let app = managed_app(None);
        let state = app.state::<NativeScope>();
        let token = state
            .mint_project(dir.canonical("roundtrip.vxl"))
            .expect("mint");

        let result = write_project(state.clone(), token.clone(), b"version-one".to_vec())
            .expect("atomic write");
        assert!(!result.backup_created, "first save has no backup");
        assert!(
            result.directory_sync_succeeded,
            "directory sync succeeds on a normal save"
        );
        assert_eq!(
            read_bytes(&app, token.clone()).expect("read project"),
            b"version-one"
        );
        assert!(
            temp_files(&dir).is_empty(),
            "no temporary files remain after success"
        );
    }

    #[test]
    fn first_save_has_no_backup_second_save_preserves_the_previous_destination() {
        let dir = TempDir::new("issue120-backup");
        let app = managed_app(None);
        let state = app.state::<NativeScope>();
        let token = state
            .mint_project(dir.canonical("backup.vxl"))
            .expect("mint");

        let first = write_project(state.clone(), token.clone(), b"v0".to_vec()).expect("first");
        assert!(!first.backup_created, "first save must not create a backup");
        assert!(
            read_backup_bytes(state.clone(), token.clone())
                .expect("backup read")
                .is_none(),
            "no backup after the first save"
        );

        let second = write_project(state.clone(), token.clone(), b"v1".to_vec()).expect("second");
        assert!(second.backup_created, "second save must create a backup");
        assert_eq!(
            second.backup_path.as_deref(),
            Some(dir.canonical("backup.vxl.bak").to_string_lossy().as_ref()),
            "backup is the adjacent standard-name sibling"
        );
        assert_eq!(
            read_backup_bytes(state.clone(), token.clone())
                .expect("backup read")
                .expect("backup present"),
            b"v0",
            "backup holds the previous destination"
        );
        assert_eq!(
            read_bytes(&app, token.clone()).expect("read project"),
            b"v1",
            "destination holds the new bytes"
        );
        assert!(temp_files(&dir).is_empty(), "no temp files remain");
    }

    #[test]
    fn a_failure_at_every_phase_leaves_destination_and_backup_untouched_and_removes_temps() {
        let phases = [
            AtomicWritePhase::CreateTemp,
            AtomicWritePhase::WriteTemp,
            AtomicWritePhase::FlushTemp,
            AtomicWritePhase::Backup,
            AtomicWritePhase::Replace,
        ];
        for phase in phases {
            let dir = TempDir::new(&format!("issue120-fault-{phase:?}"));
            let app = managed_app(None);
            let state = app.state::<NativeScope>();
            let token = state
                .mint_project(dir.canonical("fault.vxl"))
                .expect("mint");
            write_project(state.clone(), token.clone(), b"v0".to_vec()).expect("seed v0");
            write_project(state.clone(), token.clone(), b"v1".to_vec())
                .expect("seed v1 (backup v0)");

            let plan = AtomicWriteFaultPlan {
                fail_at: Some(vec![phase]),
            };
            let error = write_project_with(
                state.clone(),
                token.clone(),
                b"v2".to_vec(),
                None,
                Some(plan),
            )
            .expect_err("the injected phase failure must fail the write");
            let code = phase_contract(phase).code;
            assert!(
                error.starts_with(&format!("{code}:")),
                "{phase:?} must fail with {code}: {error}"
            );

            let expected_backup: &[u8] = if phase == AtomicWritePhase::Replace {
                b"v1"
            } else {
                b"v0"
            };
            assert_eq!(
                read_backup_bytes(state.clone(), token.clone())
                    .expect("backup read")
                    .expect("backup present"),
                expected_backup,
                "backup holds the last-known-good destination after {phase:?} failure"
            );
            assert_eq!(
                read_bytes(&app, token.clone()).expect("read project"),
                b"v1",
                "destination untouched after {phase:?} failure"
            );
            assert!(
                temp_files(&dir).is_empty(),
                "no temporary file remains after {phase:?} failure"
            );
        }
    }

    #[test]
    fn directory_sync_failure_is_best_effort_and_never_fails_the_save() {
        let dir = TempDir::new("issue120-sync");
        let app = managed_app(None);
        let state = app.state::<NativeScope>();
        let token = state.mint_project(dir.canonical("sync.vxl")).expect("mint");

        let plan = AtomicWriteFaultPlan {
            fail_at: Some(vec![AtomicWritePhase::SyncDirectory]),
        };
        let result = write_project_with(
            state.clone(),
            token.clone(),
            b"v1".to_vec(),
            None,
            Some(plan),
        )
        .expect("a directory-sync fault never fails the save");
        assert!(
            !result.directory_sync_succeeded,
            "the result reports the sync failure"
        );
        assert_eq!(
            read_bytes(&app, token.clone()).expect("read project"),
            b"v1",
            "the save still succeeded"
        );
        assert!(temp_files(&dir).is_empty(), "no temp files remain");
    }

    #[test]
    fn a_cancelled_write_interrupts_before_replace_and_removes_temps() {
        let dir = TempDir::new("issue120-cancel");
        let app = managed_app(None);
        let state = app.state::<NativeScope>();
        let token = state
            .mint_project(dir.canonical("cancel.vxl"))
            .expect("mint");
        write_project(state.clone(), token.clone(), b"v0".to_vec()).expect("seed v0");

        // First save with no backup yet: an aborted write must leave the
        // destination and the (absent) backup untouched.
        let cancel_token = "issue120-cancel-token".to_string();
        assert!(state.register_cancel(&cancel_token).is_some());
        state.cancel_write(&cancel_token);
        let error = write_project_with(
            state.clone(),
            token.clone(),
            b"v1".to_vec(),
            Some(cancel_token.clone()),
            None,
        )
        .expect_err("a cancelled write must be interrupted");
        assert!(
            error.starts_with(&format!("{IO_WRITE_INTERRUPTED}:")),
            "unexpected error: {error}"
        );
        assert_eq!(
            read_bytes(&app, token.clone()).expect("read project"),
            b"v0",
            "destination untouched"
        );
        assert!(
            read_backup_bytes(state.clone(), token.clone())
                .expect("backup read")
                .is_none(),
            "backup untouched"
        );
        // Second interrupted write after a successful one: the latest good
        // destination and its backup stay readable.
        write_project(state.clone(), token.clone(), b"v1".to_vec()).expect("seed v1");
        assert!(state.register_cancel(&cancel_token).is_some());
        state.cancel_write(&cancel_token);
        let error = write_project_with(
            state.clone(),
            token.clone(),
            b"v2".to_vec(),
            Some(cancel_token.clone()),
            None,
        )
        .expect_err("a second cancelled write must be interrupted");
        assert!(error.starts_with(&format!("{IO_WRITE_INTERRUPTED}:")));
        assert_eq!(
            read_bytes(&app, token.clone()).expect("read project"),
            b"v1",
            "latest good version intact"
        );
        assert_eq!(
            read_backup_bytes(state.clone(), token.clone())
                .expect("backup read")
                .expect("backup present"),
            b"v0",
            "backup intact"
        );
        assert!(temp_files(&dir).is_empty(), "temporary files removed");

        // The token is cleaned up when the write finishes: reusing the
        // same token for a later write must see a FRESH (uncancelled)
        // flag, so the write succeeds instead of being interrupted again.
        write_project_with(
            state.clone(),
            token.clone(),
            b"v2".to_vec(),
            Some(cancel_token.clone()),
            None,
        )
        .expect("a later write with the same token succeeds");
        assert_eq!(
            read_bytes(&app, token.clone()).expect("read project"),
            b"v2"
        );
        assert_eq!(
            read_backup_bytes(state.clone(), token.clone())
                .expect("backup read")
                .expect("backup present"),
            b"v1",
            "the later write preserved the previous destination"
        );
    }

    #[test]
    fn cancelling_an_unknown_token_is_not_an_error_and_tokens_are_bounded() {
        let app = managed_app(None);
        let state = app.state::<NativeScope>();
        // Unknown token: the write already finished (or never started).
        assert!(cancel_project_write(state, "no-such-token".to_string()).is_ok());
        // Empty and oversized tokens are rejected before any registry use.
        assert!(cancel_project_write(app.state::<NativeScope>(), String::new()).is_err());
        assert!(cancel_project_write(
            app.state::<NativeScope>(),
            "x".repeat(MAX_CANCEL_TOKEN_CHARS + 1),
        )
        .is_err());
    }

    #[test]
    fn write_command_rejects_empty_or_oversized_cancel_tokens() {
        let dir = TempDir::new("issue120-token-bounds");
        let app = managed_app(None);
        let state = app.state::<NativeScope>();
        let token = state
            .mint_project(dir.canonical("bounds.vxl"))
            .expect("mint");

        assert!(
            write_project_with(
                state.clone(),
                token.clone(),
                b"v1".to_vec(),
                Some(String::new()),
                None
            )
            .is_err(),
            "an empty cancel token is rejected"
        );
        assert!(
            write_project_with(
                state.clone(),
                token.clone(),
                b"v1".to_vec(),
                Some("x".repeat(MAX_CANCEL_TOKEN_CHARS + 1)),
                None,
            )
            .is_err(),
            "an oversized cancel token is rejected"
        );
        assert!(
            !dir.file("bounds.vxl").exists(),
            "rejected writes never touch the destination"
        );
        assert!(temp_files(&dir).is_empty(), "no temp files remain");
    }

    #[test]
    fn read_errors_carry_stable_io_codes() {
        let dir = TempDir::new("issue120-read-codes");
        let app = managed_app(None);
        let state = app.state::<NativeScope>();
        let token = state
            .mint_project(dir.canonical("missing.vxl"))
            .expect("mint");

        let error = match read_project_bytes(state.clone(), token.clone()) {
            Ok(_) => panic!("reading a missing project must fail"),
            Err(error) => error,
        };
        assert!(
            error.starts_with(&format!("{IO_NOT_FOUND}:")),
            "missing reads reject IO_NOT_FOUND: {error}"
        );
        // A missing backup is a normal state, not an error.
        assert!(
            read_backup_bytes(state, token)
                .expect("backup read")
                .is_none(),
            "missing backup reads resolve None"
        );
    }

    #[test]
    fn a_stale_temp_from_a_crashed_process_is_never_reused_or_truncated() {
        let dir = TempDir::new("issue120-crash");
        let app = managed_app(None);
        let state = app.state::<NativeScope>();
        let token = state
            .mint_project(dir.canonical("crash.vxl"))
            .expect("mint");
        write_project(state.clone(), token.clone(), b"v1".to_vec()).expect("seed v1");

        // Simulate a process that died mid-write: its nonce temp survives
        // with partial bytes (and no fsync). The next save must use a
        // FRESH nonce and must never reuse or truncate the stale temp.
        let stale = dir.file(".crash.vxl.stalenonce.tmp");
        std::fs::write(&stale, b"partial").expect("plant stale temp");
        let stale_backup = dir.file(".crash.vxl.bak.stalenonce.tmp");
        std::fs::write(&stale_backup, b"partial-backup").expect("plant stale backup temp");

        write_project(state.clone(), token.clone(), b"v2".to_vec()).expect("write succeeds");
        assert_eq!(
            read_bytes(&app, token.clone()).expect("read project"),
            b"v2",
            "the fresh save replaced the destination"
        );
        assert_eq!(
            read_backup_bytes(state.clone(), token.clone())
                .expect("backup read")
                .expect("backup present"),
            b"v1",
            "the fresh save preserved the previous destination"
        );
        // The stale crash artifacts are untouched (exclusive creation
        // never opens an existing nonce temp) and the fresh temps are gone.
        assert_eq!(
            std::fs::read(&stale).expect("stale temp untouched"),
            b"partial"
        );
        assert_eq!(
            std::fs::read(&stale_backup).expect("stale backup temp untouched"),
            b"partial-backup"
        );
        assert_eq!(
            temp_files(&dir),
            vec![
                ".crash.vxl.bak.stalenonce.tmp".to_string(),
                ".crash.vxl.stalenonce.tmp".to_string(),
            ],
            "only the stale crash artifacts remain"
        );
    }

    #[cfg(unix)]
    #[test]
    fn real_permission_failures_classify_and_clean_up() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new("issue120-perms");
        let app = managed_app(None);
        let state = app.state::<NativeScope>();
        let token = state
            .mint_project(dir.canonical("perms.vxl"))
            .expect("mint");

        // Skip under root, where permission enforcement is disabled.
        let probe = dir.file("probe");
        if std::fs::write(&probe, b"x").is_ok() {
            return;
        }
        std::fs::set_permissions(&dir.path, std::fs::Permissions::from_mode(0o555))
            .expect("chmod read-only");
        let error = write_project(state.clone(), token.clone(), b"v1".to_vec())
            .expect_err("a read-only project directory must fail the write");
        std::fs::set_permissions(&dir.path, std::fs::Permissions::from_mode(0o755))
            .expect("restore permissions");
        assert!(
            error.starts_with(&format!("{IO_PERMISSION_DENIED}:")),
            "permission failures classify as IO_PERMISSION_DENIED: {error}"
        );
        assert!(
            temp_files(&dir).is_empty(),
            "the failed write removed its temporary file"
        );
    }
}
