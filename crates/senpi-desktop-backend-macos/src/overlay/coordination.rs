//! Visible panels hold shared locks; an agent capture holds the exclusive lock.
//! Separate processes use separate file handles, and exit releases the locks.
use std::fs::{File, OpenOptions, TryLockError};
use std::io;
use std::path::{Path, PathBuf};

pub(super) fn path() -> PathBuf {
    // Use the OS account home, not per-session HOME overrides.
    PathBuf::from(objc2_foundation::NSHomeDirectory().to_string())
        .join("Library/Caches/omo/cursor-overlay.lock")
}

pub(super) fn open(path: &Path) -> io::Result<File> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    OpenOptions::new().read(true).write(true).create(true).truncate(false).open(path)
}

pub(super) fn visible(file: File) -> io::Result<Option<File>> {
    match file.try_lock_shared() {
        Ok(()) => Ok(Some(file)),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(error)) => Err(error),
    }
}

pub(super) fn capture(file: File) -> io::Result<File> {
    file.try_lock().map_err(io::Error::other)?;
    Ok(file)
}

#[cfg(test)]
#[path = "coordination_tests.rs"]
mod tests;
