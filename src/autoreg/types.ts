export type JobStep =
  | "created"
  | "captcha"
  | "signup"
  | "email_wait"
  | "finish_signup"
  | "platform_login"
  | "api_key"
  | "zcode_oauth"
  | "zcode_captcha"
  | "done"
  | "cancelled"
  | "error";

export type LogLevel = "debug" | "info" | "warn" | "error" | "success";

export interface JobLog {
  ts: string;
  level: LogLevel;
  step: string;
  message: string;
  data?: unknown;
}

export interface AutoregJob {
  id: string;
  email: string;
  username: string;
  /** Z.AI account password */
  password: string;
  /** Firstmail / mailbox password (IMAP) */
  mail_password: string | null;
  proxy: string | null;
  step: JobStep;
  logs: JobLog[];
  chat_token: string | null;
  platform_token: string | null;
  org_id: string | null;
  project_id: string | null;
  api_key: string | null;
  autoreg_account_id: string | null;
  /** ZCode Start Plan JWT (eyJ...) */
  zcode_jwt: string | null;
  zcode_oauth_access_token: string | null;
  zcode_user_id: string | null;
  zcode_session_id: string | null;
  zcode_oauth_flow_id: string | null;
  zcode_oauth_poll_token: string | null;
  zcode_authorize_url: string | null;
  zcode_captcha_param: string | null;
  zcode_captcha_expires_at: string | null;
  /** Captcha solved — accept verify emails only after this moment */
  captcha_solved_at: string | null;
  /** When signup API returned success */
  signup_at: string | null;
  /** Last verification email we already tried (do not retry) */
  last_verify_mail_at: string | null;
  last_verify_token: string | null;
  pending_verify_token: string | null;
  pending_verify_mail_at: string | null;
  pending_verify_username: string | null;
  /** true = signup через job.proxy (весь autorег идёт через одно прокси) */
  signup_via_proxy: boolean;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export const ZAI_OAUTH_CLIENT_ID = "client_lS94_Ka2ycE9IwCNYisudg";
export const ZAI_OAUTH_REDIRECT =
  "https://z.ai/login/callback?redirect=%2Fmanage-apikey%2Fapikey-list";
/** Signup captcha on chat.z.ai */
export const CAPTCHA_SCENE_ID = "36qgs6xb";
export const CAPTCHA_PREFIX = "no8xfe";
export const CAPTCHA_REGION = "sgp";

export const DEFAULT_AVATAR =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAFP0lEQVR4AeyaX4hUVRzHv/fOnT+6q7aWlFYqJpnSH5KFQgpBg0gjqId6CKL/sQ9WFFEPvbU99FJpLxH+KaioROjBWgiKil0isEiR1NyyLSsN/LO6uzNz585cz9lZ73jFPbvcOfee3737Gzx3zrlnz+/85vPhzMw5o31263yfCx0GNvhBigALIaUDYCEshBgBYunwCmEhxAgQS4dXCAshRoBYOrxCZoQQYi8yTenwCiFmi4WwEGIEiKXDK4SFECNALB1eISyEGAFi6fAKYSHECBBLJ00rhBi6eNJhIfFwjRyVhURGF89AFhIP18hRWUhkdPEMZCHxcI0clYVERhfPQBYSD9fIUVlIZHTxDGQh8XCNHJWFREYXz0AWEg/XyFHJCinesRmdT5yIVh7/H52PDKHjwZ9QWv8BnCUbIwNKeiBZIW2BsHJAvhPWnKVwlt4rpGzHrLs/hTV7UVthkxhsJzGJ8TksB7lr1qO09h1IUcbzUSRgK/pIddWP/4jKdz1TlurAi/AOf4zG6UOAX7/gNVjILbwTxdtfB+VHaoSgXoE3+NmUpXbwfVS+34SxXWtQ7X8B/th/Lf7ircxZtBb2gu7WPWK19AiJAK7224dw924BvNFgtDX7SjjX3hW0qVUyLUTCrv36HhrDg7LaLHYB9rzlzTrBa+aFSOaN4T/kU1Cs0vygTq0yI4QYgB55yhkhxJ63LATIr5wMtSk1Mi8kv+rp8GeG+LbWOLmfkoNQLpkW4iy+B4WbNwFOR/Ci/dF/4A31BW1qFZtaQu3mIzd/+Rt7MGvD5yit2wqr44LjErE6ar/vQkNuGtudKKbxqRGSExu66Rw2ShHF23rHd+XIlVrYGi5qgzvh/vxG6x7BWmqERGfnwz9zBNWBl1Dtfz56mIRGZlNIvQp/9F94f+5G5dtnMLqzG3LXnhDTtqZJjZDJDhfdPa+hfmwA8qwrIGE78MvHIXfpnvjMCO6noJIaIRL4pQ4X3b1vo/zFfah88yT8kaNN5OIQ0b7iVvGhvg3O9Q8376Xkmh4hUwD1/upDZUCc7oq3qvN/apUWoLj6Fcivv+fvUX9WCqGe/MX51Y9+LU533wTcM0GX/Npb6H4V9mUrgnuUK5kSIkHXDuyAN/Rl6Mcpu2uF+GGqV3aTL5kTIom7+7agceqgrE4UC7mr1qCw+mVQf2RSiNyJ1w5sB9zhFn+xScwvf4j0r4Uy2UwKkS9M/pTr/f2VeOtqyOZ4seYsRuGmnvE61UtmhUjg7i9vwT97RFYnigXn6nXIr3xsok3vKdNCxt+6Dn0kNo3lFvnCXORveBTW3Ota9wjVMi1Ecnb3bRY7+R9E1Rel+c/uWonCLc82G8SumRciebv734U/dkxWm0Xs5PNLNsJZdn+zTeg6I4TIDWPt8CeAOIIP2Be7kF/1FKj9T0Y7SDCxyvQmqvY/h5Ftlwel3PfA9AZO8lfunl6M7FgYxJOxy7s3ALWRSUaYuU1WiBkc5mdlIeYdhDJgISEc5hssxLyDUAYsJITDfIOFmHcQyoCFhHCYb7AQ8w5CGbCQEA7zjcwIMY9STwYsRA9HbVFYiDaUegKxED0ctUVhIdpQ6gnEQvRw1BaFhWhDqScQC9HDUVsUFqINpZ5ALEQPR21RWIgSZfKdLCR55soZWYgST/KdLCR55soZWYgST/KdLCR55soZWYgST/KdLCR55soZWYgST/KdLCR55soZWYgSTzydqqgsREXHQB8LMQBdNSULUdEx0MdCDEBXTclCVHQM9LEQA9BVU7IQFR0DfSzEAHTVlOcAAAD//xUArFEAAAAGSURBVAMAAvxbZyosWTUAAAAASUVORK5CYII=";
