
    // --- PWA Meta Tag Injection for Safari Mobile ---
    (function() {
      const ua = navigator.userAgent;
      const isSafariMobile = /iPhone|iPad|iPod/.test(ua) && /AppleWebKit/.test(ua) && !/CriOS/.test(ua) && !/FxiOS/.test(ua);
      if (isSafariMobile) {
        const head = document.head;
        let metaCapable = document.createElement('meta');
        metaCapable.name = 'apple-mobile-web-app-capable';
        metaCapable.content = 'yes';
        head.appendChild(metaCapable);
        let metaStatusBarStyle = document.createElement('meta');
        metaStatusBarStyle.name = 'apple-mobile-web-app-status-bar-style';
        metaStatusBarStyle.content = 'black-translucent';
        head.appendChild(metaStatusBarStyle);
        let metaTitle = document.createElement('meta');
        metaTitle.name = 'apple-mobile-web-app-title';
        metaTitle.content = 'Live DVR';
        head.appendChild(metaTitle);
        console.log("Safari Mobile detected: Added PWA meta tags.");
      }
    })();

    export const IS_MOBILE = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    export const IS_SAFARI_MOBILE = IS_MOBILE && /iPhone|iPad|iPod/.test(navigator.userAgent) && /AppleWebKit/.test(navigator.userAgent) && !/CriOS/.test(navigator.userAgent) && !/FxiOS/.test(navigator.userAgent);
    if (IS_MOBILE) {
      document.documentElement.classList.add("mobile");
      if (IS_SAFARI_MOBILE) document.documentElement.classList.add("safari-mobile");
      else document.documentElement.classList.add("non-safari-mobile");
    }

    export let spaceHeld = false;
    window.addEventListener("keydown", e => {
      if (e.code === "Space" && !["input","textarea","button"].includes(document.activeElement.tagName.toLowerCase())) {
        e.preventDefault();
        spaceHeld = true;
      }
    });
    window.addEventListener("keyup", e => {
      if (e.code === "Space") spaceHeld = false;
    });

    let cursorTimeout;
    function showCursor() { document.body.style.cursor = ""; }
    function hideCursor() { document.body.style.cursor = "none"; }
    document.addEventListener("fullscreenchange", () => {
      if (document.fullscreenElement) {
        showCursor();
        clearTimeout(cursorTimeout);
        cursorTimeout = setTimeout(hideCursor, 3000);
      } else {
        showCursor();
        clearTimeout(cursorTimeout);
      }
    });
    document.addEventListener("mousemove", () => {
      if (document.fullscreenElement) {
        showCursor();
        clearTimeout(cursorTimeout);
        cursorTimeout = setTimeout(hideCursor, 3000);
      }
    });

    export function hideBrowserUI() {
      if (!window.matchMedia('(display-mode: standalone)').matches && !IS_SAFARI_MOBILE) {
        setTimeout(() => {
          const htmlScrollable = document.documentElement.scrollHeight > document.documentElement.clientHeight;
          if (htmlScrollable) document.documentElement.scrollTop = 1;
          else window.scrollTo(0,1);
        }, 300);
      }
    }
    export function enterNativeFullScreen(el) {
      if (document.fullscreenElement || document.webkitFullscreenElement) return Promise.resolve();
      const r = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
      if (r) return r.call(el).catch(err => console.error("Native Fullscreen request failed:", err));
      else return Promise.reject("Native Fullscreen not supported");
    }
    export function exitNativeFullScreen() {
      if (!document.fullscreenElement && !document.webkitFullscreenElement) return Promise.resolve();
      const e = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
      if (e) return e.call(document).catch(err => console.error("Exit Native Fullscreen failed:", err));
      else return Promise.reject("Exit Native Fullscreen not supported");
    }

