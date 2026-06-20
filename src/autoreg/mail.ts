import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { parseVerifyFromText } from "../autoreg.js";

const IMAP_HOST = process.env.FIRSTMAIL_IMAP_HOST || "imap.firstmail.ltd";
const IMAP_PORT = parseInt(process.env.FIRSTMAIL_IMAP_PORT || "993", 10);

/**
 * Email must arrive at least this long after signup_at / captcha.
 * Анти-релейс: по умолчанию ОТКЛЮЧЁН (0) — идемпотентность уже обеспечивается
 * skipToken + skipIfMessageBeforeOrEqual. Включить можно через env
 * FIRSTMAIL_MIN_MAIL_DELAY_MS (мс), если письмо дублируется.
 * Реальные письма иногда приходят быстрее 8с — жёсткий порог их отбрасывал.
 */
const MIN_MAIL_DELAY_MS = parseInt(
  process.env.FIRSTMAIL_MIN_MAIL_DELAY_MS || "0",
  10
);

/**
 * Строгая проверка даты письма (ts > signup_at).
 * По умолчанию ОТКЛЮЧЕНА (0) — IMAP-серверы почтовых провайдеров часто живут
 * в другом часовом поясе / с рассинхроном часов, из-за чего свежее письмо
 * датировано раньше signup и ложно отсекается. Вместо даты письмо отбирается
 * по содержимому (verify-токен) + skipToken для идемпотентности.
 * Включить: FIRSTMAIL_STRICT_TIME=1
 */
const STRICT_TIME = process.env.FIRSTMAIL_STRICT_TIME === "1"
  || process.env.FIRSTMAIL_STRICT_TIME === "true";

export interface MailPollResult {
  ok: boolean;
  message: string;
  verifyText?: string;
  subject?: string;
  from?: string;
  messageDate?: string;
  token?: string;
}

interface InboxMessage {
  source: Buffer;
  subject?: string;
  from?: string;
  date: Date;
  uid?: number;
}

export async function pollFirstmailForVerify(
  email: string,
  mailPassword: string,
  opts?: {
    maxAgeMinutes?: number;
    /** Only emails strictly after this (captcha solved) */
    notBefore?: Date;
    /** Skip messages at or before this date (already tried) */
    skipIfMessageBeforeOrEqual?: Date;
    skipToken?: string;
  }
): Promise<MailPollResult> {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: email, pass: mailPassword },
    logger: false,
    connectionTimeout: 20000,
  });

  try {
    await client.connect();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `IMAP connect failed: ${msg}` };
  }

  const notBefore = opts?.notBefore;
  const skipBefore = opts?.skipIfMessageBeforeOrEqual;
  const skipToken = opts?.skipToken?.trim();
  const emailNorm = email.trim().toLowerCase();

  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const since = notBefore
        ? new Date(notBefore.getTime() - 60_000)
        : new Date(Date.now() - (opts?.maxAgeMinutes ?? 30) * 60 * 1000);
      const messages: InboxMessage[] = [];

      for await (const msg of client.fetch(
        { since },
        { source: true, envelope: true, internalDate: true, uid: true }
      )) {
        const rawDate = msg.internalDate || msg.envelope?.date;
        const date =
          rawDate instanceof Date
            ? rawDate
            : rawDate
              ? new Date(rawDate)
              : new Date(0);
        messages.push({
          source: msg.source as Buffer,
          subject: msg.envelope?.subject,
          from: msg.envelope?.from?.[0]?.address,
          date,
          uid: msg.uid,
        });
      }

      messages.sort((a, b) => b.date.getTime() - a.date.getTime());

      let skippedOld = 0;
      let skippedTried = 0;
      let skippedEarly = 0;

      for (const m of messages) {
        const ts = m.date.getTime();

        // Строгая проверка даты — только если включена (рассинхрон часов
        // у почтовых провайдеров вызывает ложное отсечение свежих писем).
        if (STRICT_TIME && notBefore) {
          if (ts <= notBefore.getTime()) {
            skippedOld++;
            continue;
          }
          if (ts < notBefore.getTime() + MIN_MAIL_DELAY_MS) {
            skippedEarly++;
            continue;
          }
        }

        if (STRICT_TIME && skipBefore && ts <= skipBefore.getTime()) {
          skippedTried++;
          continue;
        }

        const parsed = await simpleParser(m.source);
        const body =
          (parsed.text || "") +
          "\n" +
          (typeof parsed.html === "string" ? parsed.html : "");

        const verify = parseVerifyFromText(body, emailNorm);
        if (!verify) continue;

        if (skipToken && verify.token === skipToken) {
          skippedTried++;
          continue;
        }

        return {
          ok: true,
          message: "Новое письмо верификации (после капчи)",
          verifyText: body,
          subject: m.subject,
          from: m.from,
          messageDate: m.date.toISOString(),
          token: verify.token,
        };
      }

      const after = notBefore?.toISOString() ?? "?";
      if (skippedEarly > 0 && skippedOld === 0 && skippedTried === 0) {
        return {
          ok: false,
          message: `Письмо ещё не пришло — подожди ${Math.ceil(MIN_MAIL_DELAY_MS / 1000)}+ сек после капчи (порог ${after})`,
        };
      }
      return {
        ok: false,
        message: `Нет нового verify после капчи (${after}). Старых/пробованных: ${skippedOld + skippedTried}, в ящике: ${messages.length}`,
      };
    } finally {
      lock.release();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `IMAP read failed: ${msg}` };
  } finally {
    try {
      await client.logout();
    } catch {
      /* ignore */
    }
  }
}
