/** Plain JS — imported into page.evaluate (must not be transpiled by tsx). */

export function mountCaptchaDom(html) {
  var old = document.getElementById("zai-captcha-mount");
  if (old) old.remove();
  var wrap = document.createElement("div");
  wrap.id = "zai-captcha-mount";
  wrap.innerHTML = html;
  document.body.prepend(wrap);
}

export function probeCaptchaDom() {
  function scanDoc(doc) {
    var imgs = [];
    doc.querySelectorAll("img").forEach(function (img) {
      if (img.offsetWidth > 20 || img.naturalWidth > 20) {
        imgs.push({
          w: img.offsetWidth || img.naturalWidth,
          h: img.offsetHeight || img.naturalHeight,
          src: (img.src || "").slice(0, 100),
        });
      }
    });
    var canvases = doc.querySelectorAll("canvas").length;
    var aliyun = doc.querySelectorAll("[class*='aliyun'],[class*='Aliyun']").length;
    return { imgs: imgs, canvases: canvases, aliyun: aliyun };
  }
  var root = scanDoc(document);
  var iframes = document.querySelectorAll("iframe").length;
  return { root: root, iframes: iframes };
}

export function ensureEsbuildHelpers() {
  if (typeof globalThis.__name === "undefined") {
    globalThis.__name = function (target) {
      return target;
    };
  }
}

export function getCaptchaState() {
  return window.__zaiCaptcha || null;
}

/** Rendered horizontal offset of the puzzle piece (CSS left, px). */
export function getPuzzleLeft() {
  var e = document.getElementById("aliyunCaptcha-puzzle");
  if (!e) return null;
  var v = parseFloat(e.style.left);
  return isNaN(v) ? 0 : v;
}

export function setCaptchaParam(param) {
  if (!window.__zaiCaptcha) {
    window.__zaiCaptcha = { param: null, error: null, ready: true };
  }
  window.__zaiCaptcha.param = String(param || "").trim();
}

export function initAliyunCaptchaWidget(cfg) {
  if (typeof globalThis.__name === "undefined") {
    globalThis.__name = function (target) {
      return target;
    };
  }
  window.__zaiCaptcha = { param: null, error: null, ready: false };
  window.initAliyunCaptcha({
    SceneId: cfg.sceneId,
    prefix: cfg.prefix,
    region: cfg.region,
    language: "en",
    mode: "embed",
    element: "#captcha-element",
    button: "#captcha-button",
    slideStyle: { width: 320, height: 40 },
    getInstance: function (instance) {
      window.__zaiCaptchaInstance = instance;
    },
    captchaVerifyCallback: async function (captchaVerifyParam) {
      var raw = captchaVerifyParam;
      var p =
        typeof raw === "string"
          ? raw
          : (raw && (raw.captchaVerifyParam || raw.captcha_verify_param)) || "";
      window.__zaiCaptcha.param = String(p || "").trim();
      return { captchaResult: Boolean(window.__zaiCaptcha.param) };
    },
    onError: function (e) {
      window.__zaiCaptcha.error = JSON.stringify(e);
    },
  });
  window.__zaiCaptcha.ready = true;
}

/** Signup from the same browser session as captcha (keeps IP + cookies). */
export async function browserChatSignup(payload) {
  var ctx = {
    pageUrl: location.href,
    pageOrigin: location.origin,
    cookieCount: document.cookie
      ? document.cookie.split(";").filter(function (s) {
          return s.trim();
        }).length
      : 0,
  };
  var param = payload && payload.captcha_verify_param;
  var paramInfo = {
    length: param ? String(param).length : 0,
    head: param ? String(param).slice(0, 32) : "",
    isJson: param ? String(param).trim().charAt(0) === "{" : false,
  };
  var r = await fetch("https://chat.z.ai/api/v1/auths/signup", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "x-region": "overseas",
    },
    body: JSON.stringify(payload),
  });
  var text = await r.text();
  return {
    status: r.status,
    ok: r.ok,
    body: text,
    ctx: ctx,
    paramInfo: paramInfo,
  };
}

export function getBrowserSignupContext() {
  return {
    pageUrl: location.href,
    pageOrigin: location.origin,
    cookieCount: document.cookie
      ? document.cookie.split(";").filter(function (s) {
          return s.trim();
        }).length
      : 0,
    captchaParamLen: window.__zaiCaptcha && window.__zaiCaptcha.param
      ? String(window.__zaiCaptcha.param).length
      : 0,
  };
}

/** finish_signup after visiting verify_email in the same browser context. */
export async function browserChatFinishSignup(payload) {
  var r = await fetch("https://chat.z.ai/api/v1/auths/finish_signup", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "x-region": "overseas",
      Referer: payload.verifyUrl,
    },
    body: JSON.stringify({
      username: payload.username,
      email: payload.email,
      password: payload.password,
      token: payload.token,
      profile_image_url: payload.profile_image_url,
      sso_redirect: null,
    }),
  });
  var text = await r.text();
  return { status: r.status, ok: r.ok, body: text };
}
