/** Plain JS for page.evaluate — ZCode-style hidden Aliyun captcha (traceless). */

export function mountHiddenCaptchaDom() {
  const CONTAINER_ID = "zcode-gw-captcha-container";
  const ELEMENT_ID = "zcode-gw-captcha-element";
  const BUTTON_ID = "zcode-gw-captcha-button";

  const old = document.getElementById(CONTAINER_ID);
  if (old) old.remove();

  const wrap = document.createElement("div");
  wrap.id = CONTAINER_ID;
  wrap.setAttribute("aria-hidden", "true");
  wrap.style.cssText =
    "position:fixed;left:0;top:0;width:0;height:0;overflow:visible;z-index:2147483647;opacity:0;pointer-events:none;";

  const el = document.createElement("div");
  el.id = ELEMENT_ID;
  el.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;overflow:visible;";

  const btn = document.createElement("button");
  btn.id = BUTTON_ID;
  btn.type = "button";
  btn.tabIndex = -1;
  btn.setAttribute("aria-hidden", "true");
  btn.style.cssText =
    "position:fixed;left:50%;top:50%;width:1px;height:1px;opacity:0;border:0;padding:0;";

  wrap.appendChild(el);
  wrap.appendChild(btn);
  document.body.appendChild(wrap);
}

export function initTracelessWidget(cfg) {
  const ELEMENT_ID = "zcode-gw-captcha-element";
  const BUTTON_ID = "zcode-gw-captcha-button";

  if (typeof globalThis.__name === "undefined") {
    globalThis.__name = function (target) {
      return target;
    };
  }

  window.__zcodeGwCaptcha = {
    param: null,
    rawJson: null,
    error: null,
    ready: false,
    done: false,
  };
  window.__zcodeGwCaptchaInstance = null;

  window.AliyunCaptchaConfig = {
    region: cfg.region,
    prefix: cfg.prefix,
  };

  window.initAliyunCaptcha({
    SceneId: cfg.sceneId,
    prefix: cfg.prefix,
    region: cfg.region,
    language: cfg.language || "en",
    mode: cfg.mode || "popup",
    captchaLogoImg: cfg.captchaLogoImg,
    showErrorTip: false,
    element: "#" + ELEMENT_ID,
    button: "#" + BUTTON_ID,
    getInstance: function (instance) {
      window.__zcodeGwCaptchaInstance = instance;
    },
    success: function (param) {
      const p = String(param || "").trim();
      if (p) window.__zcodeGwCaptcha.param = p;
      window.__zcodeGwCaptcha.done = true;
    },
    fail: function (err) {
      window.__zcodeGwCaptcha.error = JSON.stringify(err);
      window.__zcodeGwCaptcha.done = true;
    },
    onError: function (err) {
      window.__zcodeGwCaptcha.error = JSON.stringify(err);
      window.__zcodeGwCaptcha.done = true;
    },
  });

  window.__zcodeGwCaptcha.ready = true;
}

export function runTracelessVerification() {
  const BUTTON_ID = "zcode-gw-captcha-button";
  const inst = window.__zcodeGwCaptchaInstance;
  if (!inst) return { ok: false, mode: "no_instance" };
  if (typeof inst.startTracelessVerification === "function") {
    inst.startTracelessVerification();
    return { ok: true, mode: "traceless" };
  }
  const btn = document.getElementById(BUTTON_ID);
  if (btn) btn.click();
  return { ok: true, mode: "button_click" };
}

export function readCaptchaState() {
  const s = window.__zcodeGwCaptcha;
  if (!s) return null;
  return {
    param: s.param,
    rawJson: s.rawJson,
    error: s.error,
    done: s.done,
    ready: s.ready,
  };
}
