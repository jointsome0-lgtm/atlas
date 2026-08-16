//! The POSIX calls Bun does not expose.
//!
//! Bun already reaches every operation that takes a file descriptor: `fstat`,
//! `fsync`, `ftruncate`, `close`, and read/write at an explicit offset. What it
//! has no spelling for is the `*at()` family — naming a child *relative to an
//! open directory* — and iterating a directory the caller already holds open.
//! Without those a path has to be re-resolved from its root at every step, and
//! a component checked in one step can be a different file by the next. That is
//! the gap this crate closes, and it closes nothing else.
//!
//! Nothing here knows what Atlas is. There are no node kinds, no schemas, no
//! journal rows, no instance paths, no reason codes, no diagnostic strings.
//! Every policy question — which flags to pass, whether a mode is acceptable,
//! what a name means, what to do about an error — belongs to the caller. This
//! file answers one question only: what did the kernel say?
//!
//! Errors are returned, never raised: a negative return is `-errno` exactly as
//! the kernel reported it, so the caller can tell `ELOOP` from `ENOENT` from
//! `ENOTDIR` rather than reading an English sentence. No function panics, and
//! no function unwinds across the boundary.
//!
//! The crate is `no_std` and allocates nothing. That is not thrift: it means
//! `nm -D -u` on the built library lists the exact set of calls the boundary
//! makes, so "domain-blind" is something a reviewer can check in one command
//! rather than something the prose asserts.

#![no_std]

use core::ffi::{c_char, c_int, c_uint, c_void};
use core::panic::PanicInfo;

unsafe extern "C" {
    fn abort() -> !;
}

/// Unreachable — no function here can panic. It exists because a `no_std`
/// library must name what would happen if one did, and the honest answer at a
/// C boundary is "stop", not "unwind into a caller that cannot catch it".
#[panic_handler]
fn panic(_info: &PanicInfo) -> ! {
    unsafe { abort() }
}

// The libc entry points, declared here rather than pulled from a crate. These
// are the stable POSIX/Linux ABI; declaring them keeps the dependency count at
// zero and the build hermetic.
unsafe extern "C" {
    fn openat(dirfd: c_int, pathname: *const c_char, flags: c_int, ...) -> c_int;
    fn renameat(
        olddirfd: c_int,
        oldpath: *const c_char,
        newdirfd: c_int,
        newpath: *const c_char,
    ) -> c_int;
    fn unlinkat(dirfd: c_int, pathname: *const c_char, flags: c_int) -> c_int;
    fn mkdirat(dirfd: c_int, pathname: *const c_char, mode: c_uint) -> c_int;
    fn statx(
        dirfd: c_int,
        pathname: *const c_char,
        flags: c_int,
        mask: c_uint,
        statxbuf: *mut Statx,
    ) -> c_int;
    fn fdopendir(fd: c_int) -> *mut c_void;
    fn readdir(dirp: *mut c_void) -> *mut Dirent;
    fn closedir(dirp: *mut c_void) -> c_int;
    fn close(fd: c_int) -> c_int;
    fn __errno_location() -> *mut c_int;
}

/// `struct statx` — a kernel ABI, identical on every architecture, which is why
/// it is preferable to hand-declaring `struct stat`. Only `mode` and `size` are
/// read; the rest is carried so the layout is right.
#[repr(C)]
struct Statx {
    mask: u32,
    blksize: u32,
    attributes: u64,
    nlink: u32,
    uid: u32,
    gid: u32,
    mode: u16,
    _spare0: u16,
    ino: u64,
    size: u64,
    blocks: u64,
    attributes_mask: u64,
    // Timestamps, device numbers and reserved words. Never read, present so the
    // kernel writes inside the allocation and not past it.
    _tail: [u64; 24],
}

// `statx` writes a fixed 256 bytes whatever the caller believes, so a struct
// that is one word short is a stack overwrite the compiler cannot see and a
// test can only catch by crashing. It has already happened once.
const _: () = assert!(core::mem::size_of::<Statx>() == 256);

// The name is read at a fixed offset into the record glibc hands back; if that
// offset ever moves, every listed name becomes garbage rather than an error.
const _: () = assert!(core::mem::offset_of!(Dirent, d_name) == 19);

/// `struct dirent64` — the `getdents64` ABI. Only `d_name` is read.
#[repr(C)]
struct Dirent {
    d_ino: u64,
    d_off: i64,
    d_reclen: u16,
    d_type: u8,
    d_name: [c_char; 256],
}

const STATX_TYPE: c_uint = 0x0000_0001;
const STATX_MODE: c_uint = 0x0000_0002;
const STATX_SIZE: c_uint = 0x0000_0200;

const O_RDONLY: c_int = 0;
const O_DIRECTORY: c_int = 0o200_000;
const O_CLOEXEC: c_int = 0o2_000_000;

const DOT: &[u8] = b".\0";

/// The last error the C library recorded, as a negative number.
///
/// A call that fails without setting `errno` would otherwise report success;
/// `EIO` is the honest stand-in for "it failed and would not say why".
fn last_error() -> i64 {
    let raw = unsafe { *__errno_location() };
    if raw <= 0 { -5 } else { -(raw as i64) }
}

fn clear_error() {
    unsafe { *__errno_location() = 0 };
}

/// Open `path` relative to the open directory `dirfd`.
///
/// The caller chooses the flags, including whether a symbolic link is followed:
/// this crate has no opinion about containment. Returns the new descriptor, or
/// `-errno`.
#[unsafe(no_mangle)]
pub extern "C" fn atlas_openat(
    dirfd: c_int,
    path: *const c_char,
    flags: c_int,
    mode: c_uint,
) -> i64 {
    if path.is_null() {
        return -22; // EINVAL
    }
    let fd = unsafe { openat(dirfd, path, flags, mode) };
    if fd < 0 { last_error() } else { fd as i64 }
}

/// Stat `path` relative to `dirfd`, writing the mode and size the caller asked
/// for into `out_mode` and `out_size`.
///
/// `flags` is passed through untouched — `AT_SYMLINK_NOFOLLOW` and
/// `AT_EMPTY_PATH` are the caller's decision, not this crate's. Returns 0 or
/// `-errno`.
#[unsafe(no_mangle)]
pub extern "C" fn atlas_statat(
    dirfd: c_int,
    path: *const c_char,
    flags: c_int,
    out_mode: *mut u32,
    out_size: *mut u64,
) -> i64 {
    if path.is_null() || out_mode.is_null() || out_size.is_null() {
        return -22; // EINVAL
    }
    let mut buf: Statx = unsafe { core::mem::zeroed() };
    let rc = unsafe {
        statx(
            dirfd,
            path,
            flags,
            STATX_TYPE | STATX_MODE | STATX_SIZE,
            &mut buf,
        )
    };
    if rc < 0 {
        return last_error();
    }
    // The kernel may answer with less than was asked. Reporting a zero mode as
    // if it were real would turn "unknown" into "not a regular file".
    if buf.mask & (STATX_TYPE | STATX_MODE) != (STATX_TYPE | STATX_MODE) {
        return -61; // ENODATA
    }
    if buf.mask & STATX_SIZE == 0 {
        return -61; // ENODATA
    }
    unsafe {
        *out_mode = buf.mode as u32;
        *out_size = buf.size;
    }
    0
}

/// Rename `old_path` under `old_dirfd` to `new_path` under `new_dirfd`.
#[unsafe(no_mangle)]
pub extern "C" fn atlas_renameat(
    old_dirfd: c_int,
    old_path: *const c_char,
    new_dirfd: c_int,
    new_path: *const c_char,
) -> i64 {
    if old_path.is_null() || new_path.is_null() {
        return -22; // EINVAL
    }
    let rc = unsafe { renameat(old_dirfd, old_path, new_dirfd, new_path) };
    if rc < 0 { last_error() } else { 0 }
}

/// Unlink `path` relative to `dirfd`. `AT_REMOVEDIR` is the caller's to pass.
#[unsafe(no_mangle)]
pub extern "C" fn atlas_unlinkat(dirfd: c_int, path: *const c_char, flags: c_int) -> i64 {
    if path.is_null() {
        return -22; // EINVAL
    }
    let rc = unsafe { unlinkat(dirfd, path, flags) };
    if rc < 0 { last_error() } else { 0 }
}

/// Create a directory named `path` relative to `dirfd`.
#[unsafe(no_mangle)]
pub extern "C" fn atlas_mkdirat(dirfd: c_int, path: *const c_char, mode: c_uint) -> i64 {
    if path.is_null() {
        return -22; // EINVAL
    }
    let rc = unsafe { mkdirat(dirfd, path, mode) };
    if rc < 0 { last_error() } else { 0 }
}

/// List the names directly inside the open directory `dirfd`.
///
/// Names are written to `out` as `[u16 length, little-endian][length bytes]`,
/// one record each, in whatever order the filesystem returns them — sorting is
/// meaning, and meaning is the caller's. `.` and `..` are omitted; every caller
/// of a directory listing drops them, and they are the two names that are not
/// children.
///
/// A name is raw bytes. Whether it is valid UTF-8, and what follows if it is
/// not, is decided above this boundary.
///
/// Returns the number of bytes the listing needs. If that is larger than
/// `out_len` the buffer holds an arbitrary prefix of the listing and must be
/// ignored, not parsed: the caller retries with a buffer of the returned size.
/// A negative return is `-errno`.
#[unsafe(no_mangle)]
pub extern "C" fn atlas_readdir(dirfd: c_int, out: *mut u8, out_len: usize) -> i64 {
    if out.is_null() && out_len != 0 {
        return -22; // EINVAL
    }

    // `fdopendir` takes ownership of the descriptor it is given, and inherits
    // its current position. Reopening the directory through itself yields a
    // fresh, independent one, so the caller's descriptor is neither consumed
    // nor rewound. `.` is the one name that can never be a symbolic link.
    let owned = unsafe {
        openat(
            dirfd,
            DOT.as_ptr() as *const c_char,
            O_RDONLY | O_DIRECTORY | O_CLOEXEC,
            0 as c_uint,
        )
    };
    if owned < 0 {
        return last_error();
    }
    let dir = unsafe { fdopendir(owned) };
    if dir.is_null() {
        let err = last_error();
        unsafe { close(owned) };
        return err;
    }

    let mut needed: usize = 0;
    let mut written: usize = 0;
    let mut failure: i64 = 0;

    loop {
        clear_error();
        let entry = unsafe { readdir(dir) };
        if entry.is_null() {
            // NULL is both "end of directory" and "it went wrong"; only errno
            // tells them apart, which is why it was cleared first.
            let raw = unsafe { *__errno_location() };
            if raw != 0 {
                failure = -(raw as i64);
            }
            break;
        }

        let name = unsafe { (&raw const (*entry).d_name) as *const c_char };
        let mut len: usize = 0;
        while unsafe { *name.add(len) } != 0 {
            len += 1;
            if len > 255 {
                break;
            }
        }

        let bytes = unsafe { core::slice::from_raw_parts(name as *const u8, len) };
        if bytes == b"." || bytes == b".." {
            continue;
        }

        needed = needed.saturating_add(2 + len);
        if needed <= out_len {
            unsafe {
                let head = out.add(written);
                let encoded = (len as u16).to_le_bytes();
                *head = encoded[0];
                *head.add(1) = encoded[1];
                core::ptr::copy_nonoverlapping(bytes.as_ptr(), head.add(2), len);
            }
            written += 2 + len;
        }
    }

    unsafe { closedir(dir) };

    if failure != 0 {
        return failure;
    }
    needed as i64
}
