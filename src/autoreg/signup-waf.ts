import { DEFAULT_AVATAR } from "./types.js";
import { chatSignup } from "./zai-client.js";

/** Aliyun WAF HTML page — datacenter proxy IPs often get this on POST /signup. */
export function isSignupWafBlocked(status: number, body: string): boolean {
  if (status !== 405) return false;
  const sample = body.slice(0, 400).toLowerCase();
  return (
    sample.includes("data-spm") ||
    sample.includes("<title>405</title>") ||
    sample.includes("aliyuncs")
  );
}

/** POST /signup with fake captcha — 400 JSON means API reachable; 405 HTML means WAF block. */
export async function probeProxySignupAccess(
  proxy: string
): Promise<{ ok: boolean; status: number; message: string }> {
  const email = `probe-${Date.now()}@example.com`;
  const res = await chatSignup(
    {
      name: "probe",
      email,
      password: "ProbePass123!",
      captcha_verify_param: "probe",
      profile_image_url: DEFAULT_AVATAR,
    },
    proxy
  );

  if (isSignupWafBlocked(res.status, res.text)) {
    return {
      ok: false,
      status: 405,
      message:
        "WAF блокирует POST /api/v1/auths/signup с IP этого прокси — нужен residential или другой прокси",
    };
  }

  if (
    res.status === 400 &&
    res.text.toLowerCase().includes("captcha")
  ) {
    return {
      ok: true,
      status: 400,
      message: "Signup API доступен (ожидаемая ошибка капчи)",
    };
  }

  if (res.ok) {
    return { ok: true, status: res.status, message: "Signup API OK" };
  }

  return {
    ok: res.status > 0 && res.status < 500,
    status: res.status,
    message: res.text.slice(0, 120) || `HTTP ${res.status}`,
  };
}
