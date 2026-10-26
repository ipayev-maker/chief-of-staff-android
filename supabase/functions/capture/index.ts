import {serveProtected} from '../_shared/legacy-auth.ts';
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.118.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_KEY = Deno.env.get("OPENROUTER_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function aiExtract(text: string): Promise<any> {
  const now = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const todayStr = now.toISOString().split("T")[0];
  const dayNames = ["воскресенье","понедельник","вторник","среда","четверг","пятница","суббота"];
  const dayName = dayNames[now.getDay()];

  const prompt = `You are an operational assistant. Today is ${todayStr}, ${dayName}. Timezone: Europe/Moscow.

Analyze the Russian message and extract structured data.

RULES:
- If the message contains a task, obligation, promise, reminder or payment — commitments MUST NOT be empty.
- direction: "to_me" (мне обещали), "from_me" (я должен), "internal".
- deadline: always null (dates are calculated by another module).
- project.title only if a project name is explicitly mentioned.
- who: the name of the OTHER person (not the message author, never "я"/"me") involved in
  this commitment — either the person who owes/promised this, or the person this must be
  done for/sent to/answered to. who must NEVER be "я" or any reference to the message author
  themself — if the commitment is purely the author's own personal task with no other named
  person involved, who is null. Examples:
    "Юрий обещал прислать чертежи" -> who: "Юрий" (он должен, не я)
    "ответить Максиму Осмачко" -> who: "Максим Осмачко" (ему нужно ответить, а не я сам)
    "оплатить аренду до пятницы" -> who: null (нет другого человека, это моя личная задача)
    "передать смету Клоду" -> who: "Клод" (ему передать, не я)
    "купить молоко" -> who: null
  Use the name exactly as written in the message (do not invent a surname, do not translate
  "я"/"мне"/"меня" into a name — those always mean who: null).

Message: "${text.split('"').join('\\"')}"

Return STRICT JSON only:
{
"project": {"title": "...", "description": "..."} or null,
"commitments": [{"description": "...", "who": "...", "deadline": null, "direction": "to_me|from_me|internal"}],
"events": [{"description": "...", "date": null}]
}`;

  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://supabase.com",
      "X-Title": "Chief of Staff",
    },
    body: JSON.stringify({
      model: "anthropic/claude-sonnet-4.6",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 2000,
    }),
  });

  const j = await r.json();
  const content = j.choices?.[0]?.message?.content || "{}";
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  try {
    return JSON.parse(content.slice(start, end + 1));
  } catch {
    return { project: null, commitments: [], events: [] };
  }
}

serveProtected(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const { text } = await req.json();

  if (!text || !text.trim()) {
    return new Response(JSON.stringify({ drafts: [] }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const extracted = await aiExtract(text);
  const commitments = Array.isArray(extracted.commitments) ? extracted.commitments : [];

  const parseRes = await fetch(`${SUPABASE_URL}/functions/v1/parse-dates`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const parsed = await parseRes.json();
  const deadline = parsed.dates?.[0]?.date || null;

  let projectSuggestions: any[] = [];
  if (extracted.project?.title) {
    const { data } = await supabase.rpc("suggest_projects", { p_query: extracted.project.title });
    projectSuggestions = data || [];
  }

  const drafts = [];
  for (const c of commitments) {
    let participantSuggestions: any[] = [];
    if (c.who) {
      const { data } = await supabase.rpc("suggest_participants", { p_query: c.who });
      participantSuggestions = data || [];
    }
    drafts.push({
      description: c.description,
      direction: c.direction || "to_me",
      deadline: deadline,
      suggested_project_title: extracted.project?.title || null,
      project_suggestions: projectSuggestions,
      suggested_participant_name: c.who || null,
      participant_suggestions: participantSuggestions,
    });
  }

  return new Response(JSON.stringify({ drafts }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
