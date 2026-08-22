// ==UserScript==
// @name             收看SMGTV电视节目
// @namespace        http://tampermonkey.net/
// @version          0.10
// @description      打开网页即可收看SMGTV，并解除试看倒计时与切页暂停等限制
// @author           https://github.com/Popukok
// @match            *://*.kankanews.com/huikan*
// @icon             https://live.kankanews.com/favicon.ico
// @updateURL        https://raw.githubusercontent.com/1fangfang/smg_live/refs/heads/main/smg_fivestar.user.js
// @downloadURL      https://raw.githubusercontent.com/1fangfang/smg_live/refs/heads/main/smg_fivestar.user.js
// @grant            none
// @run-at           document-start
// ==/UserScript==


(function() {
    'use strict';
    const STYLE_ID = 'smgtv-unlock-style';
    const VIDEO_READY_CLASS = 'smgtv-video-ready';
    const FULLSCREEN_FALLBACK_CLASS = 'smgtv-fallback-fullscreen';
    const FULLSCREEN_TARGET_CLASS = 'smgtv-fallback-fullscreen-target';
    const FULLSCREEN_BUTTON_SELECTOR = '.xgplayer-fullscreen';
    const VIDEO_READY_EVENTS = ['loadeddata', 'canplay', 'playing', 'timeupdate', 'progress'];
    const VIDEO_RESET_EVENTS = ['loadstart', 'waiting', 'stalled', 'emptied'];
    const watchedVideos = new WeakSet();
    const streamAddressCache = Object.create(null);
    let fullscreenFallbackTarget = null;
    let cssFullscreenFallbackPlayer = null;
    let lastFullscreenActionAt = 0;
    function rememberStreamAddresses(channelId, liveAddress, shiftAddress) {
        if (channelId == null || channelId === '') {
            return;
        }
        const key = String(channelId);
        const prev = streamAddressCache[key] || { live_address: '', shift_address: '' };
        streamAddressCache[key] = {
            live_address: liveAddress || prev.live_address || '',
            shift_address: shiftAddress || prev.shift_address || ''
        };
    }
    function fillStreamAddresses(target, channelId) {
        if (!target) {
            return false;
        }
        const cached = streamAddressCache[String(channelId)] || {};
        let changed = false;
        if (!target.live_address && cached.live_address) {
            target.live_address = cached.live_address;
            changed = true;
        }
        if (!target.shift_address && cached.shift_address) {
            target.shift_address = cached.shift_address;
            changed = true;
        }
        rememberStreamAddresses(channelId, target.live_address, target.shift_address);
        return changed;
    }
    function getResultChannelId(result) {
        return result?.channel_id || result?.channel_info?.id || result?.id;
    }
    function unlockProgramFlags(target) {
        if (!target) {
            return;
        }
        target.is_shield = 0;
        target.is_review = 1;
        target.can_review = 1;
    }
    function ensurePlayableStream(component) {
        if (!component) {
            return;
        }
        unlockProgramFlags(component.programObj);
        const channelDetail = component.currChannelDetail;
        if (channelDetail) {
            rememberStreamAddresses(channelDetail.id, channelDetail.live_address, channelDetail.shift_address);
        }
        const detail = component.programDetail;
        if (!detail) {
            return;
        }
        unlockProgramFlags(detail);
        if (detail.is_exist_pad && !(detail.pad_video_info && detail.pad_video_info.play_url)) {
            detail.is_exist_pad = 0;
            detail.pad_src = '';
        }
        if (!detail.channel_info) {
            detail.channel_info = {};
        }
        const channelId = getResultChannelId(detail) || channelDetail?.id;
        if (channelDetail) {
            if (!detail.channel_info.live_address && channelDetail.live_address) {
                detail.channel_info.live_address = channelDetail.live_address;
            }
            if (!detail.channel_info.shift_address && channelDetail.shift_address) {
                detail.channel_info.shift_address = channelDetail.shift_address;
            }
        }
        if (fillStreamAddresses(detail.channel_info, channelId)) {
            console.log('[SMGTV] 已回填频道直播地址');
        }
    }
    const STREAM_RSA_MODULUS = 'CFE61CCF516E5115E136C414F5111077847648568B67FEA6AD5A181CD5E6687F4F6A2A312514DE8D99AE3AD590301A95F869ECCA3FC01D8785898F8BB63B9E310970EDC33291A993B6A0D664B8D985D956BC90B82211000073161CF0981337EB9040DA6C7A9E27FE8D6C02B4C9A28648175EC4B52A928170DC27BC838F9ADCEF';
    const STREAM_RSA_EXPONENT = 65537n;
    function base64ToBytes(b64) {
        const binary = window.atob(b64);
        const out = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            out[i] = binary.charCodeAt(i);
        }
        return out;
    }
    function bytesToBigInt(bytes) {
        let hex = '';
        for (let i = 0; i < bytes.length; i++) {
            hex += bytes[i].toString(16).padStart(2, '0');
        }
        return BigInt('0x' + (hex || '0'));
    }
    function bigIntToBytes(value, length) {
        let hex = value.toString(16);
        if (hex.length % 2) {
            hex = '0' + hex;
        }
        const raw = [];
        for (let i = 0; i < hex.length; i += 2) {
            raw.push(parseInt(hex.slice(i, i + 2), 16));
        }
        const out = new Uint8Array(length);
        out.set(raw, Math.max(0, length - raw.length));
        return out;
    }
    function modPow(base, exp, mod) {
        let result = 1n;
        let current = base % mod;
        let exponent = exp;
        while (exponent > 0n) {
            if (exponent & 1n) {
                result = (result * current) % mod;
            }
            current = (current * current) % mod;
            exponent >>= 1n;
        }
        return result;
    }
    function pkcs1Unpad(block) {
        let offset = 0;
        if (block[0] === 0x00) {
            offset = 1;
        }
        if (block[offset] !== 0x01 && block[offset] !== 0x02) {
            return null;
        }
        const sep = block.indexOf(0x00, offset + 1);
        if (sep < 0) {
            return null;
        }
        return block.slice(sep + 1);
    }
    function decryptStreamAddress(encrypted) {
        if (!encrypted || typeof encrypted !== 'string') {
            return '';
        }
        if (/^https?:\/\//i.test(encrypted)) {
            return encrypted;
        }
        try {
            const raw = base64ToBytes(encrypted);
            const modulus = BigInt('0x' + STREAM_RSA_MODULUS);
            const keySize = STREAM_RSA_MODULUS.length / 2;
            let plain = '';
            for (let i = 0; i < raw.length; i += keySize) {
                const chunk = raw.subarray(i, i + keySize);
                const decrypted = modPow(bytesToBigInt(chunk), STREAM_RSA_EXPONENT, modulus);
                const block = bigIntToBytes(decrypted, keySize);
                const data = pkcs1Unpad(block);
                if (data && data.length) {
                    plain += String.fromCharCode.apply(String, data);
                }
            }
            return plain;
        } catch (e) {
            return '';
        }
    }
    function getProgramUnixRange(component) {
        const range = { start: 0, end: 0 };
        const program = component && component.programObj;
        const detail = component && component.programDetail;
        if (program && typeof program.start_time === 'number') {
            range.start = program.start_time;
        } else if (detail && typeof detail.start === 'number') {
            range.start = detail.start;
        }
        if (program && typeof program.end_time === 'number') {
            range.end = program.end_time;
        } else if (detail && typeof detail.end === 'number') {
            range.end = detail.end;
        }
        return range;
    }
    function appendTimeshiftParams(liveUrl, start, end) {
        if (!liveUrl) {
            return '';
        }
        if (!start || !end || /[?&]start=/.test(liveUrl)) {
            return liveUrl;
        }
        const joiner = liveUrl.indexOf('?') >= 0 ? '&' : '?';
        return liveUrl + joiner + 'start=' + start + '&end=' + end;
    }
    function resolvePlayUrl(component) {
        ensurePlayableStream(component);
        const channelInfo = component && component.programDetail && component.programDetail.channel_info || {};
        const channelDetail = component && component.currChannelDetail || {};
        const liveEncrypted = channelInfo.live_address || channelDetail.live_address || '';
        const shiftEncrypted = channelInfo.shift_address || channelDetail.shift_address || '';
        const isLive = !!(component && component.programObj && component.programObj.play === 1);
        if (isLive) {
            return decryptStreamAddress(liveEncrypted);
        }
        const officialShift = decryptStreamAddress(shiftEncrypted);
        if (officialShift) {
            return officialShift;
        }
        const liveUrl = decryptStreamAddress(liveEncrypted);
        const range = getProgramUnixRange(component);
        const replayUrl = appendTimeshiftParams(liveUrl, range.start, range.end);
        if (replayUrl && replayUrl !== liveUrl) {
            console.log('[SMGTV] 已根据节目时段补全回看地址');
        }
        return replayUrl;
    }
    function wrapXgplayerCtor(component) {
        if (!component || typeof component.$xgplayer !== 'function' || component.$xgplayer.__smgWrapped) {
            return;
        }
        const Original = component.$xgplayer;
        const Wrapped = function(config) {
            const nextConfig = {};
            if (config) {
                Object.keys(config).forEach(function(key) {
                    nextConfig[key] = config[key];
                });
            }
            if (!nextConfig.url) {
                const url = resolvePlayUrl(component);
                if (url) {
                    nextConfig.url = url;
                    console.log('[SMGTV] 已补全播放地址');
                }
            }
            return new Original(nextConfig);
        };
        Wrapped.__smgWrapped = true;
        Wrapped.prototype = Original.prototype;
        try {
            Object.setPrototypeOf(Wrapped, Original);
        } catch (e) {}
        component.$xgplayer = Wrapped;
    }
    function applyResolvedPlayUrl(component) {
        const url = resolvePlayUrl(component);
        const player = component && component.player;
        if (!url || !player) {
            return false;
        }
        try {
            if (player.config) {
                player.config.url = url;
                player.config.isLive = !!(component.programObj && component.programObj.play === 1);
            }
            if (typeof player.switchURL === 'function') {
                player.switchURL(url);
            } else {
                player.src = url;
            }
            if (typeof player.play === 'function') {
                player.play();
            }
            console.log('[SMGTV] 已切换到回看/直播地址');
            return true;
        } catch (e) {
            console.warn('[SMGTV] 切换播放地址失败', e);
            return false;
        }
    }
    function recoverPlayerIfNeeded(component) {
        if (!component || component.__smgRecovering) {
            return;
        }
        const video = getPlayerVideo(component);
        const mediaError = video && video.error;
        if (!(component.player && mediaError && mediaError.code === 4)) {
            return;
        }
        const url = resolvePlayUrl(component);
        if (!url) {
            return;
        }
        component.__smgRecovering = true;
        console.log('[SMGTV] 检测到无效播放地址，正在重新初始化播放器');
        wrapXgplayerCtor(component);
        if (!applyResolvedPlayUrl(component) && typeof component.initPlayer === 'function') {
            component.initPlayer({ changeCurrentList: false, isPlay: true, trigger: 'click' });
        }
        setTimeout(function() {
            component.__smgRecovering = false;
        }, 2000);
    }
    function injectStyle(cssText) {
        const appendStyle = () => {
            if (document.getElementById(STYLE_ID)) {
                return;
            }
            const style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = cssText;
            (document.head || document.documentElement).appendChild(style);
        };
        if (document.head || document.documentElement) {
            appendStyle();
        } else {
            document.addEventListener('DOMContentLoaded', appendStyle, { once: true });
        }
    }
    function getVueInstance(el) {
        return el?.__vue__ || el?.__vueParentComponent?.proxy || null;
    }
    function isTVComponent(instance) {
        return !!instance && (
            typeof instance.initPlayer === 'function' ||
            typeof instance.playProgram === 'function' ||
            typeof instance.setLiveTimer === 'function' ||
            ('isLoading' in instance && 'player' in instance)
        );
    }
    function findComponentFromElement(el) {
        let current = el;
        while (current) {
            const instance = getVueInstance(current);
            if (isTVComponent(instance)) {
                return instance;
            }
            current = current.parentElement;
        }
        return null;
    }
    function findTVComponent() {
        const selectors = ['.huikan', '.live-container', '.live-box', '.live-player', '.tv', '.player-box'];
        for (const selector of selectors) {
            const component = findComponentFromElement(document.querySelector(selector));
            if (component) {
                return component;
            }
        }
        return null;
    }
    function getPlayerVideo(component) {
        const player = component?.player;
        return player?.video ||
            player?.media ||
            player?.root?.querySelector?.('video') ||
            component?.$refs?.livePlayer?.querySelector?.('video') ||
            document.querySelector('.live-player video, .player-box video, .xgplayer video, video');
    }
    function isVideoReady(video) {
        return !!video && !video.error && (
            video.readyState >= 2 ||
            (!video.paused && video.currentTime > 0)
        );
    }
    function setVideoReadyClass(isReady) {
        const target = document.body || document.documentElement;
        target?.classList?.toggle(VIDEO_READY_CLASS, isReady);
    }
    function syncLoadingState(component) {
        recoverPlayerIfNeeded(component);
        const video = getPlayerVideo(component);
        if (video) {
            watchPlayerVideo(component, video);
        }
        const isReady = isVideoReady(video);
        setVideoReadyClass(isReady);
        if (isReady && component && component.isLoading) {
            component.isLoading = false;
            console.log('[SMGTV] 已同步播放器 loading 状态');
        }
        return isReady;
    }
    function watchPlayerVideo(component, video) {
        if (!video || watchedVideos.has(video)) {
            return;
        }
        watchedVideos.add(video);
        const markReady = () => syncLoadingState(component);
        const resetReady = () => {
            if (!isVideoReady(video)) {
                setVideoReadyClass(false);
            }
        };
        VIDEO_READY_EVENTS.forEach(eventName => {
            video.addEventListener(eventName, markReady, { passive: true });
        });
        VIDEO_RESET_EVENTS.forEach(eventName => {
            video.addEventListener(eventName, resetReady, { passive: true });
        });
        markReady();
    }
    function startLoadingMonitor(component) {
        if (!component || component.__smgLoadingMonitor) {
            return;
        }
        component.__smgLoadingMonitor = setInterval(() => syncLoadingState(component), 500);
        if (component.$refs?.livePlayer && !component.__smgLoadingObserver) {
            component.__smgLoadingObserver = new MutationObserver(() => syncLoadingState(component));
            component.__smgLoadingObserver.observe(component.$refs.livePlayer, {
                childList: true,
                subtree: true
            });
        }
    }
    function getBrowserFullscreenElement() {
        return document.fullscreenElement ||
            document.webkitFullscreenElement ||
            document.mozFullScreenElement ||
            document.msFullscreenElement ||
            null;
    }
    function requestElementFullscreen(el) {
        if (!el) {
            return Promise.reject(new Error('missing fullscreen target'));
        }
        const request =
            el.requestFullscreen ||
            el.webkitRequestFullscreen ||
            el.webkitRequestFullScreen ||
            el.mozRequestFullScreen ||
            el.msRequestFullscreen;
        if (!request) {
            return Promise.reject(new Error('fullscreen api unavailable'));
        }
        try {
            const result = request.call(el);
            return result && typeof result.then === 'function' ? result : Promise.resolve();
        } catch (e) {
            return Promise.reject(e);
        }
    }
    function exitBrowserFullscreen() {
        const exit =
            document.exitFullscreen ||
            document.webkitExitFullscreen ||
            document.webkitCancelFullScreen ||
            document.mozCancelFullScreen ||
            document.msExitFullscreen;
        if (!exit) {
            return Promise.resolve();
        }
        try {
            const result = exit.call(document);
            return result && typeof result.then === 'function' ? result : Promise.resolve();
        } catch (e) {
            return Promise.reject(e);
        }
    }
    function getFullscreenTarget(component, button) {
        return component?.player?.root ||
            button?.closest?.('.xgplayer') ||
            component?.$refs?.livePlayer?.querySelector?.('.xgplayer') ||
            component?.$refs?.livePlayer ||
            document.querySelector('.live-player .xgplayer, .player-box .xgplayer, .xgplayer, .live-player, .player-box');
    }
    function syncFullscreenButtonState(component, isFullscreen) {
        const player = component?.player;
        if (player) {
            player.fullscreen = !!isFullscreen;
        }
        document.querySelectorAll(FULLSCREEN_BUTTON_SELECTOR).forEach(button => {
            button.setAttribute('data-state', isFullscreen ? 'full' : 'normal');
        });
    }
    function enterFallbackFullscreen(target, component) {
        if (!target) {
            return;
        }
        const player = component?.player;
        if (player && typeof player.getCssFullscreen === 'function') {
            try {
                player.getCssFullscreen(target);
                cssFullscreenFallbackPlayer = player;
                syncFullscreenButtonState(component, true);
                console.log('[SMGTV] 已启用 xgplayer CSS 全屏兜底');
                return;
            } catch (e) {
                console.warn('[SMGTV] xgplayer CSS 全屏失败，使用样式兜底', e);
            }
        }
        exitFallbackFullscreen(component);
        fullscreenFallbackTarget = target;
        target.classList.add(FULLSCREEN_TARGET_CLASS);
        document.body?.classList.add(FULLSCREEN_FALLBACK_CLASS);
        syncFullscreenButtonState(component, true);
        console.log('[SMGTV] 已启用 CSS 全屏兜底');
    }
    function exitFallbackFullscreen(component) {
        const player = component?.player || cssFullscreenFallbackPlayer;
        if (cssFullscreenFallbackPlayer && player && typeof player.exitCssFullscreen === 'function') {
            try {
                player.exitCssFullscreen();
            } catch (e) {
                console.warn('[SMGTV] 退出 xgplayer CSS 全屏失败', e);
            }
        }
        cssFullscreenFallbackPlayer = null;
        if (fullscreenFallbackTarget) {
            fullscreenFallbackTarget.classList.remove(FULLSCREEN_TARGET_CLASS);
            fullscreenFallbackTarget = null;
        }
        document.body?.classList.remove(FULLSCREEN_FALLBACK_CLASS);
        syncFullscreenButtonState(component, false);
    }
    function isFallbackFullscreen() {
        return !!document.body?.classList.contains(FULLSCREEN_FALLBACK_CLASS) ||
            !!cssFullscreenFallbackPlayer?.cssfullscreen ||
            !!cssFullscreenFallbackPlayer?.isCssfullScreen;
    }
    function callFullscreenMethod(fn) {
        try {
            const result = fn();
            return result && typeof result.then === 'function' ? result : Promise.resolve();
        } catch (e) {
            return Promise.reject(e);
        }
    }
    function enterFullscreen(component, target) {
        const player = component?.player;
        const enterNative = callFullscreenMethod(() => (
            player && typeof player.getFullscreen === 'function' ?
                player.getFullscreen(target) :
                requestElementFullscreen(target)
        ));
        Promise.resolve(enterNative)
            .then(() => syncFullscreenButtonState(component, true))
            .catch(() => enterFallbackFullscreen(target, component));
    }
    function exitFullscreen(component) {
        const player = component?.player;
        if (isFallbackFullscreen()) {
            exitFallbackFullscreen(component);
            return;
        }
        const exitNative = callFullscreenMethod(() => (
            player && typeof player.exitFullscreen === 'function' ?
                player.exitFullscreen() :
                exitBrowserFullscreen()
        ));
        Promise.resolve(exitNative)
            .catch(exitBrowserFullscreen)
            .then(
                () => syncFullscreenButtonState(component, false),
                () => syncFullscreenButtonState(component, false)
            );
    }
    function handleFullscreenControl(event) {
        const button = event.target?.closest?.(FULLSCREEN_BUTTON_SELECTOR);
        if (!button) {
            return;
        }
        const now = Date.now();
        if (now - lastFullscreenActionAt < 300) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            return;
        }
        lastFullscreenActionAt = now;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        const component = findTVComponent();
        const target = getFullscreenTarget(component, button);
        syncLoadingState(component);
        if (getBrowserFullscreenElement() || isFallbackFullscreen()) {
            exitFullscreen(component);
        } else {
            enterFullscreen(component, target);
        }
    }
    function handleFullscreenChange() {
        if (getBrowserFullscreenElement()) {
            exitFallbackFullscreen(findTVComponent());
            syncFullscreenButtonState(findTVComponent(), true);
        } else if (!isFallbackFullscreen()) {
            syncFullscreenButtonState(findTVComponent(), false);
        }
    }
    function initFullscreenPatch() {
        document.addEventListener('click', handleFullscreenControl, true);
        document.addEventListener('touchend', handleFullscreenControl, true);
        document.addEventListener('fullscreenchange', handleFullscreenChange);
        document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
        document.addEventListener('mozfullscreenchange', handleFullscreenChange);
        document.addEventListener('MSFullscreenChange', handleFullscreenChange);
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && isFallbackFullscreen()) {
                exitFallbackFullscreen(findTVComponent());
            }
        });
    }
    function wrapComponentMethod(component, methodName, after) {
        const original = component?.[methodName];
        if (typeof original !== 'function' || original.__smgWrapped) {
            return;
        }
        const wrapped = function() {
            const firstArg = arguments[0];
            if (firstArg && typeof firstArg === 'object' &&
                ('can_review' in firstArg || 'is_shield' in firstArg || 'is_review' in firstArg)) {
                unlockProgramFlags(firstArg);
            }
            wrapXgplayerCtor(this);
            ensurePlayableStream(this);
            const result = original.apply(this, arguments);
            const runAfter = () => {
                ensurePlayableStream(this);
                wrapXgplayerCtor(this);
                if (this.player && this.player.config && !this.player.config.url) {
                    applyResolvedPlayUrl(this);
                }
                setTimeout(() => after(this), 0);
                setTimeout(() => after(this), 250);
                setTimeout(() => after(this), 1000);
            };
            if (result && typeof result.then === 'function') {
                result.then(runAfter, runAfter);
            } else {
                runAfter();
            }
            return result;
        };
        wrapped.__smgWrapped = true;
        wrapped.__smgOriginal = original;
        component[methodName] = wrapped;
    }
    function patchComponent(component) {
        if (!component) {
            return;
        }
        startLoadingMonitor(component);
        if (component.__smgPatched) {
            syncLoadingState(component);
            return;
        }
        component.__smgPatched = true;
        if (typeof component.countdown === 'number') {
            component.countdown = 99999999;
        }
        component.showOpenApp = false;
        component.showFlag = false;
        component.startCountdown = function() {
            console.log('[SMGTV] 已拦截试看倒计时');
        };
        if (component.liveTimer) {
            clearTimeout(component.liveTimer);
            component.liveTimer = null;
        }
        if (!component.player && component.programObj?.id && typeof component.playProgram === 'function') {
            console.log('[SMGTV] 播放器已销毁，尝试重新加载节目');
            component.playProgram();
        }
        if (typeof component.pageVisibilityChange === 'function') {
            document.removeEventListener('visibilitychange', component.pageVisibilityChange);
            component.pageVisibilityChange = function() {
                console.log('[SMGTV] 已拦截切换标签页自动暂停');
            };
            document.addEventListener('visibilitychange', component.pageVisibilityChange);
        }
        if (component._handlerUnload) {
            window.removeEventListener('unload', component._handlerUnload);
            component._handlerUnload = null;
        }
        ['initPlayer', 'initNoProgramPlayer', 'initPadPlayer', 'changeProgram', 'changeChannel', 'getProgramDetail'].forEach(methodName => {
            wrapComponentMethod(component, methodName, syncLoadingState);
        });
        wrapXgplayerCtor(component);
        ensurePlayableStream(component);
        syncLoadingState(component);
        console.log('[SMGTV] 页面限制补丁已生效');
    }
    function initComponentPatch() {
        let attempts = 0;
        const maxAttempts = 50;
        const timer = setInterval(() => {
            const component = findTVComponent();
            if (component) {
                clearInterval(timer);
                patchComponent(component);
                return;
            }
            attempts += 1;
            if (attempts >= maxAttempts) {
                clearInterval(timer);
                console.warn('[SMGTV] 未找到播放器组件实例');
            }
        }, 200);
    }
    injectStyle(`
    .video-tip {
        display: none !important;
    }
    .program-box-container .program-list li.dateout {
        cursor: pointer !important;
    }
    body.${VIDEO_READY_CLASS} .loading-mask {
        display: none !important;
        pointer-events: none !important;
    }
    body.${FULLSCREEN_FALLBACK_CLASS} {
        overflow: hidden !important;
    }
    .${FULLSCREEN_TARGET_CLASS} {
        background: #000 !important;
        box-sizing: border-box !important;
        height: 100vh !important;
        inset: 0 !important;
        margin: 0 !important;
        max-height: none !important;
        max-width: none !important;
        min-height: 100vh !important;
        min-width: 100vw !important;
        padding: 0 !important;
        position: fixed !important;
        transform: none !important;
        width: 100vw !important;
        z-index: 2147483647 !important;
    }
    .${FULLSCREEN_TARGET_CLASS}.xgplayer,
    .${FULLSCREEN_TARGET_CLASS} .xgplayer {
        height: 100% !important;
        inset: 0 !important;
        margin: 0 !important;
        max-height: none !important;
        max-width: none !important;
        padding: 0 !important;
        padding-top: 0 !important;
        position: absolute !important;
        transform: none !important;
        width: 100% !important;
    }
    .${FULLSCREEN_TARGET_CLASS} .xgplayer-screen-container,
    .${FULLSCREEN_TARGET_CLASS} xg-video-container.xg-video-container,
    .${FULLSCREEN_TARGET_CLASS} .xg-video-container {
        bottom: 0 !important;
        display: block !important;
        height: 100% !important;
        inset: 0 !important;
        position: absolute !important;
        width: 100% !important;
    }
    .${FULLSCREEN_TARGET_CLASS} video,
    .${FULLSCREEN_TARGET_CLASS} canvas,
    .${FULLSCREEN_TARGET_CLASS} live-video {
        bottom: 0 !important;
        height: 100% !important;
        left: 0 !important;
        max-height: none !important;
        max-width: none !important;
        object-fit: contain !important;
        position: absolute !important;
        right: 0 !important;
        top: 0 !important;
        transform: none !important;
        width: 100% !important;
    }
    .${FULLSCREEN_TARGET_CLASS} .xgplayer-controls,
    .${FULLSCREEN_TARGET_CLASS} .xg-top-bar {
        z-index: 2147483647 !important;
    }
    `);
    
    // 保存原始的XMLHttpRequest.open方法
    const originalOpen = XMLHttpRequest.prototype.open;
    // 重写XMLHttpRequest.open方法
    function isTargetTVApi(url) {
        try {
            return new URL(String(url), location.href).pathname.includes('/content/pc/tv/');
        } catch (e) {
            return String(url).includes('/content/pc/tv/');
        }
    }
    function rewriteTvApiResponse(requestUrl, response) {
        let modified = false;
        if (!response || typeof response !== 'object') {
            return false;
        }
        if (requestUrl.includes('/channel/detail') && response.result) {
            rememberStreamAddresses(
                response.result.id,
                response.result.live_address,
                response.result.shift_address
            );
        }
        if (requestUrl.includes('/program/detail') && response.result) {
            unlockProgramFlags(response.result);
            if (response.result.channel_info) {
                unlockProgramFlags(response.result.channel_info);
            } else {
                response.result.channel_info = {};
            }
            const channelId = getResultChannelId(response.result);
            if (fillStreamAddresses(response.result.channel_info, channelId)) {
                console.log('[SMGTV] 已从频道详情回填节目直播地址');
            }
            modified = true;
        }
        if (requestUrl.includes('/programs') && response.result?.programs) {
            response.result.programs.forEach(program => {
                unlockProgramFlags(program);
                modified = true;
            });
        }
        return modified;
    }
    function replaceXhrResponse(xhr, body) {
        try {
            Object.defineProperty(xhr, 'responseText', {
                value: body,
                writable: false,
                configurable: true
            });
            Object.defineProperty(xhr, 'response', {
                value: body,
                writable: false,
                configurable: true
            });
        } catch (e) {
            console.error('[SMGTV] 重写接口响应失败:', e);
        }
    }
    XMLHttpRequest.prototype.open = function(method, url) {
        const requestUrl = String(url);
        // 检查是否是目标API请求
        if (isTargetTVApi(requestUrl)) {
            // 监听readystatechange事件
            this.addEventListener('readystatechange', function() {
                if (this.readyState === 4 && this.status === 200) {
                    try {
                        const raw = this.responseText;
                        const response = JSON.parse(raw);
                        if (rewriteTvApiResponse(requestUrl, response)) {
                            replaceXhrResponse(this, JSON.stringify(response));
                        }
                    } catch (e) {
                        console.error('解析JSON响应时出错:', e);
                    }
                }
            });
        }

        // 调用原始的open方法
        return originalOpen.apply(this, arguments);
    };
    const originalFetch = window.fetch;
    if (typeof originalFetch === 'function') {
        window.fetch = function(input, init) {
            const requestUrl = String(typeof input === 'string' ? input : (input && input.url) || '');
            const request = originalFetch.apply(this, arguments);
            if (!isTargetTVApi(requestUrl)) {
                return request;
            }
            return request.then(res => {
                if (!res || !res.ok) {
                    return res;
                }
                return res.clone().text().then(raw => {
                    try {
                        const response = JSON.parse(raw);
                        if (!rewriteTvApiResponse(requestUrl, response)) {
                            return res;
                        }
                        return new Response(JSON.stringify(response), {
                            status: res.status,
                            statusText: res.statusText,
                            headers: res.headers
                        });
                    } catch (e) {
                        console.error('解析JSON响应时出错:', e);
                        return res;
                    }
                });
            });
        };
    }
    if (document.readyState === 'complete') {
        initComponentPatch();
    } else {
        window.addEventListener('load', initComponentPatch, { once: true });
    }
    initFullscreenPatch();
})();
