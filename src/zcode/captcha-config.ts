import {
  ZCODE_APP_VERSION,
  ZCODE_BASE_URL,
  ZCODE_CAPTCHA_PREFIX,
  ZCODE_CAPTCHA_REGION,
  ZCODE_CAPTCHA_SCENE_ID,
  ZCODE_PLATFORM,
} from "./constants.js";

export interface ZcodeCaptchaConfig {
  sceneId: string;
  prefix: string;
  region: string;
  enabled: boolean;
  scriptUrl: string;
}

let cached: { at: number; config: ZcodeCaptchaConfig } | null = null;

export async function fetchZcodeCaptchaConfig(): Promise<ZcodeCaptchaConfig> {
  if (cached && Date.now() - cached.at < 5 * 60_000) {
    return cached.config;
  }

  const url = `${ZCODE_BASE_URL}/api/v1/client/configs?app_version=${ZCODE_APP_VERSION}&platform=${ZCODE_PLATFORM}`;
  const res = await fetch(url);
  const text = await res.text();
  let parsed: {
    code?: number;
    data?: { configs?: { captcha?: Record<string, unknown> } };
  } = {};
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    /* use defaults */
  }

  const cap = parsed.data?.configs?.captcha;
  const config: ZcodeCaptchaConfig = {
    sceneId: String(cap?.sceneId || ZCODE_CAPTCHA_SCENE_ID),
    prefix: String(cap?.prefix || ZCODE_CAPTCHA_PREFIX),
    region: String(cap?.region || ZCODE_CAPTCHA_REGION),
    enabled: cap?.enabled !== false,
    scriptUrl:
      "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js",
  };

  cached = { at: Date.now(), config };
  return config;
}
