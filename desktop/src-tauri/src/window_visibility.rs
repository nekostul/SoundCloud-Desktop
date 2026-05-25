#[cfg(target_os = "windows")]
mod platform {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use tauri::{Runtime, WebviewWindow, Window};
    use windows_sys::Win32::Foundation::{HWND, RECT};
    use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetTopWindow, GetWindow, GetWindowLongPtrW, GetWindowRect, IsIconic, IsWindowVisible,
        GWL_EXSTYLE, GW_HWNDNEXT, GW_OWNER, WS_EX_TOOLWINDOW,
    };

    #[derive(Clone, Copy)]
    struct WindowRect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    impl WindowRect {
        fn area(self) -> i64 {
            i64::from((self.right - self.left).max(0)) * i64::from((self.bottom - self.top).max(0))
        }

        fn intersection(self, other: Self) -> Option<Self> {
            let rect = Self {
                left: self.left.max(other.left),
                top: self.top.max(other.top),
                right: self.right.min(other.right),
                bottom: self.bottom.min(other.bottom),
            };

            (rect.area() > 0).then_some(rect)
        }
    }

    fn subtract_cover(source: WindowRect, cover: WindowRect) -> Vec<WindowRect> {
        let Some(hit) = source.intersection(cover) else {
            return vec![source];
        };

        let mut rest = Vec::with_capacity(4);
        let mut push_rect = |rect: WindowRect| {
            if rect.area() > 0 {
                rest.push(rect);
            }
        };

        push_rect(WindowRect {
            left: source.left,
            top: source.top,
            right: source.right,
            bottom: hit.top,
        });
        push_rect(WindowRect {
            left: source.left,
            top: hit.bottom,
            right: source.right,
            bottom: source.bottom,
        });
        push_rect(WindowRect {
            left: source.left,
            top: hit.top,
            right: hit.left,
            bottom: hit.bottom,
        });
        push_rect(WindowRect {
            left: hit.right,
            top: hit.top,
            right: source.right,
            bottom: hit.bottom,
        });

        rest
    }

    trait VisibilityHandle: HasWindowHandle {
        fn is_tauri_visible(&self) -> bool;
        fn is_tauri_minimized(&self) -> bool;
    }

    impl<R: Runtime> VisibilityHandle for Window<R> {
        fn is_tauri_visible(&self) -> bool {
            self.is_visible().unwrap_or(true)
        }

        fn is_tauri_minimized(&self) -> bool {
            self.is_minimized().unwrap_or(false)
        }
    }

    impl<R: Runtime> VisibilityHandle for WebviewWindow<R> {
        fn is_tauri_visible(&self) -> bool {
            self.is_visible().unwrap_or(true)
        }

        fn is_tauri_minimized(&self) -> bool {
            self.is_minimized().unwrap_or(false)
        }
    }

    fn hwnd_from_window(window: &impl HasWindowHandle) -> Option<HWND> {
        let handle = window.window_handle().ok()?;

        match handle.as_raw() {
            RawWindowHandle::Win32(handle) => Some(handle.hwnd.get() as HWND),
            _ => None,
        }
    }

    fn rect_from_hwnd(hwnd: HWND) -> Option<WindowRect> {
        let mut rect = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };

        if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
            return None;
        }

        let rect = WindowRect {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
        };

        (rect.area() > 0).then_some(rect)
    }

    fn is_dwm_cloaked(hwnd: HWND) -> bool {
        let mut cloaked = 0_u32;
        let result = unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED as u32,
                (&mut cloaked as *mut u32).cast(),
                std::mem::size_of::<u32>() as u32,
            )
        };

        result == 0 && cloaked != 0
    }

    fn can_cover_target(hwnd: HWND, target_hwnd: HWND) -> bool {
        if hwnd.is_null() || hwnd == target_hwnd {
            return false;
        }

        if unsafe { IsWindowVisible(hwnd) } == 0 || unsafe { IsIconic(hwnd) } != 0 {
            return false;
        }

        let has_owner = !unsafe { GetWindow(hwnd, GW_OWNER) }.is_null();
        let ex_style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32;
        if has_owner && (ex_style & WS_EX_TOOLWINDOW) != 0 {
            return false;
        }

        !is_dwm_cloaked(hwnd)
    }

    fn is_mostly_covered(target_hwnd: HWND, target_rect: WindowRect) -> bool {
        let target_area = target_rect.area();
        if target_area <= 0 {
            return true;
        }

        let mut uncovered = vec![target_rect];
        let mut hwnd = unsafe { GetTopWindow(std::ptr::null_mut()) };

        while !hwnd.is_null() {
            if hwnd == target_hwnd {
                break;
            }

            if can_cover_target(hwnd, target_hwnd) {
                if let Some(cover_rect) =
                    rect_from_hwnd(hwnd).and_then(|rect| rect.intersection(target_rect))
                {
                    let mut next_uncovered = Vec::new();
                    for rect in uncovered {
                        next_uncovered.extend(subtract_cover(rect, cover_rect));
                    }
                    uncovered = next_uncovered;

                    let visible_area = uncovered.iter().map(|rect| rect.area()).sum::<i64>();
                    if visible_area * 100 < target_area * 2 {
                        return true;
                    }
                }
            }

            hwnd = unsafe { GetWindow(hwnd, GW_HWNDNEXT) };
        }

        false
    }

    fn is_visible_to_user(window: &impl VisibilityHandle) -> bool {
        if !window.is_tauri_visible() || window.is_tauri_minimized() {
            return false;
        }

        let Some(target_hwnd) = hwnd_from_window(window) else {
            return true;
        };
        let Some(target_rect) = rect_from_hwnd(target_hwnd) else {
            return true;
        };

        !is_mostly_covered(target_hwnd, target_rect)
    }

    pub fn is_window_visible_to_user(window: &Window) -> bool {
        is_visible_to_user(window)
    }

    pub fn is_webview_window_visible_to_user(window: &WebviewWindow) -> bool {
        is_visible_to_user(window)
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    use tauri::{WebviewWindow, Window};

    pub fn is_window_visible_to_user(window: &Window) -> bool {
        window.is_visible().unwrap_or(true) && !window.is_minimized().unwrap_or(false)
    }

    pub fn is_webview_window_visible_to_user(window: &WebviewWindow) -> bool {
        window.is_visible().unwrap_or(true) && !window.is_minimized().unwrap_or(false)
    }
}

pub use platform::{is_webview_window_visible_to_user, is_window_visible_to_user};
