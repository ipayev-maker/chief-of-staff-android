import {serveProtected} from '../_shared/legacy-auth.ts';
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.118.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TELEGRAM_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;

function fmt(iso: string | null | undefined) {
  if (!iso) return "";
  const p = String(iso).slice(0, 10).split("-");
  const months = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
  return `${parseInt(p[2])} ${months[parseInt(p[1]) - 1]}`;
}

function directionLabel(direction: string) {
  if (direction === "from_me") return "мне сделать";
  if (direction === "to_me") return "жду от другого";
  return "моя задача";
}

function projectSuffix(project: string | null | undefined) {
  return project ? ` · ${project}` : "";
}

function todayReason(c: any) {
  if (c.reason === "deadline") return "срок сегодня";
  if (c.reason === "planned") return "запланировано сегодня";
  if (c.reason === "check") return "проверить сегодня";
  return "сегодня";
}

function buildDigest(digest: any) {
  const today = digest?.today_commitments || [];
  const overdue = digest?.overdue_commitments || [];
  const noDeadline = digest?.no_deadline_commitments || [];
  if (!today.length && !overdue.length && !noDeadline.length) return "";

  let msg = `☀️ Доброе утро!\n${fmt(digest?.date)}\n\n`;

  if (today.length) {
    msg += "🎯 Сегодня:\n";
    for (const c of today) {
      msg += `▫️ ${c.description}${projectSuffix(c.project)}\n   ${directionLabel(c.direction)} · ${todayReason(c)}\n`;
    }
    msg += "\n";
  }

  if (overdue.length) {
    msg += "⚠️ Просрочено:\n";
    for (const c of overdue) {
      msg += `▫️ ${c.description}${projectSuffix(c.project)}\n   ${directionLabel(c.direction)} · срок ${fmt(c.deadline)}\n`;
    }
    msg += "\n";
  }

  if (noDeadline.length) {
    msg += "🗒 Без срока:\n";
    for (const c of noDeadline) {
      const extra = c.next_check_on ? ` · проверить ${fmt(c.next_check_on)}` : c.planned_on ? ` · план ${fmt(c.planned_on)}` : "";
      msg += `▫️ ${c.description}${projectSuffix(c.project)}\n   ${directionLabel(c.direction)}${extra}\n`;
    }
  }

  return msg.trim();
}

function splitTelegram(text: string, max = 3800) {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const addition = current ? `\n${line}` : line;
    if ((current + addition).length > max && current) {
      chunks.push(current);
      current = line;
    } else {
      current += addition;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function tgSend(chatId: number, text: string) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`telegram_${res.status}:${body.slice(0, 300)}`);
}

serveProtected(async (req) => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  let input: any = {};
  try { if (req.method === "POST") input = await req.json(); } catch { input = {}; }
  const dryRun = Boolean(input?.dry_run);

  const {data: ownerConfig, error: ownerError}=await supabase.rpc('cos_notes_get_config');
  if(ownerError||!/^\d+$/.test(ownerConfig?.telegramOwnerUserId||'')||ownerConfig.telegramOwnerChatId!==ownerConfig.telegramOwnerUserId)
    return new Response(JSON.stringify({ok:false,error:'owner_not_configured'}),{status:503,headers:{'Content-Type':'application/json'}});
  const users=[{telegram_user_id:ownerConfig.telegramOwnerUserId}];

  const results: any[] = [];
  for (const user of users || []) {
    const userId = Number(user.telegram_user_id);
    if (!userId) continue;

    const { data: digest, error } = await supabase.rpc("get_morning_digest", { p_telegram_user_id: userId });
    if (error) {
      results.push({ userId, ok:false, error:error.message });
      continue;
    }

    const text = buildDigest(digest);
    if (!text) {
      results.push({ userId, ok:true, empty:true, chunks:0 });
      continue;
    }

    const chunks = splitTelegram(text);
    if (dryRun) {
      results.push({ userId, ok:true, dry_run:true, chunks:chunks.length, text, digest });
      continue;
    }

    try {
      for (let i = 0; i < chunks.length; i++) {
        const prefix = chunks.length > 1 ? `[${i + 1}/${chunks.length}]\n` : "";
        await tgSend(userId, prefix + chunks[i]);
      }
      results.push({ userId, ok:true, chunks:chunks.length });
    } catch (e) {
      results.push({ userId, ok:false, error:String((e as any)?.message || e) });
    }
  }

  const ok = results.every(r => r.ok);
  return new Response(JSON.stringify({ ok, results }), {
    status: ok ? 200 : 502,
    headers: { "Content-Type":"application/json; charset=utf-8" },
  });
}, {allowCron:true});
