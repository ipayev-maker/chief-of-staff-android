import {serveProtected} from '../_shared/legacy-auth.ts';
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.118.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TELEGRAM_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;

function tgApi(method: string, body: any) {
  return fetch("https://api.telegram.org/bot" + TELEGRAM_TOKEN + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function fmt(iso: string) {
  if (!iso) return "";
  const p = String(iso).split("-");
  const months = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
  return parseInt(p[2]) + " " + months[parseInt(p[1]) - 1];
}

serveProtected(async (req) => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  const { data: users } = await supabase
    .from("contacts")
    .select("telegram_user_id")
    .not("telegram_user_id", "is", null);

  for (const user of users || []) {
    const userId = user.telegram_user_id;
    if (!userId) continue;

    const { data: digest } = await supabase.rpc("get_morning_digest", {
      p_telegram_user_id: userId,
    });
    if (!digest) continue;

    const today = digest.today_commitments || [];
    const overdue = digest.overdue_commitments || [];
    if (today.length === 0 && overdue.length === 0) continue;

    let msg = "☀️ Доброе утро!\n\n";
    if (today.length > 0) {
      msg += "🎯 Сегодня:\n";
      for (const c of today) {
        msg += "▫️ " + c.description + " (" + (c.direction === "from_me" ? "я должен" : "мне должны") + ")\n";
      }
      msg += "\n";
    }
    if (overdue.length > 0) {
      msg += "⚠️ Просрочено:\n";
      for (const c of overdue) {
        msg += "▫️ " + c.description + " (дедлайн " + fmt(c.deadline) + ")\n";
      }
    }

    await tgApi("sendMessage", { chat_id: userId, text: msg });
  }

  return new Response("ok");
});
